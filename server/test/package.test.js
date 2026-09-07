import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import request from 'supertest'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mohen-package-'))
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-secret'
process.env.DATA_DIR = dataDir
process.env.UPLOAD_DIR = path.join(dataDir, 'uploads')
fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true })

const { app } = await import('../src/index.js')
const { db } = await import('../src/db.js')
const { processCleanupBatch } = await import('../src/services/storage.js')

// 库内 file_url 现为相对存储键：磁盘断言先解析回上传根下的绝对路径。
const diskPath = (key) => path.join(process.env.UPLOAD_DIR, key)

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

function zipEntryNames(buffer) {
  const names = []
  let eocd = -1
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return names
  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break
    const nameLen = buffer.readUInt16LE(offset + 28)
    names.push(buffer.toString('utf8', offset + 46, offset + 46 + nameLen))
    offset += 46 + nameLen + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32)
  }
  return names
}

async function teacherLogin() {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: 'teacher', password: '123456' })
  assert.equal(res.status, 200)
  return res.body.token
}

async function makeCourse(token) {
  const res = await request(app)
    .post('/api/courses')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: `打包测试-${Date.now()}`, code: 'PKG' })
  assert.equal(res.status, 201)
  return res.body.id
}

async function makeAssignment(token, courseId, mode, type = 'document') {
  const res = await request(app)
    .post(`/api/courses/${courseId}/assignments`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      title: mode === 'append' ? '追加模式作业' : '覆盖模式作业',
      type,
      total_score: 100,
      allow_resubmit_count: -1,
      submission_mode: mode,
      status: 'published',
    })
  assert.equal(res.status, 201)
  assert.equal(res.body.submission_mode, mode)
  return res.body.id
}

async function submissionFixture(mode, type = 'document') {
  const teacherToken = await teacherLogin()
  const courseId = await makeCourse(teacherToken)
  await request(app).post(`/api/courses/${courseId}/students`)
    .set('Authorization', `Bearer ${teacherToken}`)
    .send({ username: '20260001', name: '演示学生' }).expect(201)
  const assignmentId = await makeAssignment(teacherToken, courseId, mode, type)
  const login = await request(app).post('/api/auth/login')
    .send({ username: '20260001', password: '123456' }).expect(200)
  return { teacherToken, studentToken: login.body.token, assignmentId }
}

test('append mode keeps every uploaded file and the package zip contains all versions', async () => {
  const { teacherToken, studentToken, assignmentId } = await submissionFixture('append', 'document')

  const first = await request(app)
    .post(`/api/assignments/${assignmentId}/submit`)
    .set('Authorization', `Bearer ${studentToken}`)
    .attach('file', Buffer.from('first version'), {
      filename: '草稿一.zip',
      contentType: 'application/zip',
    })
  assert.equal(first.status, 201)
  const firstFile = db
    .prepare('SELECT file_url FROM submissions WHERE id=?')
    .get(first.body.id).file_url
  assert.ok(fs.existsSync(diskPath(firstFile)))

  const second = await request(app)
    .post(`/api/assignments/${assignmentId}/submit`)
    .set('Authorization', `Bearer ${studentToken}`)
    .field('base_version', '1')
    .attach('file', Buffer.from('second version'), {
      filename: '补充二.zip',
      contentType: 'application/zip',
    })
  assert.equal(second.status, 201)
  const secondFile = db
    .prepare('SELECT file_url FROM submissions WHERE id=?')
    .get(second.body.id).file_url
  assert.ok(fs.existsSync(diskPath(secondFile)))
  assert.ok(fs.existsSync(diskPath(firstFile)), '追加模式下旧文件不应被删除')

  const history = db
    .prepare('SELECT file_url FROM submission_history WHERE submission_id=? ORDER BY id')
    .all(first.body.id)
  assert.equal(history.filter((row) => row.file_url).length, 2, '历史中应保留两次文件记录')

  const zipRes = await getBinary(`/api/assignments/${assignmentId}/package`, teacherToken)
  assert.equal(zipRes.status, 200)
  assert.match(zipRes.headers['content-type'], /application\/zip/)
  const buffer = zipRes.body
  assert.equal(buffer.readUInt32LE(0), 0x04034b50, 'zip 应以 PK\x03\x04 开头')
  const names = zipEntryNames(buffer)
  assert.equal(names.length, 2, '压缩包应包含两个文件')
  assert.ok(names.some((name) => name.includes('草稿一.zip') || name.includes('_准时.zip')))
  assert.ok(
    names.some((name) => name.includes('_准时.zip')),
    `压缩包条目含中文规范名: ${names.join(', ')}`,
  )

  const denied = await request(app)
    .get(`/api/assignments/${assignmentId}/package`)
    .set('Authorization', `Bearer ${studentToken}`)
  assert.equal(denied.status, 403, '学生不能调用打包下载')

  const requestId = 'download-package-range-0001'
  const partial = await request(app)
    .get(`/api/assignments/${assignmentId}/package`)
    .set('Authorization', `Bearer ${teacherToken}`)
    .set('X-Download-Request-Id', requestId)
    .set('Range', 'bytes=0-15')
  assert.equal(partial.status, 206, '后台下载的压缩包应支持断点')
  assert.match(partial.headers['content-range'], /^bytes 0-15\/\d+$/)
  assert.equal(Number(partial.headers['content-length']), 16)

  const ticket = await request(app)
    .post('/api/downloads/ticket')
    .set('Authorization', `Bearer ${teacherToken}`)
    .send({ kind: 'assignment-package', id: assignmentId })
  assert.equal(ticket.status, 200)
  const browserZip = await getBinary(ticket.body.url)
  assert.equal(browserZip.status, 200, '浏览器应直接接收文件流')
  assert.equal(browserZip.body.readUInt32LE(0), 0x04034b50)
})

test('overwrite mode removes the replaced physical file and zip contains one entry', async () => {
  const { teacherToken, studentToken, assignmentId } = await submissionFixture('overwrite', 'document')

  const first = await request(app)
    .post(`/api/assignments/${assignmentId}/submit`)
    .set('Authorization', `Bearer ${studentToken}`)
    .attach('file', Buffer.from('old'), { filename: '旧版.zip', contentType: 'application/zip' })
  const firstFile = db
    .prepare('SELECT file_url FROM submissions WHERE id=?')
    .get(first.body.id).file_url

  const second = await request(app)
    .post(`/api/assignments/${assignmentId}/submit`)
    .set('Authorization', `Bearer ${studentToken}`)
    .field('base_version', '1')
    .attach('file', Buffer.from('new'), { filename: '新版.zip', contentType: 'application/zip' })
  assert.equal(second.status, 201)
  processCleanupBatch()
  assert.equal(fs.existsSync(diskPath(firstFile)), false, '覆盖模式下旧文件应被删除')

  const zipRes = await getBinary(`/api/assignments/${assignmentId}/package`, teacherToken)
  assert.equal(zipRes.status, 200)
  const names = zipEntryNames(zipRes.body)
  assert.equal(names.length, 1, '覆盖模式下压缩包只应包含最新文件')
})

test('package endpoint reports 400 when nobody has submitted', async () => {
  const teacherToken = await teacherLogin()
  const courseId = await makeCourse(teacherToken)
  const assignmentId = await makeAssignment(teacherToken, courseId, 'append')
  const zipRes = await request(app)
    .get(`/api/assignments/${assignmentId}/package`)
    .set('Authorization', `Bearer ${teacherToken}`)
  assert.equal(zipRes.status, 400)
})

test('package zip packs online-only answers as txt entries', async () => {
  const { teacherToken, studentToken, assignmentId } = await submissionFixture('append', 'online')

  const submit = await request(app)
    .post(`/api/assignments/${assignmentId}/submit`)
    .set('Authorization', `Bearer ${studentToken}`)
    .send({ content: '在线作答内容会打包为txt' })
  assert.equal(submit.status, 201)

  const zipRes = await getBinary(`/api/assignments/${assignmentId}/package`, teacherToken)
  assert.equal(zipRes.status, 200)
  const names = zipEntryNames(zipRes.body)
  assert.equal(names.length, 1, '压缩包应包含一个在线作答条目')
  assert.ok(names[0].endsWith('.txt'), `在线作答应打包为 txt: ${names.join(', ')}`)
})

test('single and assignment packages include source files and preview images', async () => {
  const teacherToken = await teacherLogin(),
    courseId = await makeCourse(teacherToken)
  await request(app)
    .post(`/api/courses/${courseId}/students`)
    .set('Authorization', `Bearer ${teacherToken}`)
    .send({ username: '20260002', name: '图片学生' })
  const created = await request(app)
    .post(`/api/courses/${courseId}/assignments`)
    .set('Authorization', `Bearer ${teacherToken}`)
    .send({
      title: '图纸作业',
      type: 'document',
      status: 'published',
      allow_resubmit_count: -1,
      require_preview_image: true,
      preview_max_count: 2,
    })
  const token = (
    await request(app).post('/api/auth/login').send({ username: '20260002', password: '123456' })
  ).body.token
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  )
  const submitted = await request(app)
    .post(`/api/assignments/${created.body.id}/submit`)
    .set('Authorization', `Bearer ${token}`)
    .attach('file', Buffer.from('drawing'), { filename: '成果.dwg' })
    .attach('previews', png, { filename: '总平面图.png', contentType: 'image/png' })
  assert.equal(submitted.status, 201, submitted.text)
  for (const url of [
    `/api/submissions/${submitted.body.id}/package`,
    `/api/assignments/${created.body.id}/package`,
  ]) {
    const zip = await getBinary(url, teacherToken),
      names = zipEntryNames(zip.body)
    assert.equal(zip.status, 200)
    assert.ok(names.some((name) => name.includes('/附件/')))
    assert.ok(names.some((name) => name.includes('/照片/')))
  }
})

test('submissions list exposes every append-mode file; first and latest versions are downloadable', async () => {
  const { teacherToken, studentToken, assignmentId } = await submissionFixture('append', 'document')

  const first = await request(app)
    .post(`/api/assignments/${assignmentId}/submit`)
    .set('Authorization', `Bearer ${studentToken}`)
    .attach('file', Buffer.from('first version'), {
      filename: '草稿一.zip',
      contentType: 'application/zip',
    })
  assert.equal(first.status, 201)
  const submissionId = first.body.id

  await request(app)
    .post(`/api/assignments/${assignmentId}/submit`)
    .set('Authorization', `Bearer ${studentToken}`)
    .field('base_version', '1')
    .attach('file', Buffer.from('second version'), {
      filename: '补充二.zip',
      contentType: 'application/zip',
    })
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
  const { teacherToken, studentToken, assignmentId } = await submissionFixture('append', 'online')

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
