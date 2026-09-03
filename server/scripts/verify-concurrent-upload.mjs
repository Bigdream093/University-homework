import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import request from 'supertest'

const students = Number(process.env.LOAD_STUDENTS || 30)
const fileMb = Number(process.env.LOAD_FILE_MB || 500)
if (!Number.isSafeInteger(students) || students < 1 || students > 100)
  throw new Error('LOAD_STUDENTS must be an integer from 1 to 100')
if (!Number.isSafeInteger(fileMb) || fileMb < 1 || fileMb > 1024)
  throw new Error('LOAD_FILE_MB must be an integer from 1 to 1024')

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mohen-concurrent-upload-'))
process.env.NODE_ENV = 'test'
process.env.TZ = 'Asia/Shanghai'
process.env.JWT_SECRET = 'concurrent-upload-test-only'
process.env.DATA_DIR = temporaryDirectory
process.env.UPLOAD_DIR = path.join(temporaryDirectory, 'uploads')

let db
let progressTimer
try {
  const { app } = await import('../src/index.js')
  db = (await import('../src/db.js')).db
  const fixture = path.join(temporaryDirectory, `${fileMb}mb.zip`),
    fd = fs.openSync(fixture, 'w')
  fs.ftruncateSync(fd, fileMb * 1024 * 1024)
  fs.closeSync(fd)
  const bearer = (token) => `Bearer ${token}`
  const teacher = (
    await request(app).post('/api/auth/login').send({ username: 'teacher', password: '123456' })
  ).body.token
  const course = (
    await request(app)
      .post('/api/courses')
      .set('Authorization', bearer(teacher))
      .send({ name: 'Concurrent upload verification' })
  ).body
  const assignment = (
    await request(app)
      .post(`/api/courses/${course.id}/assignments`)
      .set('Authorization', bearer(teacher))
      .send({
        title: 'Concurrent upload verification',
        status: 'published',
        max_file_mb: fileMb,
        allow_resubmit_count: 0,
      })
  ).body
  const tokens = []
  for (let index = 0; index < students; index++) {
    const username = `load-${String(index).padStart(3, '0')}`
    const added = await request(app)
      .post(`/api/courses/${course.id}/students`)
      .set('Authorization', bearer(teacher))
      .send({ username, name: `Load student ${index}` })
    if (added.status !== 201)
      throw new Error(`Student setup ${index} failed: ${added.status} ${added.text}`)
    const login = await request(app).post('/api/auth/login').send({ username, password: '123456' })
    if (login.status !== 200) throw new Error(`Student login ${index} failed: ${login.status}`)
    tokens.push(login.body.token)
  }

  console.log(`START students=${students} file_mb=${fileMb} temp=${temporaryDirectory}`)
  const delay = monitorEventLoopDelay({ resolution: 10 })
  delay.enable()
  let peakRss = process.memoryUsage().rss,
    running = true
  const rssTimer = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
  }, 20)
  const healthLatencies = []
  const healthProbe = (async () => {
    while (running) {
      const started = performance.now()
      await request(app).get('/api/health')
      healthLatencies.push(performance.now() - started)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  })()
  progressTimer = setInterval(() => {
    const staging = path.join(process.env.UPLOAD_DIR, '.staging')
    const bytes = fs.existsSync(staging)
      ? fs
          .readdirSync(staging)
          .reduce((sum, name) => sum + fs.statSync(path.join(staging, name)).size, 0)
      : 0
    console.log(
      `PROGRESS staged_mib=${Math.round(bytes / 1024 / 1024)} rss_mb=${Math.round(process.memoryUsage().rss / 1024 / 1024)}`,
    )
  }, 10_000)

  const started = performance.now()
  const jobs = tokens.map((token, index) => {
    const requestStarted = performance.now()
    return request(app)
      .post(`/api/assignments/${assignment.id}/submit`)
      .set('Authorization', bearer(token))
      .set('Idempotency-Key', `load-submit-${index}`)
      .attach('file', fixture)
      .then((response) => ({
        status: response.status,
        ms: performance.now() - requestStarted,
        message: response.body?.message || '',
      }))
      .catch((error) => ({
        status: 0,
        ms: performance.now() - requestStarted,
        message: error.message,
      }))
  })
  const results = await Promise.all(jobs),
    elapsed = performance.now() - started
  running = false
  await healthProbe
  clearInterval(rssTimer)
  clearInterval(progressTimer)
  progressTimer = null
  delay.disable()
  const percentile = (values, percentileRank) => {
    const sorted = [...values].sort((leftValue, rightValue) => leftValue - rightValue)
    return (
      sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileRank) - 1)] || 0
    )
  }
  const statusCounts = {}
  for (const result of results) statusCounts[result.status] = (statusCounts[result.status] || 0) + 1
  const staging = path.join(process.env.UPLOAD_DIR, '.staging')
  console.log(
    JSON.stringify(
      {
        students,
        file_mb_each: fileMb,
        total_mb: students * fileMb,
        status_counts: statusCounts,
        elapsed_seconds: Number((elapsed / 1000).toFixed(2)),
        aggregate_mib_per_second: Number(((students * fileMb) / (elapsed / 1000)).toFixed(1)),
        submit_ms: {
          p50: Math.round(
            percentile(
              results.map((result) => result.ms),
              0.5,
            ),
          ),
          p95: Math.round(
            percentile(
              results.map((result) => result.ms),
              0.95,
            ),
          ),
          max: Math.round(
            percentile(
              results.map((result) => result.ms),
              1,
            ),
          ),
        },
        health_ms: {
          samples: healthLatencies.length,
          p95: Math.round(percentile(healthLatencies, 0.95)),
          max: Math.round(percentile(healthLatencies, 1)),
        },
        event_loop_ms: {
          p99: Number((delay.percentile(99) / 1e6).toFixed(1)),
          max: Number((delay.max / 1e6).toFixed(1)),
        },
        peak_rss_mb: Math.round(peakRss / 1024 / 1024),
        submissions: db
          .prepare('SELECT count(*) n FROM submissions WHERE assignment_id=?')
          .get(assignment.id).n,
        receipts: db
          .prepare('SELECT count(*) n FROM submission_receipts WHERE assignment_id=?')
          .get(assignment.id).n,
        staging_files: fs.existsSync(staging) ? fs.readdirSync(staging).length : 0,
        failures: results.filter((result) => result.status !== 201),
      },
      null,
      2,
    ),
  )
} finally {
  if (progressTimer) clearInterval(progressTimer)
  try {
    db?.close()
  } catch {}
  const resolvedTemporaryDirectory = path.resolve(temporaryDirectory),
    systemTemporaryRoot = path.resolve(os.tmpdir())
  if (
    path.dirname(resolvedTemporaryDirectory) === systemTemporaryRoot &&
    path.basename(resolvedTemporaryDirectory).startsWith('mohen-concurrent-upload-')
  )
    fs.rmSync(resolvedTemporaryDirectory, { recursive: true, force: true })
}
