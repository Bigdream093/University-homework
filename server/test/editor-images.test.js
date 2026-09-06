import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import request from 'supertest'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mohen-editor-'))
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'isolated-editor-test'
process.env.DATA_DIR = directory
process.env.UPLOAD_DIR = path.join(directory, 'uploads')
const { app } = await import('../src/index.js')
const { db } = await import('../src/db.js')
const { referencedFiles } = await import('../src/services/storage.js')
after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }) })
const png = await sharp({ create: { width: 20, height: 15, channels: 3, background: '#15554e' } }).png().toBuffer()

test('Markdown images: private replies, published summaries, withdrawn notices and course copies preserve access boundaries', async () => {
  async function login(username) {
    const result = await request(app).post('/api/auth/login').send({ username, password: '123456' })
    assert.equal(result.status, 200)
    return result.body.token
  }
  const teacher = await login('teacher')
  const call = (token, method, url, body) => request(app)[method]('/api' + url).set('Authorization', `Bearer ${token}`).send(body)
  const course = (await call(teacher, 'post', '/courses', { name: 'Markdown 图片测试' })).body.id
  for (const username of ['20269901', '20269902'])
    assert.equal((await call(teacher, 'post', `/courses/${course}/students`, { username, name: username })).status, 201)
  const student = await login('20269901'), peer = await login('20269902')
  async function upload(token, buffer = png) {
    return request(app).post(`/api/courses/${course}/editor-images`).set('Authorization', `Bearer ${token}`).attach('file', buffer, { filename: '截图.png', contentType: 'image/png' })
  }
  assert.equal((await upload(student, Buffer.from('<svg onload="alert(1)"></svg>'))).status, 400)
  assert.equal((await upload(student, Buffer.alloc(10 * 1024 * 1024 + 1))).status, 413)
  const image = await upload(student)
  assert.equal(image.status, 201)
  const url = image.body.url.slice(4)
  const markdown = `## 问题\n\n![截图](${image.body.url})\n\n| 项目 | 要求 |\n| --- | --- |\n| A | B |`
  const question = await call(student, 'post', `/courses/${course}/questions`, { title: '截图问题', content: markdown, content_format: 'markdown' })
  assert.equal(question.status, 201)
  assert.equal((await call(student, 'get', url)).status, 200)
  assert.equal((await call(teacher, 'get', url)).status, 200)
  assert.equal((await call(peer, 'get', url)).status, 404)
  assert.equal((await request(app).get('/api' + url)).status, 401)
  assert.equal((await call(peer, 'post', `/courses/${course}/questions`, { title: '盗用私图', content: markdown, content_format: 'markdown' })).status, 403)
  const ownQuestion = await call(peer, 'post', `/courses/${course}/questions`, { title: '自己的问题', content: '内容', content_format: 'markdown' })
  assert.equal((await call(peer, 'put', `/questions/${ownQuestion.body.id}`, { title: '绕过格式参数', content: markdown })).status, 403)
  const replyImage = await upload(teacher)
  const replyText = `![回复截图](${replyImage.body.url})`
  assert.equal((await call(teacher, 'post', `/questions/${question.body.id}/replies`, { content: replyText, content_format: 'markdown' })).status, 201)
  assert.equal((await call(student, 'get', replyImage.body.url.slice(4))).status, 200)
  assert.equal((await call(peer, 'get', replyImage.body.url.slice(4))).status, 404)
  assert.equal((await call(teacher, 'post', `/questions/${question.body.id}/publish`, { summary: '公开摘要', reply: replyText, content_format: 'markdown' })).status, 201)
  assert.equal((await call(peer, 'get', replyImage.body.url.slice(4))).status, 200)
  assert.equal((await call(peer, 'get', url)).status, 404, 'publishing a separate summary must not reveal private screenshots')
  await call(teacher, 'post', `/questions/${question.body.id}/withdraw`, {})
  assert.equal((await call(peer, 'get', replyImage.body.url.slice(4))).status, 404)
  const noticeImage = await upload(teacher)
  const noticeText = `![通知截图](${noticeImage.body.url})`
  const notice = await call(teacher, 'post', `/courses/${course}/notices`, { title: '图片通知', content: noticeText, content_format: 'markdown', status: 'draft' })
  assert.equal(notice.status, 201)
  assert.equal((await call(student, 'get', noticeImage.body.url.slice(4))).status, 404)
  await call(teacher, 'put', `/notices/${notice.body.id}`, { status: 'published' })
  assert.equal((await call(student, 'get', noticeImage.body.url.slice(4))).status, 200)
  await call(teacher, 'put', `/notices/${notice.body.id}`, { content: '已更新' })
  const history = (await call(teacher, 'get', `/notices/${notice.body.id}`)).body
  assert.equal(history.revisions.at(-1).content, noticeText)
  assert.equal(history.revisions.at(-1).content_format, 'markdown')
  assert.equal((await call(student, 'get', noticeImage.body.url.slice(4))).status, 404)
  assert.equal((await call(teacher, 'get', noticeImage.body.url.slice(4))).status, 200)
  const row = db.prepare('SELECT * FROM editor_images WHERE id=?').get(noticeImage.body.id)
  assert.ok(referencedFiles().has(row.file_url), 'orphan scanner retains revision images')
  const legacy = await call(teacher, 'post', `/courses/${course}/assignments`, { title: '旧文本', description: '*原样*' })
  assert.equal(legacy.body.description_format, 'plain')
  const assignment = await call(teacher, 'post', `/courses/${course}/assignments`, { title: '图文作业', description: noticeText, description_format: 'markdown', status: 'published' })
  assert.equal(assignment.status, 201)
  assert.equal(assignment.body.description_format, 'markdown')
  assert.equal((await call(student, 'get', noticeImage.body.url.slice(4))).status, 200)
  const copy = await call(teacher, 'post', `/courses/${course}/copy`, { name: '复制图文课', request_id: 'markdown-course-copy-01' })
  assert.equal(copy.status, 201, JSON.stringify(copy.body))
  const copied = db.prepare("SELECT * FROM assignments WHERE course_id=? AND title='图文作业'").get(copy.body.id)
  assert.equal(copied.description_format, 'markdown')
  await call(teacher, 'post', `/courses/${copy.body.id}/students`, { username: '20269902', name: '同学' })
  db.prepare("UPDATE assignments SET status='published' WHERE id=?").run(copied.id)
  db.prepare('DELETE FROM course_students WHERE course_id=? AND student_id=(SELECT id FROM users WHERE username=?)').run(course, '20269902')
  assert.equal((await call(peer, 'get', noticeImage.body.url.slice(4))).status, 200, 'copied course image remains accessible')
  db.prepare('DELETE FROM course_students WHERE course_id=?').run(copy.body.id)
  assert.equal((await call(peer, 'get', noticeImage.body.url.slice(4))).status, 404)
  db.prepare("UPDATE courses SET status='archived' WHERE id=?").run(course)
  assert.equal((await upload(student)).status, 409)
})
