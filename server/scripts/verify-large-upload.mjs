import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import request from 'supertest'
import { Writable } from 'node:stream'
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mohen-large-upload-'))
process.env.NODE_ENV = 'test'
process.env.TZ = 'Asia/Shanghai'
process.env.DATA_DIR = temporaryDirectory
process.env.UPLOAD_DIR = path.join(temporaryDirectory, 'uploads')
process.env.JWT_SECRET = 'large-file-test-only'
const { app } = await import('../src/index.js')
const { db } = await import('../src/db.js')
const fixture = path.join(temporaryDirectory, 'one-gib.zip'),
  fileDescriptor = fs.openSync(fixture, 'w')
fs.ftruncateSync(fileDescriptor, 1024 ** 3)
fs.closeSync(fileDescriptor)
const started = Date.now()
try {
  const teacher = (
    await request(app).post('/api/auth/login').send({ username: 'teacher', password: '123456' })
  ).body.token
  const course = (
    await request(app)
      .post('/api/courses')
      .set('Authorization', 'Bearer ' + teacher)
      .send({ name: '大文件隔离测试' })
  ).body
  await request(app)
    .post('/api/courses/' + course.id + '/students')
    .set('Authorization', 'Bearer ' + teacher)
    .send({ username: 'large-test', name: '虚构学生' })
    .expect(201)
  const student = (
    await request(app).post('/api/auth/login').send({ username: 'large-test', password: '123456' })
  ).body.token
  const assignment = (
    await request(app)
      .post('/api/courses/' + course.id + '/assignments')
      .set('Authorization', 'Bearer ' + teacher)
      .send({ title: '1GiB作业', status: 'published', max_file_mb: 1024 })
  ).body
  const upload = await request(app)
    .post('/api/assignments/' + assignment.id + '/submit')
    .set('Authorization', 'Bearer ' + student)
    .set('Idempotency-Key', 'large-submit-once')
    .attach('file', fixture)
  assert.equal(upload.status, 201, upload.text)
  assert.equal(upload.body.file_size, 1024 ** 3)
  console.log('Student 1GiB upload and receipt: PASS')
  const material = await request(app)
    .post('/api/courses/' + course.id + '/materials')
    .set('Authorization', 'Bearer ' + teacher)
    .set('Idempotency-Key', 'large-material-once')
    .field('title', '1GiB资料')
    .attach('file', fixture)
  assert.equal(material.status, 201, material.text)
  assert.equal(material.body.file_size, 1024 ** 3)
  console.log('Teacher 1GiB upload: PASS')
  assert.equal(db.prepare('SELECT count(*) n FROM submission_receipts').get().n, 1)
  assert.equal(fs.readdirSync(path.join(process.env.UPLOAD_DIR, '.staging')).length, 0)
  const { pipeZipToResponse } = await import('../src/utils/zipStream.js')
  let zipBytes = 0,
    tail = Buffer.alloc(0)
  const sink = new Writable({
    write(chunk, _encoding, done) {
      zipBytes += chunk.length
      tail = Buffer.concat([tail, chunk]).subarray(-256)
      done()
    },
  })
  await pipeZipToResponse(
    Array.from({ length: 5 }, (_, index) => ({ name: 'group-' + index + '.zip', path: fixture })),
    sink,
  )
  assert.ok(zipBytes > 4 * 1024 ** 3)
  assert.ok(tail.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])), 'ZIP64 end record required')
  console.log('5GiB streaming ZIP64 package: PASS')
  console.log(
    JSON.stringify({
      zip_bytes: zipBytes,
      elapsed_seconds: (Date.now() - started) / 1000,
      peak_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024),
      successful_uploads: 2,
      bytes_each: 1024 ** 3,
    }),
  )
} finally {
  db.close()
  const resolvedTemporaryDirectory = path.resolve(temporaryDirectory)
  if (
    path.dirname(resolvedTemporaryDirectory) === path.resolve(os.tmpdir()) &&
    path.basename(resolvedTemporaryDirectory).startsWith('mohen-large-upload-')
  )
    fs.rmSync(resolvedTemporaryDirectory, { recursive: true, force: true })
}
