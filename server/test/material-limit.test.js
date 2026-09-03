import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import request from 'supertest'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mohen-material-limit-'))
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'material-limit-test'
process.env.DATA_DIR = dir
process.env.UPLOAD_DIR = path.join(dir, 'uploads')
process.env.MATERIAL_UPLOAD_MAX_MB = '1'
const { app } = await import('../src/index.js')
const { db } = await import('../src/db.js')
after(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('course material size limit uses its independent configuration and maps Multer error to 400', async () => {
  const login = await request(app)
    .post('/api/auth/login')
    .send({ username: 'teacher', password: '123456' })
  assert.equal(login.status, 200)
  const token = login.body.token,
    course = await request(app)
      .post('/api/courses')
      .set('Authorization', 'Bearer ' + token)
      .send({ name: '资料上限测试' })
  assert.equal(course.status, 201)
  const response = await request(app)
    .post('/api/courses/' + course.body.id + '/materials')
    .set('Authorization', 'Bearer ' + token)
    .field('title', '超限资料')
    .attach('file', Buffer.alloc(1024 * 1024 + 1), { filename: 'large.pdf' })
  assert.equal(response.status, 400)
  assert.match(response.body.message, /课程资料限制单文件不超过 1M/)
  assert.equal(
    db.prepare('SELECT count(*) count FROM materials WHERE course_id=?').get(course.body.id).count,
    0,
  )
})

test('course materials accept desktop installers without allowing executables as submissions', async () => {
  const login = await request(app)
    .post('/api/auth/login')
    .send({ username: 'teacher', password: '123456' })
  assert.equal(login.status, 200)
  const token = login.body.token,
    course = await request(app)
      .post('/api/courses')
      .set('Authorization', 'Bearer ' + token)
      .send({ name: '安装包资料测试' })
  assert.equal(course.status, 201)
  for (const extension of ['exe', 'msi', 'dmg', 'pkg']) {
    const response = await request(app)
      .post('/api/courses/' + course.body.id + '/materials')
      .set('Authorization', 'Bearer ' + token)
      .field('title', extension + '安装包')
      .attach('file', Buffer.from('installer'), { filename: 'setup.' + extension })
    assert.equal(response.status, 201, response.text)
  }
})

test('login and invitation failures trigger short backoff', async () => {
  const firstLogin = await request(app)
    .post('/api/auth/login')
    .send({ username: 'rate-probe', password: 'wrong' })
  assert.equal(firstLogin.status, 401)
  const secondLogin = await request(app)
    .post('/api/auth/login')
    .send({ username: 'rate-probe', password: 'wrong' })
  assert.equal(secondLogin.status, 429)
  assert.ok(secondLogin.headers['retry-after'])
  const teacherLogin = await request(app)
      .post('/api/auth/login')
      .send({ username: 'teacher', password: '123456' }),
    token = teacherLogin.body.token
  const course = await request(app)
    .post('/api/courses')
    .set('Authorization', 'Bearer ' + token)
    .send({ name: '邀请码限速测试' })
  assert.equal(course.status, 201)
  const created = await request(app)
    .post('/api/courses/' + course.body.id + '/students')
    .set('Authorization', 'Bearer ' + token)
    .send({ username: 'invite-probe', name: '限速学生' })
  assert.equal(created.status, 201)
  const studentLogin = await request(app)
      .post('/api/auth/login')
      .send({ username: 'invite-probe', password: '123456' }),
    studentToken = studentLogin.body.token
  const firstInvite = await request(app)
    .post('/api/courses/join')
    .set('Authorization', 'Bearer ' + studentToken)
    .send({ invite_code: 'BADCODE' })
  assert.equal(firstInvite.status, 404)
  const secondInvite = await request(app)
    .post('/api/courses/join')
    .set('Authorization', 'Bearer ' + studentToken)
    .send({ invite_code: 'BADCODE' })
  assert.equal(secondInvite.status, 429)
  assert.ok(secondInvite.headers['retry-after'])
})

test('trusted proxy addresses keep clients isolated and successful login clears address failures', async () => {
  app.set('trust proxy', 1)
  try {
    for (let index = 0; index < 20; index += 1) {
      const failed = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', '198.51.100.20')
        .send({ username: 'proxy-fail-' + index, password: 'wrong' })
      assert.equal(failed.status, 401)
    }
    const otherClient = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', '198.51.100.21')
      .send({ username: 'other-client', password: 'wrong' })
    assert.equal(otherClient.status, 401)
    for (let index = 0; index < 19; index += 1)
      await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', '198.51.100.30')
        .send({ username: 'reset-fail-' + index, password: 'wrong' })
        .expect(401)
    await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', '198.51.100.30')
      .send({ username: 'teacher', password: '123456' })
      .expect(200)
    await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', '198.51.100.30')
      .send({ username: 'after-reset-one', password: 'wrong' })
      .expect(401)
    await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', '198.51.100.30')
      .send({ username: 'after-reset-two', password: 'wrong' })
      .expect(401)
  } finally {
    app.set('trust proxy', false)
  }
})
