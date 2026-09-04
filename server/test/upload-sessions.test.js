import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import jwt from 'jsonwebtoken'
import request from 'supertest'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mohen-upload-protocol-'))
Object.assign(process.env, {
  NODE_ENV: 'test',
  TZ: 'Asia/Shanghai',
  JWT_SECRET: 'isolated-upload-protocol-test',
  DATA_DIR: directory,
  UPLOAD_DIR: path.join(directory, 'uploads'),
})
const { app } = await import('../src/index.js')
const { db } = await import('../src/db.js')
const { processCleanupBatch } = await import('../src/services/storage.js')
const { resolveUploadPath } = await import('../src/utils/uploadPath.js')
after(() => {
  db.close()
  fs.rmSync(directory, { recursive: true, force: true })
})
let sequence = 0
function actor(role) {
  const { lastInsertRowid: id } = db
    .prepare('INSERT INTO users(username,name,password_hash,role) VALUES(?,?,?,?)')
    .run(`protocol-${++sequence}`, role, 'unused', role)
  return { id, token: jwt.sign({ id }, process.env.JWT_SECRET) }
}
async function call(user, method, url, body, status = 200) {
  const response = await request(app)
    [method]('/api' + url)
    .set('Authorization', 'Bearer ' + user.token)
    .send(body)
  assert.equal(response.status, status, method + ' ' + url + ': ' + response.text)
  return response.body
}
async function fixture() {
  const teacher = actor('teacher'),
    student = actor('student'),
    other = actor('student')
  const course = await call(teacher, 'post', '/courses', { name: '分片协议' }, 201)
  db.prepare('INSERT INTO course_students(course_id,student_id) VALUES(?,?)').run(
    course.id,
    student.id,
  )
  const assignment = await call(
    teacher,
    'post',
    `/courses/${course.id}/assignments`,
    {
      title: '分片作业',
      type: 'document',
      status: 'published',
      total_score: 100,
      max_file_mb: 20,
      allow_resubmit_count: 0,
    },
    201,
  )
  return { teacher, student, other, course, assignment }
}
async function create(f, kind, size) {
  const material = kind === 'material'
  return call(
    material ? f.teacher : f.student,
    'post',
    '/upload-sessions',
    {
      kind,
      ...(material
        ? { mode: 'create', course_id: f.course.id, metadata: { title: '分片资料' } }
        : { assignment_id: f.assignment.id }),
      files: [
        { client_id: 'source', role: material ? 'file' : 'source', name: 'answer.zip', size },
      ],
    },
    201,
  )
}
function chunk(
  user,
  session,
  bytes,
  range,
  hash = createHash('sha256').update(bytes).digest('hex'),
) {
  return request(app)
    .put(`/api/upload-sessions/${session.id}/files/${session.files[0].id}/chunk`)
    .set('Authorization', 'Bearer ' + user.token)
    .set('Content-Type', 'application/octet-stream')
    .set('Content-Range', range)
    .set('X-Chunk-SHA256', hash)
    .send(Buffer.from(bytes))
}
function physicalFile(session) {
  const row = db
    .prepare('SELECT temporary_path FROM upload_session_files WHERE id=?')
    .get(session.files[0].id)
  return resolveUploadPath(row.temporary_path)
}

test('分片协议：会话越权、错误摘要、缺片完成与取消物理清理', async () => {
  const f = await fixture(),
    session = await create(f, 'submission', 6)
  for (const method of ['get', 'delete'])
    await call(f.other, method, '/upload-sessions/' + session.id, undefined, 404)
  assert.equal((await chunk(f.other, session, 'abc', 'bytes 0-2/6')).status, 404)
  assert.equal((await chunk(f.student, session, 'abc', 'bytes 0-2/6', '0'.repeat(64))).status, 400)
  assert.equal(
    (await call(f.student, 'get', '/upload-sessions/' + session.id)).files[0].uploaded_bytes,
    0,
  )
  assert.equal((await chunk(f.student, session, 'abc', 'bytes 0-2/6')).status, 200)
  await call(f.student, 'post', `/upload-sessions/${session.id}/complete`, {}, 409)
  assert.equal(
    db.prepare('SELECT count(*) n FROM submissions WHERE assignment_id=?').get(f.assignment.id).n,
    0,
  )
  const physical = physicalFile(session)
  assert.equal(fs.readFileSync(physical, 'utf8'), 'abc')
  await call(f.student, 'delete', '/upload-sessions/' + session.id)
  processCleanupBatch()
  assert.equal(fs.existsSync(physical), false)
  assert.equal(
    db.prepare('SELECT count(*) n FROM upload_session_files WHERE session_id=?').get(session.id).n,
    0,
  )
  assert.equal(
    db
      .prepare('SELECT count(*) n FROM submission_receipts WHERE assignment_id=?')
      .get(f.assignment.id).n,
    0,
  )
})

test('分片完成重试：同一回执、一次提交，不重复消耗次数', async () => {
  const f = await fixture(),
    session = await create(f, 'submission', 4)
  assert.equal((await chunk(f.student, session, 'once', 'bytes 0-3/4')).status, 200)
  const result = await call(f.student, 'post', `/upload-sessions/${session.id}/complete`, {})
  const remote = await call(f.student, 'get', '/upload-sessions/' + session.id)
  assert.equal(remote.state, 'succeeded')
  assert.deepEqual(JSON.parse(remote.result_json), result)
  assert.deepEqual(
    await call(f.student, 'post', `/upload-sessions/${session.id}/complete`, {}),
    result,
  )
  assert.equal(result.submit_count, 1)
  assert.equal(
    db.prepare('SELECT submit_count FROM submissions WHERE assignment_id=?').get(f.assignment.id)
      .submit_count,
    1,
  )
  assert.equal((await call(f.student, 'get', result.api_base + '/receipts')).length, 1)
})

test('资料分片完成：关联正确课程及文件，重复完成只创建一条记录', async () => {
  const f = await fixture(),
    session = await create(f, 'material', 6)
  // Byte assembly across real chunks; the 8 MB boundary remains in the browser test.
  assert.equal((await chunk(f.teacher, session, 'abc', 'bytes 0-2/6')).status, 200)
  assert.equal((await chunk(f.teacher, session, 'XYZ', 'bytes 3-5/6')).status, 200)
  const result = await call(f.teacher, 'post', `/upload-sessions/${session.id}/complete`, {
    metadata: { title: '分片资料' },
  })
  assert.deepEqual(
    await call(f.teacher, 'post', `/upload-sessions/${session.id}/complete`, {
      metadata: { title: '分片资料' },
    }),
    result,
  )
  const materials = await call(f.teacher, 'get', `/courses/${f.course.id}/materials`)
  assert.equal(materials.length, 1)
  assert.equal(materials[0].title, '分片资料')
  const download = await request(app)
    .get(`/api/materials/${materials[0].id}/file`)
    .set('Authorization', 'Bearer ' + f.teacher.token)
    .buffer(true)
    .parse((response, done) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => done(null, Buffer.concat(chunks)))
      response.on('error', done)
    })
  assert.equal(download.status, 200)
  assert.deepEqual(download.body, Buffer.from('abcXYZ'))
})

test('资料会话取消：清理已写入文件，不创建资料记录', async () => {
  const f = await fixture(),
    session = await create(f, 'material', 6)
  assert.equal((await chunk(f.teacher, session, 'abc', 'bytes 0-2/6')).status, 200)
  const physical = physicalFile(session)
  assert.equal(fs.existsSync(physical), true)
  await call(f.teacher, 'delete', '/upload-sessions/' + session.id)
  processCleanupBatch()
  assert.equal(fs.existsSync(physical), false)
  assert.deepEqual(await call(f.teacher, 'get', `/courses/${f.course.id}/materials`), [])
})
