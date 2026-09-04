import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import request from 'supertest'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mohen-files-'))
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-secret'
process.env.DATA_DIR = dataDir
process.env.UPLOAD_DIR = path.join(dataDir, 'uploads')
fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true })

const { app } = await import('../src/index.js')
const { db } = await import('../src/db.js')

after(() => {
  db.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

function getBinary(url, token) {
  return request(app)
    .get(url)
    .set('Authorization', `Bearer ${token}`)
    .buffer(true)
    .parse((res, cb) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => cb(null, Buffer.concat(chunks)))
    })
}

test('submissions list exposes every append-mode file; first and latest versions are downloadable', async () => {
  const teacherLogin = await request(app)
    .post('/api/auth/login')
    .send({ username: 'teacher', password: '123456' })
  assert.equal(teacherLogin.status, 200)
  const teacherToken = teacherLogin.body.token

  const course = await request(app)
    .post('/api/courses')
    .set('Authorization', `Bearer ${teacherToken}`)
    .send({ name: '多文件测试', code: 'FILES' })
  assert.equal(course.status, 201)
  await request(app)
    .post(`/api/courses/${course.body.id}/students`)
    .set('Authorization', `Bearer ${teacherToken}`)
    .send({ username: '20260001', name: '演示学生' })
  const assignment = await request(app)
    .post(`/api/courses/${course.body.id}/assignments`)
    .set('Authorization', `Bearer ${teacherToken}`)
    .send({
      title: '多文件作业',
      type: 'document',
      total_score: 100,
      allow_resubmit_count: -1,
      submission_mode: 'append',
      status: 'published',
    })
  assert.equal(assignment.status, 201)
  const assignmentId = assignment.body.id

  const studentLogin = await request(app)
    .post('/api/auth/login')
    .send({ username: '20260001', password: '123456' })
  const studentToken = studentLogin.body.token

  const first = await request(app)
    .post(`/api/assignments/${assignmentId}/submit`)
    .set('Authorization', `Bearer ${studentToken}`)
    .attach('file', Buffer.from('first version'), {
      filename: '草稿一.zip',
      contentType: 'application/zip',
    })
  assert.equal(first.status, 201)
  const submissionId = first.body.id

  await new Promise((resolve) => setTimeout(resolve, 1100))
  await request(app)
    .post(`/api/assignments/${assignmentId}/submit`)
    .set('Authorization', `Bearer ${studentToken}`)
    .field('base_version', '1')
    .attach('file', Buffer.from('second version'), {
      filename: '补充二.zip',
      contentType: 'application/zip',
    })
  await new Promise((resolve) => setTimeout(resolve, 1100))
  await request(app)
    .post(`/api/assignments/${assignmentId}/submit`)
    .set('Authorization', `Bearer ${studentToken}`)
    .field('base_version', '2')
    .attach('file', Buffer.from('third version'), {
      filename: '补充三.zip',
      contentType: 'application/zip',
    })

  const list = await request(app)
    .get(`/api/assignments/${assignmentId}/submissions`)
    .set('Authorization', `Bearer ${teacherToken}`)
  assert.equal(list.status, 200)
  const row = list.body.find((r) => r.username === '20260001')
  assert.ok(row, '学生行存在')
  assert.equal(row.files.length, 3, '追加模式下文件列表应有 3 个')
  assert.ok(
    row.files.every((f) => f.history_id),
    '每个文件都有 history_id',
  )
  assert.ok(
    row.files.every((f) => f.file_name.includes('_准时.zip')),
    '文件名为规范命名',
  )

  const firstHistoryId = row.files[0].history_id
  const firstDownload = await getBinary(
    `/api/submissions/${submissionId}/file?history_id=${firstHistoryId}`,
    teacherToken,
  )
  assert.equal(firstDownload.status, 200)
  assert.equal(firstDownload.body.toString(), 'first version', '按 history_id 下载到第一个文件')

  const latestDownload = await getBinary(`/api/submissions/${submissionId}/file`, teacherToken)
  assert.equal(latestDownload.status, 200)
  assert.equal(latestDownload.body.toString(), 'third version', '不带 history_id 下载到最新文件')

  const invalidDownload = await getBinary(
    `/api/submissions/${submissionId}/file?history_id=999999`,
    teacherToken,
  )
  assert.equal(invalidDownload.status, 404, '无效 history_id 返回 404')
})

test('online-content submissions are listed in files and download as txt', async () => {
  const teacherLogin = await request(app)
    .post('/api/auth/login')
    .send({ username: 'teacher', password: '123456' })
  assert.equal(teacherLogin.status, 200)
  const teacherToken = teacherLogin.body.token

  const course = await request(app)
    .post('/api/courses')
    .set('Authorization', `Bearer ${teacherToken}`)
    .send({ name: '在线作答测试', code: 'ONLINE' })
  assert.equal(course.status, 201)
  await request(app)
    .post(`/api/courses/${course.body.id}/students`)
    .set('Authorization', `Bearer ${teacherToken}`)
    .send({ username: '20260001', name: '演示学生' })
  const assignment = await request(app)
    .post(`/api/courses/${course.body.id}/assignments`)
    .set('Authorization', `Bearer ${teacherToken}`)
    .send({
      title: '在线作业',
      type: 'online',
      total_score: 100,
      allow_resubmit_count: -1,
      submission_mode: 'append',
      status: 'published',
    })
  assert.equal(assignment.status, 201)
  const assignmentId = assignment.body.id

  const studentLogin = await request(app)
    .post('/api/auth/login')
    .send({ username: '20260001', password: '123456' })
  assert.equal(studentLogin.status, 200)
  const studentToken = studentLogin.body.token

  const online = await request(app)
    .post(`/api/assignments/${assignmentId}/submit`)
    .set('Authorization', `Bearer ${studentToken}`)
    .send({ content: '这是我的在线作答第一版' })
  assert.equal(online.status, 201)
  const submissionId = online.body.id

  const list = await request(app)
    .get(`/api/assignments/${assignmentId}/submissions`)
    .set('Authorization', `Bearer ${teacherToken}`)
  assert.equal(list.status, 200)
  const row = list.body.find((r) => r.username === '20260001')
  assert.ok(row, '学生行存在')
  assert.equal(row.files.length, 1, '在线作答也应出现在文件列表中')
  assert.equal(row.files[0].file_name, null, '在线作答无 file_name')
  assert.equal(row.files[0].content, '这是我的在线作答第一版')
  assert.ok(row.files[0].history_id)

  const download = await getBinary(
    `/api/submissions/${submissionId}/file?history_id=${row.files[0].history_id}`,
    teacherToken,
  )
  assert.equal(download.status, 200)
  assert.match(download.headers['content-type'], /text\/plain/, '在线作答以纯文本返回')
  assert.equal(download.body.toString(), '这是我的在线作答第一版')

  const latestDownload = await getBinary(`/api/submissions/${submissionId}/file`, teacherToken)
  assert.equal(latestDownload.status, 200)
  assert.equal(
    latestDownload.body.toString(),
    '这是我的在线作答第一版',
    '不带 history_id 也返回在线内容',
  )
})
