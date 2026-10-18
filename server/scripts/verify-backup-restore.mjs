import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import request from 'supertest'

const restored = process.argv[2] === '--restored'
const root = restored
  ? path.resolve(process.argv[3])
  : fs.mkdtempSync(path.join(os.tmpdir(), 'mohen-restore-drill-'))
const original = restored ? root : path.join(root, 'original')
Object.assign(process.env, {
  NODE_ENV: 'test',
  TZ: 'Asia/Shanghai',
  JWT_SECRET: 'isolated-restore-test-only',
  DATA_DIR: original,
  UPLOAD_DIR: path.join(original, 'uploads'),
})
const { app } = await import('../src/index.js')
const { db } = await import('../src/db.js')
const hash = (value) => createHash('sha256').update(value).digest('hex')
async function call(token, method, endpoint, body, expected = 200) {
  const response = await request(app)
    [method]('/api' + endpoint)
    .set('Authorization', token ? `Bearer ${token}` : '')
    .send(body)
  assert.equal(response.status, expected, response.text)
  return response.body
}
try {
  const teacher = await call('', 'post', '/auth/login', { username: 'teacher', password: '123456' })
  if (restored) {
    const expected = JSON.parse(fs.readFileSync(path.join(root, 'expected.json'), 'utf8'))
    const summary = await call(teacher.token, 'get', `/courses/${expected.course}/summary`)
    const cell = summary.students.find((student) => student.username === 'restore-demo').cells[
      expected.assignment
    ]
    assert.equal(cell.score, 77)
    assert.equal(cell.comment, '恢复验收评语')
    const student = await call('', 'post', '/auth/login', {
      username: 'restore-demo',
      password: '123456',
    })
    const receipts = await call(student.token, 'get', expected.apiBase + '/receipts')
    assert.equal(receipts.length, 1)
    assert.equal(receipts[0].receipt_no, expected.receipt)
    const file = await request(app)
      .get('/api' + expected.apiBase + '/file')
      .set('Authorization', `Bearer ${student.token}`)
      .buffer(true)
      .parse((response, done) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => done(null, Buffer.concat(chunks)))
        response.on('error', done)
      })
    assert.equal(file.status, 200)
    assert.equal(hash(file.body), expected.sha256)
    assert.equal(db.pragma('foreign_key_check').length, 0)
    console.log(
      'RESTORE_RESULT=' +
        JSON.stringify({
          restored: true,
          file_sha256_matches: true,
          receipts: receipts.length,
          grade: cell.score,
          foreign_key_errors: 0,
        }),
    )
  } else {
    const course = await call(teacher.token, 'post', '/courses', { name: '隔离备份恢复验收' }, 201)
    await call(
      teacher.token,
      'post',
      `/courses/${course.id}/students`,
      { username: 'restore-demo', name: '恢复验收' },
      201,
    )
    const student = await call('', 'post', '/auth/login', {
      username: 'restore-demo',
      password: '123456',
    })
    const assignment = await call(
      teacher.token,
      'post',
      `/courses/${course.id}/assignments`,
      {
        title: '恢复验收作业',
        status: 'published',
        type: 'document',
        max_file_mb: 10,
      },
      201,
    )
    const bytes = Buffer.from('backup-and-restore-file-integrity')
    const submission = await request(app)
      .post(`/api/assignments/${assignment.id}/submit`)
      .set('Authorization', `Bearer ${student.token}`)
      .field('base_version', '0')
      .attach('file', bytes, 'restore.zip')
      .expect(201)
    const graded = await call(teacher.token, 'post', `/assignments/${assignment.id}/batch-grade`, {
      score: 77,
      comment: '恢复验收评语',
      items: [
        {
          id: submission.body.id,
          kind: 'individual',
          expected_status: 'submitted',
          expected_submit_count: 1,
        },
      ],
    })
    assert.equal(graded.success_count, 1)
    const snapshot = path.join(root, 'snapshot'),
      destination = path.join(root, 'restored')
    fs.mkdirSync(snapshot)
    await db.backup(path.join(snapshot, 'homework.sqlite'))
    fs.cpSync(path.join(original, 'uploads'), path.join(snapshot, 'uploads'), { recursive: true })
    fs.writeFileSync(
      path.join(snapshot, 'expected.json'),
      JSON.stringify({
        course: course.id,
        assignment: assignment.id,
        apiBase: submission.body.api_base,
        receipt: submission.body.receipt_no,
        sha256: hash(bytes),
      }),
    )
    fs.cpSync(snapshot, destination, { recursive: true })
    const check = spawnSync(process.execPath, [import.meta.filename, '--restored', destination], {
      encoding: 'utf8',
    })
    assert.equal(check.status, 0, check.stderr || check.stdout)
    const report = check.stdout.split('\n').find((line) => line.startsWith('RESTORE_RESULT='))
    assert.ok(report, '恢复检查未返回结果')
    console.log(
      JSON.stringify({ environment: 'isolated-local', ...JSON.parse(report.slice(15)) }, null, 2),
    )
  }
} finally {
  db.close()
  if (
    !restored &&
    path.dirname(root) === path.resolve(os.tmpdir()) &&
    path.basename(root).startsWith('mohen-restore-drill-')
  )
    fs.rmSync(root, { recursive: true, force: true })
}
