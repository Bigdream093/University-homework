import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import ExcelJS from 'exceljs'
import {
  serializeRequiredQuestions,
  serializeRequiredAnswers,
} from '@university-homework/domain/requiredAnswers'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mohen-unified-'))
process.env.NODE_ENV = 'test'
process.env.TZ = 'UTC'
process.env.JWT_SECRET = 'isolated-test-secret'
process.env.DATA_DIR = dir
process.env.UPLOAD_DIR = path.join(dir, 'uploads')
// 上传目录由各测试按需创建；隔离/恢复用例直接写文件，这里先保证目录存在。
fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true })
const { app } = await import('../src/index.js')
const { db } = await import('../src/db.js')
const { nowText, isLate, validTime } = await import('../src/utils/time.js')
const { publishDueNotices } = await import('../src/services/noticeService.js')
const { recoverOperations } = await import('../src/services/operations.js')
const { quarantineOrphans, purgeExpiredQuarantine, pruneOperationalRecords, processCleanupBatch } =
  await import('../src/services/storage.js')
after(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
const tokens = {}
async function login(name) {
  if (!tokens[name]) {
    const r = await request(app)
      .post('/api/auth/login')
      .send({ username: name, password: '123456' })
    assert.equal(r.status, 200, r.text)
    tokens[name] = r.body.token
  }
  return tokens[name]
}
async function call(name, method, url, body, status = 200) {
  const r = await request(app)
    [method]('/api' + url)
    .set('Authorization', 'Bearer ' + (await login(name)))
    .send(body)
  assert.equal(r.status, status, method + ' ' + url + ': ' + r.text)
  return r.body
}
async function submissionRows(name, assignmentId) {
  const response = await call(name, 'get', `/assignments/${assignmentId}/submissions`)
  assert.ok(Array.isArray(response.rows), 'submission list returns paginated rows')
  return response.rows
}
function submissionItem(apiBase) {
  const kind = apiBase.startsWith('/group-submissions/') ? 'group' : 'individual'
  return { id: Number(apiBase.split('/').at(-1)), kind }
}
async function submissionAction(name, action, assignmentId, apiBase, body, status = 200) {
  return call(
    name,
    'post',
    `/assignments/${assignmentId}/batch-${action}`,
    {
      ...body,
      items: [submissionItem(apiBase)],
    },
    status,
  )
}
const { resolveUploadPath } = await import('../src/utils/uploadPath.js')
const diskPath = (key) => resolveUploadPath(key)
let sequence = 0

test('多道必答题目逐题校验，保存规范快照，修改发布后的规范不要求已有提交重交', async () => {
  const { c } = await fixture()
  const prompts = [
    { id: 'time', title: '总用时？', guidance: '请按小时填写。' },
    { id: 'method', title: '用了什么方法？', guidance: '列出步骤。' },
  ]
  const required = serializeRequiredQuestions(prompts)
  const a = await assignment(c, { required_answer: required })
  const missing = serializeRequiredAnswers(required, { time: '2小时' })
  await call(
    'alice',
    'post',
    '/assignments/' + a.id + '/submit',
    { content: missing, answer_question: required, base_version: 0 },
    400,
  )
  await call(
    'alice',
    'post',
    '/upload-sessions',
    {
      kind: 'submission',
      assignment_id: a.id,
      base_version: 0,
      metadata: { content: missing, answer_question: required },
      files: [],
    },
    400,
  )
  await call(
    'alice',
    'post',
    '/assignments/' + a.id + '/submit',
    {
      content: '任意非空文字不能绕过逐题校验',
      answer_question: required,
      base_version: 0,
    },
    400,
  )
  const content = serializeRequiredAnswers(required, {
    time: '2小时',
    method: '先分析，再绘图。',
  })
  const first = await call(
    'alice',
    'post',
    '/assignments/' + a.id + '/submit',
    { content, answer_question: required, base_version: 0 },
    201,
  )
  const downloaded = await request(app)
    .get('/api' + first.api_base + '/file')
    .set('Authorization', 'Bearer ' + (await login('teacher')))
  assert.equal(downloaded.status, 200, downloaded.text)
  assert.match(downloaded.text, /请按小时填写。/)
  assert.match(downloaded.text, /先分析，再绘图。/)
  assert.doesNotMatch(downloaded.text, /required-answers|"version"/)
  await submissionAction('teacher', 'grade', a.id, first.api_base, {
    score: 90,
    comment: '完成',
  })
  const updatedRequired = serializeRequiredQuestions(
    prompts.map((prompt) => ({
      ...prompt,
      guidance: prompt.guidance + '更新后的说明。',
    })),
  )
  await call('teacher', 'put', '/assignments/' + a.id, {
    required_answer: updatedRequired,
  })
  const saved = await call('alice', 'get', '/assignments/' + a.id + '/my-submission')
  assert.equal(saved.status, 'graded')
  assert.equal(db.prepare('SELECT score FROM submissions WHERE id=?').get(first.id).score, 90)
  assert.equal(saved.submit_count, 1)
  const history = await call('alice', 'get', first.api_base + '/history')
  assert.equal(history[0].answer_question, required)
  assert.equal(history[0].content, content)
  const receipts = await call('alice', 'get', first.api_base + '/receipts')
  assert.equal(receipts[0].snapshot.answer_question, required)
  await call(
    'alice',
    'post',
    '/assignments/' + a.id + '/submit',
    { content, answer_question: required, base_version: 1 },
    409,
  )
})

async function fixture() {
  const c = await call('teacher', 'post', '/courses', { name: '统一测试' + ++sequence }, 201)
  for (const n of ['alice', 'bob', 'cara'])
    await call(
      'teacher',
      'post',
      '/courses/' + c.id + '/students',
      { username: n, name: n + '同学' },
      201,
    )
  return {
    c,
    alice: db.prepare("SELECT id FROM users WHERE username='alice'").get().id,
    bob: db.prepare("SELECT id FROM users WHERE username='bob'").get().id,
    cara: db.prepare("SELECT id FROM users WHERE username='cara'").get().id,
  }
}
async function assignment(c, body = {}) {
  return call(
    'teacher',
    'post',
    '/courses/' + c.id + '/assignments',
    {
      title: '测试作业',
      type: 'online',
      status: 'published',
      allow_resubmit_count: -1,
      deadline: '2099-01-01 00:00:00',
      ...body,
    },
    201,
  )
}
async function submit(name, a, key, content = '答案', base = 0) {
  return request(app)
    .post('/api/assignments/' + a.id + '/submit')
    .set('Authorization', 'Bearer ' + (await login(name)))
    .set('Idempotency-Key', key)
    .send({ content, base_version: base })
}
async function groupFixture() {
  const f = await fixture(),
    g = await call(
      'teacher',
      'post',
      '/courses/' + f.c.id + '/groups',
      { name: '甲组', member_ids: [f.alice, f.bob], leader_id: f.alice },
      201,
    )
  const a = await assignment(f.c, { work_mode: 'group', status: 'draft' })
  await call('teacher', 'post', '/assignments/' + a.id + '/groups/snapshot', {
    group_ids: [g.id],
  })
  await call('teacher', 'post', '/assignments/' + a.id + '/publish')
  return { ...f, g, a }
}
test('F01 complete downloads count atomically; HEAD, Range and teacher reads do not', async () => {
  const { c } = await fixture(),
    token = await login('teacher'),
    student = await login('alice')
  const r = await request(app)
    .post('/api/courses/' + c.id + '/materials')
    .set('Authorization', 'Bearer ' + token)
    .set('Idempotency-Key', 'material-count-key')
    .field('title', '视频')
    .attach('file', Buffer.from('0123456789'), { filename: 'video.mp4' })
  assert.equal(r.status, 201, r.text)
  const url = '/api/materials/' + r.body.id + '/file'
  await request(app)
    .head(url)
    .set('Authorization', 'Bearer ' + student)
    .expect(200)
  await request(app)
    .get(url)
    .set('Authorization', 'Bearer ' + student)
    .set('Range', 'bytes=0-2')
    .expect(206)
  await request(app)
    .get(url)
    .set('Authorization', 'Bearer ' + token)
    .expect(200)
  assert.equal((await call('alice', 'get', '/courses/' + c.id + '/materials'))[0].download_count, 0)
  await Promise.all([
    request(app)
      .get(url)
      .set('Authorization', 'Bearer ' + student)
      .expect(200),
    request(app)
      .get(url)
      .set('Authorization', 'Bearer ' + student)
      .expect(200),
  ])
  assert.equal((await call('alice', 'get', '/courses/' + c.id + '/materials'))[0].download_count, 2)
  const list = await call('teacher', 'get', '/materials/' + r.body.id + '/downloads')
  assert.equal(list.length, 1)
  assert.equal(list[0].username, 'alice')
  assert.equal(list[0].download_count, 2)
  await call('alice', 'get', '/materials/' + r.body.id + '/downloads', undefined, 403)
})
test('F02/F04 notice detail, versioned reads, irreversible publication and withdrawal tombstone', async () => {
  const { c } = await fixture(),
    n = await call(
      'teacher',
      'post',
      '/courses/' + c.id + '/notices',
      { title: '正式通知', content: '正文'.repeat(200), status: 'published' },
      201,
    )
  const preview = (await call('alice', 'get', '/courses/' + c.id + '/notices'))[0]
  assert.equal(preview.content, undefined)
  assert.ok(preview.content_preview.length <= 160)
  await call('alice', 'get', '/notices/' + n.id)
  assert.equal(db.prepare('SELECT count(*) n FROM notice_reads WHERE notice_id=?').get(n.id).n, 0)
  await call('alice', 'post', '/notices/' + n.id + '/read', { revision: 1 })
  await call('alice', 'post', '/notices/' + n.id + '/read', { revision: 1 })
  assert.equal((await call('teacher', 'get', '/notices/' + n.id + '/readers')).length, 1)
  const changed = await call('teacher', 'put', '/notices/' + n.id, {
    content: '新版内容',
  })
  assert.equal(changed.content_revision, 2)
  assert.equal(
    (await call('alice', 'get', '/my/courses')).find((x) => x.id === c.id).unread_notice_count,
    1,
  )
  await call('alice', 'post', '/notices/' + n.id + '/read', { revision: 1 })
  assert.equal((await call('alice', 'get', '/courses/' + c.id + '/notices'))[0].is_updated, true)
  await call('teacher', 'put', '/notices/' + n.id, { status: 'draft' }, 400)
  await call(
    'teacher',
    'put',
    '/notices/' + n.id,
    { status: 'scheduled', scheduled_at: '2099-01-01 00:00:00' },
    400,
  )
  await call('teacher', 'delete', '/notices/' + n.id, undefined, 400)
  await call('teacher', 'post', '/notices/' + n.id + '/withdraw', {
    reason: '误发私人说明',
  })
  const tombstone = await call('alice', 'get', '/notices/' + n.id)
  assert.equal(tombstone.content, undefined)
  assert.equal(tombstone.withdrawn_reason, undefined)
  assert.equal(
    (await call('alice', 'get', '/my/courses')).find((x) => x.id === c.id).unread_notice_count,
    0,
  )
  const history = await call('teacher', 'get', '/notices/' + n.id)
  assert.equal(history.published_at, n.published_at)
  assert.equal(history.revisions.length, 2)
  assert.equal((await call('teacher', 'get', '/notices/' + n.id + '/readers')).length, 1)
  await call('teacher', 'put', '/notices/' + n.id, { status: 'published' }, 409)
  await call('alice', 'post', '/notices/' + n.id + '/read', {}, 409)
})
test('F08 scheduling catchup is bounded, idempotent and preserves intended time after editing', async () => {
  const { c } = await fixture()
  const n = await call(
    'teacher',
    'post',
    '/courses/' + c.id + '/notices',
    {
      title: '预约',
      content: '正文',
      status: 'scheduled',
      scheduled_at: '2099-01-01 00:00:00',
    },
    201,
  )
  await call('alice', 'get', '/notices/' + n.id, undefined, 404)
  const scheduled = '2020-01-01 00:00:00'
  db.prepare('UPDATE notices SET scheduled_at=? WHERE id=?').run(scheduled, n.id)
  assert.equal(publishDueNotices(), 1)
  assert.equal(publishDueNotices(), 0)
  const changed = await call('teacher', 'put', '/notices/' + n.id, {
    content: '修订',
  })
  assert.equal(changed.scheduled_at, scheduled)
  const before = changed.published_at
  publishDueNotices()
  assert.equal(
    db.prepare('SELECT published_at FROM notices WHERE id=?').get(n.id).published_at,
    before,
  )
  const add = db.prepare(
    "INSERT INTO notices(course_id,teacher_id,title,status,scheduled_at,created_at,updated_at) VALUES(?,?,'批量','scheduled',?,?,?)",
  )
  for (let i = 0; i < 105; i++) add.run(c.id, c.teacher_id, scheduled, nowText(), nowText())
  assert.equal(publishDueNotices(), 100)
  assert.equal(publishDueNotices(), 5)
  assert.equal(publishDueNotices(), 0)
})
test('F09 private original/replies and student identity never leak; teacher controls public summaries', async () => {
  const { c } = await fixture(),
    q = await call(
      'alice',
      'post',
      '/courses/' + c.id + '/questions',
      { title: '私人原题', content: '私人健康情况', must_private: true },
      201,
    )
  assert.equal(
    db.prepare('SELECT must_private FROM course_questions WHERE id=?').get(q.id).must_private,
    0,
  )
  assert.equal((await call('bob', 'get', '/courses/' + c.id + '/questions')).length, 0)
  await call('bob', 'get', '/questions/' + q.id, undefined, 404)
  await call('alice', 'put', '/questions/' + q.id + '/privacy', { must_private: true }, 404)
  await call('teacher', 'post', '/questions/' + q.id + '/replies', { content: '私人答复' }, 201)
  await call(
    'teacher',
    'post',
    '/questions/' + q.id + '/publish',
    { summary: '公开学习问题', reply: '公开说明' },
    201,
  )
  const pub = await call('bob', 'get', '/courses/' + c.id + '/questions/public')
  assert.equal(pub.length, 1)
  assert.ok(!JSON.stringify(pub).includes('私人'))
  assert.equal(pub[0].student_name, undefined)
  await call('alice', 'post', '/questions/' + q.id + '/replies', { content: '新的秘密追问' }, 201)
  assert.ok(
    !JSON.stringify(await call('bob', 'get', '/courses/' + c.id + '/questions/public')).includes(
      '秘密',
    ),
  )
  await call('alice', 'put', '/questions/' + q.id, { title: '改写', content: '改写' }, 409)
  await call('teacher', 'put', '/questions/' + q.id + '/manage', {
    status: 'resolved',
  })
  await call(
    'teacher',
    'post',
    '/questions/' + q.id + '/publish',
    { summary: '更新后的公开摘要', reply: '更新后的公开答复' },
    201,
  )
  const updated = await call('bob', 'get', '/courses/' + c.id + '/questions/public')
  assert.equal(updated.length, 1)
  assert.equal(updated[0].summary, '更新后的公开摘要')
  await call('teacher', 'post', '/courses/' + c.id + '/archive')
  await call(
    'teacher',
    'post',
    '/questions/' + q.id + '/publish',
    { summary: '归档后更新', reply: '不允许' },
    409,
  )
  await call('teacher', 'post', '/courses/' + c.id + '/restore')
  await call(
    'teacher',
    'delete',
    '/courses/' +
      c.id +
      '/students/' +
      db.prepare("SELECT id FROM users WHERE username='alice'").get().id,
  )
  await call('alice', 'get', '/questions/' + q.id, undefined, 404)
})
test('F09b teacher deletes public summaries; empty withdraw fails; students never see withdrawn or deleted', async () => {
  const { c } = await fixture(),
    q = await call(
      'alice',
      'post',
      '/courses/' + c.id + '/questions',
      { title: '提问', content: '内容' },
      201,
    )
  await call('teacher', 'post', '/questions/' + q.id + '/withdraw', undefined, 409)
  await call(
    'teacher',
    'post',
    '/questions/' + q.id + '/publish',
    { summary: '摘要一', reply: '答复一' },
    201,
  )
  await call(
    'teacher',
    'post',
    '/questions/' + q.id + '/publish',
    { summary: '摘要二', reply: '答复二' },
    201,
  )
  let pub = await call('teacher', 'get', '/courses/' + c.id + '/questions/public')
  assert.equal(pub.length, 2)
  assert.ok(pub.every((p) => p.question_id === q.id))
  await call('teacher', 'post', '/questions/' + q.id + '/withdraw')
  assert.ok(
    (await call('teacher', 'get', '/courses/' + c.id + '/questions/public')).every(
      (p) => p.status === 'withdrawn',
    ),
  )
  assert.equal((await call('bob', 'get', '/courses/' + c.id + '/questions/public')).length, 0)
  await call('alice', 'delete', '/questions/' + q.id + '/publications/' + pub[0].id, undefined, 403)
  await call('teacher', 'delete', '/questions/' + q.id + '/publications/' + pub[0].id)
  pub = await call('teacher', 'get', '/courses/' + c.id + '/questions/public')
  assert.equal(pub.length, 1)
  assert.ok(
    db
      .prepare(
        "SELECT 1 FROM question_visibility_events WHERE question_id=? AND event='delete_publication'",
      )
      .get(q.id),
  )
  await call('teacher', 'delete', '/questions/' + q.id + '/publications/' + pub[0].id)
  assert.equal((await call('teacher', 'get', '/courses/' + c.id + '/questions/public')).length, 0)
  assert.equal(
    db.prepare('SELECT count(*) n FROM question_publications WHERE question_id=?').get(q.id).n,
    0,
  )
  assert.ok(db.prepare('SELECT 1 FROM course_questions WHERE id=?').get(q.id))
})
test('F06/F07/F10 retry keeps grade/count/receipt, actual bytes fingerprint, extension only changes future submissions', async () => {
  const { c } = await fixture(),
    a = await assignment(c, { deadline: '2020-01-01 00:00:00' })
  const first = await submit('alice', a, 'receipt-test-key')
  assert.equal(first.status, 201, first.text)
  assert.equal(first.body.is_late, 1)
  assert.equal(first.body.file_url, undefined)
  await submissionAction('teacher', 'grade', a.id, first.body.api_base, {
    score: 90,
    comment: '教师私密评语',
  })
  const repeated = await submit('alice', a, 'receipt-test-key')
  assert.equal(repeated.status, 200, repeated.text)
  assert.equal(
    db.prepare('SELECT score,submit_count FROM submissions WHERE id=?').get(first.body.id).score,
    90,
  )
  assert.equal((await call('alice', 'get', first.body.api_base + '/receipts')).length, 1)
  const changed = await submit('alice', a, 'receipt-test-key', '不同内容')
  assert.equal(changed.status, 409)
  const e = await call(
    'alice',
    'post',
    '/assignments/' + a.id + '/extensions',
    { reason: '私人延期理由', requested_deadline: '2099-01-01 00:00:00' },
    201,
  )
  await call(
    'alice',
    'post',
    '/assignments/' + a.id + '/extensions',
    { reason: '重复', requested_deadline: '2099-01-02 00:00:00' },
    409,
  )
  await call('teacher', 'post', '/extensions/' + e.id + '/decision', {
    status: 'approved',
    approved_deadline: '2099-01-01 00:00:00',
  })
  await call('alice', 'post', '/extensions/' + e.id + '/withdraw', {}, 409)
  await call('teacher', 'post', `/assignments/${a.id}/batch-return`, {
    returned_reason: '请按延期后的截止时间修改后重交',
    items: [
      {
        ...submissionItem(first.body.api_base),
        expected_status: 'graded',
        expected_submit_count: 1,
      },
    ],
  })
  const second = await submit('alice', a, 'receipt-second-key', '第二次答案', 1)
  assert.equal(second.status, 201, second.text)
  assert.equal(second.body.is_late, 0)
  const r = await call('alice', 'get', first.body.api_base + '/receipts')
  assert.equal(r.length, 2)
  assert.equal(r[1].snapshot.is_late, true)
  assert.equal(r[0].snapshot.extension.id, e.id)
  assert.equal(
    (await call('alice', 'get', '/assignments/' + a.id + '/my-submission')).score,
    undefined,
  )
  await call(
    'teacher',
    'delete',
    '/courses/' +
      c.id +
      '/students/' +
      db.prepare("SELECT id FROM users WHERE username='alice'").get().id,
  )
  for (const url of [
    first.body.api_base + '/file',
    first.body.api_base + '/history',
    first.body.api_base + '/receipts',
  ])
    await call('alice', 'get', url, undefined, 404)
  for (const url of [
    '/assignments/' + a.id + '/extensions',
    '/assignments/' + a.id + '/my-submission',
  ])
    await call('alice', 'get', url, undefined, 403)
  await call('teacher', 'get', first.body.api_base + '/receipts', undefined, 404)
})
test('late filter combines with grading status instead of replacing it', async () => {
  const { c } = await fixture(),
    a = await assignment(c, { deadline: '2020-01-01 00:00:00' }),
    submitted = await submit('alice', a, 'late-filter-key')
  assert.equal(submitted.status, 201, submitted.text)
  assert.equal(submitted.body.is_late, 1)

  const pending = await call(
    'teacher',
    'get',
    `/assignments/${a.id}/submissions?status=submitted&late=1`,
  )
  assert.equal(pending.total, 1)
  assert.equal(pending.rows[0].status, 'submitted')
  assert.equal(pending.counts.late, 1)

  await submissionAction('teacher', 'grade', a.id, submitted.body.api_base, {
    score: 88,
  })
  const graded = await call(
    'teacher',
    'get',
    `/assignments/${a.id}/submissions?status=graded&late=1`,
  )
  assert.equal(graded.total, 1)
  assert.equal(graded.rows[0].status, 'graded')
  assert.equal(graded.rows[0].is_late, 1)

  const noLongerPending = await call(
    'teacher',
    'get',
    `/assignments/${a.id}/submissions?status=submitted&late=1`,
  )
  assert.equal(noLongerPending.total, 0)
})
test('F10 concurrent same key saves once; changed file bytes conflict and no failed-upload residue', async () => {
  const { c } = await fixture(),
    a = await assignment(c),
    token = await login('alice')
  const upload = (key, data, base = 0) =>
    request(app)
      .post('/api/assignments/' + a.id + '/submit')
      .set('Authorization', 'Bearer ' + token)
      .set('Idempotency-Key', key)
      .field('base_version', String(base))
      .attach('file', Buffer.from(data), { filename: 'answer.txt' })
  const results = await Promise.all([
    upload('concurrent-key', 'AAA'),
    upload('concurrent-key', 'AAA'),
  ])
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 201])
  const conflict = await upload('concurrent-key', 'BBB')
  assert.equal(conflict.status, 409, conflict.text)
  const unsupported = await request(app)
    .post('/api/assignments/' + a.id + '/submit')
    .set('Authorization', 'Bearer ' + token)
    .attach('file', Buffer.from('blocked'), { filename: 'program.exe' })
  assert.equal(unsupported.status, 400)
  assert.match(unsupported.body.message, /不支持/)
  const row = db.prepare('SELECT * FROM submissions WHERE assignment_id=?').get(a.id)
  assert.equal(row.submit_count, 1)
  processCleanupBatch()
  assert.equal(fs.readdirSync(path.join(process.env.UPLOAD_DIR, '.staging')).length, 0)
  const next = await upload('second-file-key', 'CCC', 1)
  assert.equal(next.status, 201, next.text)
  processCleanupBatch()
  assert.equal(fs.existsSync(path.join(process.env.UPLOAD_DIR, row.file_url)), false)
  const receipts = await call('alice', 'get', '/submissions/' + row.id + '/receipts')
  assert.equal(receipts[1].snapshot.file_state, 'available')
  assert.equal(receipts[1].current_file_state, 'replaced')
})
test('F13 assignment extension whitelist: strict input rules, per-assignment rejection and 20MiB upload limit', async () => {
  const { c } = await fixture()
  await call(
    'teacher',
    'post',
    '/courses/' + c.id + '/assignments',
    { title: '符号非法', type: 'document', allowed_extensions: 'dwg; exe!!' },
    400,
  )
  await call(
    'teacher',
    'post',
    '/courses/' + c.id + '/assignments',
    { title: '全局白名单外', type: 'document', allowed_extensions: 'exe' },
    400,
  )
  await call(
    'teacher',
    'post',
    '/courses/' + c.id + '/assignments',
    {
      title: '超长后缀',
      type: 'document',
      allowed_extensions: 'abcdefghijklmnop',
    },
    400,
  )
  // 在线作答作业带后缀字段：忽略并存储为不限制
  const ignored = await call(
    'teacher',
    'post',
    '/courses/' + c.id + '/assignments',
    { title: '在线作答带后缀', type: 'online', allowed_extensions: 'dwg' },
    201,
  )
  assert.equal(ignored.allowed_extensions, null)
  const doc = await call(
    'teacher',
    'post',
    '/courses/' + c.id + '/assignments',
    {
      title: '限后缀作业',
      type: 'document',
      status: 'published',
      allow_resubmit_count: -1,
      deadline: '2099-01-01 00:00:00',
      max_file_mb: 10,
      allowed_extensions: 'DWG, .zip ,.zip',
    },
    201,
  )
  assert.equal(doc.allowed_extensions, 'dwg,zip')
  const bad = await request(app)
    .post('/api/assignments/' + doc.id + '/submit')
    .set('Authorization', 'Bearer ' + (await login('alice')))
    .set('Idempotency-Key', 'ext-bad-key')
    .attach('file', Buffer.from('x'), { filename: 'photo.png' })
  assert.equal(bad.status, 400, bad.text)
  assert.match(bad.body.message, /dwg/)
  const good = await request(app)
    .post('/api/assignments/' + doc.id + '/submit')
    .set('Authorization', 'Bearer ' + (await login('alice')))
    .set('Idempotency-Key', 'ext-good-key')
    .attach('file', Buffer.from('x'), { filename: 'part.zip' })
  assert.equal(good.status, 201, good.text)
  const changedRules = await call('teacher', 'put', '/assignments/' + doc.id, {
    allowed_extensions: 'dwg',
  })
  assert.equal(changedRules.allowed_extensions, 'dwg')
  const small = await call(
    'teacher',
    'post',
    '/courses/' + c.id + '/assignments',
    {
      title: '二十兆作业',
      type: 'document',
      status: 'published',
      allow_resubmit_count: -1,
      deadline: '2099-01-01 00:00:00',
      max_file_mb: 20,
      allowed_extensions: 'zip',
    },
    201,
  )
  const oversize = await request(app)
    .post('/api/assignments/' + small.id + '/submit')
    .set('Authorization', 'Bearer ' + (await login('bob')))
    .set('Idempotency-Key', 'size-key')
    .attach('file', Buffer.alloc(21 * 1024 * 1024), { filename: 'big.zip' })
  assert.equal(oversize.status, 400, oversize.text)
  await call(
    'teacher',
    'post',
    '/courses/' + c.id + '/assignments',
    { title: '图片类型', type: 'image' },
    400,
  )
})
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)
const JPEG_1PX = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  'base64',
)
async function submitWithPreviews(name, a, key, previewBuffers = [], base = 0) {
  const req = request(app)
    .post('/api/assignments/' + a.id + '/submit')
    .set('Authorization', 'Bearer ' + (await login(name)))
    .set('Idempotency-Key', key)
    .field('base_version', String(base))
    .attach('file', Buffer.from('source'), { filename: 'design.dwg' })
  for (const [index, buffer] of previewBuffers.entries())
    req.attach('previews', buffer, { filename: `preview-${index}.png` })
  return req
}
test('F14 preview images: required, magic-byte validated, counted, replaced on overwrite, access controlled', async () => {
  const { c } = await fixture()
  // 配置校验：张数越界 400；未开启时提交预览图被拒
  await call(
    'teacher',
    'post',
    '/courses/' + c.id + '/assignments',
    { title: '张数越界', type: 'document', preview_max_count: 11 },
    400,
  )
  const plain = await call(
    'teacher',
    'post',
    '/courses/' + c.id + '/assignments',
    {
      title: '不要求预览',
      type: 'document',
      status: 'published',
      allow_resubmit_count: -1,
      deadline: '2099-01-01 00:00:00',
    },
    201,
  )
  assert.equal(plain.require_preview_image, 0)
  await submitWithPreviews('alice', plain, 'plain-with-preview', [PNG_1PX]).then((r) =>
    assert.equal(r.status, 400, r.text),
  )
  // 开启预览：缺图拒收
  const doc = await call(
    'teacher',
    'post',
    '/courses/' + c.id + '/assignments',
    {
      title: '要求预览',
      type: 'document',
      status: 'published',
      allow_resubmit_count: -1,
      deadline: '2099-01-01 00:00:00',
      max_file_mb: 200,
      allowed_extensions: 'dwg',
      require_preview_image: true,
      preview_max_count: 2,
    },
    201,
  )
  assert.equal(doc.require_preview_image, 1)
  const noPreview = await request(app)
    .post('/api/assignments/' + doc.id + '/submit')
    .set('Authorization', 'Bearer ' + (await login('alice')))
    .set('Idempotency-Key', 'prev-none')
    .attach('file', Buffer.from('x'), { filename: 'a.dwg' })
  assert.equal(noPreview.status, 400, noPreview.text)
  assert.match(noPreview.body.message, /预览/)
  // 伪造 png（文本）被魔数校验拒绝；真实 png/jpeg 通过
  const fake = await submitWithPreviews('alice', doc, 'prev-fake', [Buffer.from('not-a-png')])
  assert.equal(fake.status, 400, fake.text)
  assert.match(fake.body.message, /真实的 JPG\/PNG/)
  const ok = await submitWithPreviews('alice', doc, 'prev-ok-key', [PNG_1PX, JPEG_1PX])
  assert.equal(ok.status, 201, ok.text)
  assert.equal(ok.body.preview_count, 2)
  // 超出上限
  const overCount = await submitWithPreviews('bob', doc, 'prev-cnt-key', [
    PNG_1PX,
    JPEG_1PX,
    PNG_1PX,
  ])
  assert.equal(overCount.status, 400, overCount.text)
  // 超过 20M
  const oversize = await submitWithPreviews('bob', doc, 'prev-size-key', [
    Buffer.alloc(21 * 1024 * 1024, 0x89),
  ])
  assert.equal(oversize.status, 400, oversize.text)
  // 缩略图已生成；列表接口返回图片组（按 sort_order）
  const historyId = db
    .prepare('SELECT id FROM submission_history WHERE submission_id=? ORDER BY id DESC')
    .get(ok.body.id).id
  const previews = await call('alice', 'get', '/submission-history/' + historyId + '/previews')
  assert.equal(previews.length, 2)
  assert.deepEqual(
    previews.map((p) => p.sort_order),
    [0, 1],
  )
  assert.ok(
    previews[0].thumbnail_url && previews[0].mime_type === 'image/png' && previews[0].width === 1,
  )
  // 缩略图与原图访问；他人无权访问
  const thumb = await request(app)
    .get(previews[0].thumbnail_url.replace('/api', '/api'))
    .set('Authorization', 'Bearer ' + (await login('alice')))
  assert.equal(thumb.status, 200)
  const original = await request(app)
    .get(previews[0].file_url)
    .set('Authorization', 'Bearer ' + (await login('alice')))
  assert.equal(original.status, 200)
  // 图片票据仍绑定签发用户；账号停用后不能继续匿名读取。
  const ticketResponse = await request(app)
    .post('/api/previews/view-ticket')
    .set('Authorization', 'Bearer ' + (await login('alice')))
    .send({ ids: [previews[0].id, 999999999] })
  assert.equal(ticketResponse.status, 200, ticketResponse.text)
  assert.match(ticketResponse.headers['server-timing'], /preview_access;dur=/)
  assert.match(ticketResponse.headers['server-timing'], /preview_tickets;dur=/)
  const ticket = ticketResponse.body
  assert.equal(ticket.tickets[999999999], undefined)
  const urls = ticket.tickets[previews[0].id]
  const ticketThumb = await request(app).get(urls.thumbnail)
  const ticketOriginal = await request(app).get(urls.file)
  assert.equal(ticketThumb.status, 200)
  assert.equal(ticketThumb.headers['x-preview-variant'], 'thumbnail')
  assert.match(ticketThumb.headers['server-timing'], /preview_access;dur=/)
  assert.match(ticketThumb.headers['server-timing'], /preview_thumbnail;dur=/)
  assert.equal(ticketThumb.headers['content-type'], thumb.headers['content-type'])
  assert.deepEqual(ticketThumb.body, thumb.body)
  assert.equal(ticketOriginal.status, 200)
  assert.equal(
    ticketOriginal.headers['content-disposition'],
    original.headers['content-disposition'],
  )
  assert.deepEqual(ticketOriginal.body, original.body)
  const storedPreview = db
    .prepare('SELECT file_url,thumbnail_url FROM submission_preview_images WHERE id=?')
    .get(previews[0].id)
  try {
    for (const thumbnail of [null, 'missing-thumbnail.jpg']) {
      db.prepare('UPDATE submission_preview_images SET thumbnail_url=? WHERE id=?').run(
        thumbnail,
        previews[0].id,
      )
      const directFallback = await request(app)
        .get(previews[0].thumbnail_url)
        .set('Authorization', 'Bearer ' + (await login('alice')))
      const ticketFallback = await request(app).get(urls.thumbnail)
      for (const response of [directFallback, ticketFallback]) {
        assert.equal(response.status, 200)
        assert.match(response.headers['content-type'], /^image\/jpeg/)
        assert.equal(response.headers['content-disposition'], undefined)
        assert.equal(response.headers['x-content-type-options'], 'nosniff')
        assert.equal(response.headers['x-preview-variant'], 'thumbnail')
        assert.deepEqual(response.body.subarray(0, 3), Buffer.from([255, 216, 255]))
      }
      assert.deepEqual(directFallback.body, ticketFallback.body)
      const generated = db
        .prepare('SELECT thumbnail_url FROM submission_preview_images WHERE id=?')
        .get(previews[0].id).thumbnail_url
      assert.ok(generated && generated !== thumbnail)
      assert.ok(fs.existsSync(diskPath(generated)))
    }
    db.prepare('UPDATE submission_preview_images SET thumbnail_url=?,file_url=? WHERE id=?').run(
      storedPreview.thumbnail_url,
      'missing-original.png',
      previews[0].id,
    )
    assert.equal((await request(app).get(urls.thumbnail)).status, 200)
    assert.equal((await request(app).get(urls.file)).status, 404)
  } finally {
    db.prepare('UPDATE submission_preview_images SET thumbnail_url=?,file_url=? WHERE id=?').run(
      storedPreview.thumbnail_url,
      storedPreview.file_url,
      previews[0].id,
    )
  }
  db.prepare("UPDATE users SET status='inactive' WHERE username='alice'").run()
  const disabledTicket = await request(app).get(ticket.tickets[previews[0].id].thumbnail)
  assert.equal(disabledTicket.status, 401)
  db.prepare("UPDATE users SET status='active' WHERE username='alice'").run()
  await call('bob', 'get', '/submission-previews/' + previews[0].id + '/file', undefined, 403)
  await call('alice', 'get', '/submission-previews/99999/file', undefined, 404)
  const aliceId = db.prepare("SELECT id FROM users WHERE username='alice'").get().id
  await call('teacher', 'post', '/students/' + aliceId + '/reset-password')
  assert.equal((await request(app).get(urls.file)).status, 401)
  delete tokens.alice
  const freshTicket = await call('alice', 'post', '/previews/view-ticket', {
    ids: [previews[0].id],
  })
  assert.equal((await request(app).get(freshTicket.tickets[previews[0].id].file)).status, 200)
  // 回执快照包含图片清单
  const receipt = await call('alice', 'get', ok.body.api_base + '/receipts')
  assert.equal(receipt[0].snapshot.preview_count, 2)
  assert.equal(receipt[0].snapshot.previews.length, 2)
  // 覆盖模式：重新提交替换整组图片，旧行 replaced
  const ok2 = await submitWithPreviews('alice', doc, 'prev-ok-2', [PNG_1PX], 1)
  assert.equal(ok2.status, 201, ok2.text)
  const firstHistoryIdForOld = db
    .prepare('SELECT id FROM submission_history WHERE submission_id=? ORDER BY id ASC LIMIT 1')
    .get(ok.body.id).id
  const oldStates = db
    .prepare(
      'SELECT p.file_state FROM submission_preview_images p WHERE p.submission_history_id=? ORDER BY p.id',
    )
    .all(firstHistoryIdForOld)
  assert.deepEqual([...new Set(oldStates.map((r) => r.file_state))], ['replaced'])
  const latestHistory = db
    .prepare('SELECT id FROM submission_history WHERE submission_id=? ORDER BY id DESC')
    .get(ok2.body.id).id
  assert.equal(
    (await call('alice', 'get', '/submission-history/' + latestHistory + '/previews')).length,
    1,
  )
  // 已有提交后允许修改预览要求，原提交仍可读取。
  await call('teacher', 'put', '/assignments/' + doc.id, {
    require_preview_image: false,
    preview_max_count: 1,
  })
  assert.equal((await submissionRows('teacher', doc.id))[0].preview_count, 1)
  await call('teacher', 'put', '/assignments/' + doc.id, {
    require_preview_image: true,
    preview_max_count: 3,
  })
  // 未要求预览的老作业默认为 0，正常编辑
  await call('teacher', 'put', '/assignments/' + plain.id, {
    title: '改名不报错',
  })
})
test('退回只解锁一次更正提交，更正次数与自行重交额度分开', async () => {
  const { c } = await fixture(),
    a = await assignment(c, { allow_resubmit_count: 0 })
  const first = await submit('alice', a, 'return-first')
  assert.equal(first.status, 201, first.text)
  assert.equal(first.body.submit_count, 1)
  assert.equal(first.body.resubmit_count, 0)
  const voluntary = await submit('alice', a, 'return-voluntary', '答案', 1)
  assert.equal(voluntary.status, 400, voluntary.text)
  await submissionAction('teacher', 'return', a.id, first.body.api_base, {
    returned_reason: '请修改后重新提交',
  })
  const second = await submit('alice', a, 'return-second', '答案', 1)
  assert.equal(second.status, 201, second.text)
  assert.equal(second.body.status, 'submitted')
  assert.equal(second.body.submit_count, 2)
  assert.equal(second.body.resubmit_count, 0)
  const third = await submit('alice', a, 'return-third', '答案', 2)
  assert.equal(third.status, 400, third.text)
  assert.match(third.text, /允许自行重交次数/)
  await submissionAction('teacher', 'return', a.id, second.body.api_base, {
    returned_reason: '仍需补充，请再次修改',
  })
  const correctedAgain = await submit('alice', a, 'return-third-after-new-return', '再次修改', 2)
  assert.equal(correctedAgain.status, 201, correctedAgain.text)
  assert.equal(correctedAgain.body.submit_count, 3)
  assert.equal(correctedAgain.body.resubmit_count, 0)
  // 断点下载完成登记：同一编号只计一次
  const materialCreate = await request(app)
    .post('/api/courses/' + c.id + '/materials')
    .set('Authorization', 'Bearer ' + (await login('teacher')))
    .set('Idempotency-Key', 'material-dl-key')
    .field('title', '测试资料')
    .attach('file', Buffer.from('内容'), { filename: 'notes.txt' })
  assert.equal(materialCreate.status, 201, materialCreate.text)
  const material = materialCreate.body
  const firstCount = await call(
    'alice',
    'post',
    '/materials/' + material.id + '/download-completed',
    { download_id: 'download-abc-123456789' },
  )
  assert.equal(firstCount.counted, true)
  const secondCount = await call(
    'alice',
    'post',
    '/materials/' + material.id + '/download-completed',
    { download_id: 'download-abc-123456789' },
  )
  assert.equal(secondCount.counted, false)
  const list = await call('teacher', 'get', '/materials/' + material.id + '/downloads')
  assert.equal(list.length, 1)
  assert.equal(list[0].download_count, 1)
})

test('已评分提交锁定学生自行修改，教师退回后更正不占自行重交额度', async () => {
  const { c } = await fixture(),
    a = await assignment(c, { allow_resubmit_count: 1 })
  const first = await submit('alice', a, 'graded-lock-first')
  assert.equal(first.status, 201, first.text)
  const second = await submit('alice', a, 'graded-lock-second', '主动重交', 1)
  assert.equal(second.status, 201, second.text)
  assert.equal(second.body.submit_count, 2)
  assert.equal(second.body.resubmit_count, 1)
  await submissionAction('teacher', 'grade', a.id, second.body.api_base, {
    score: 88,
    comment: '已批改',
  })
  const blocked = await submit('alice', a, 'graded-lock-blocked', '擅自修改', 2)
  assert.equal(blocked.status, 400, blocked.text)
  assert.match(blocked.text, /已经评分/)
  const locked = db
    .prepare('SELECT score,status,submit_count,resubmit_count FROM submissions WHERE id=?')
    .get(second.body.id)
  assert.equal(locked.score, 88)
  assert.equal(locked.status, 'graded')
  assert.equal(locked.submit_count, 2)
  assert.equal(locked.resubmit_count, 1)
  const returned = await call('teacher', 'post', `/assignments/${a.id}/batch-return`, {
    returned_reason: '请按意见修改',
    items: [
      {
        ...submissionItem(second.body.api_base),
        expected_status: 'graded',
        expected_submit_count: 2,
      },
    ],
  })
  assert.equal(returned.success_count, 1)
  const corrected = await submit('alice', a, 'graded-lock-corrected', '按意见修改', 2)
  assert.equal(corrected.status, 201, corrected.text)
  assert.equal(corrected.body.status, 'submitted')
  assert.equal(corrected.body.submit_count, 3)
  assert.equal(corrected.body.resubmit_count, 1)
  assert.equal(
    db.prepare('SELECT score,status FROM submissions WHERE id=?').get(second.body.id).score,
    null,
  )
})

test('release guards cover assignment edits, deadline clearing, statistics, duplicate history id and quarantine expiry', async () => {
  const { c, alice } = await fixture(),
    a = await assignment(c),
    submitted = await submit('alice', a, 'release-guard-submit', '初稿')
  assert.equal(submitted.status, 201, submitted.text)
  await submissionAction('teacher', 'grade', a.id, submitted.body.api_base, {
    score: 90,
  })
  await call('teacher', 'put', '/assignments/' + a.id, { total_score: 89 })
  assert.equal(
    db.prepare('SELECT score FROM submissions WHERE assignment_id=?').get(a.id).score,
    90,
  )
  await call('teacher', 'put', '/assignments/' + a.id, { type: 'document' })
  assert.equal((await submissionRows('teacher', a.id))[0].files.length, 1)
  const extension = await call(
    'alice',
    'post',
    '/assignments/' + a.id + '/extensions',
    { reason: '需要更多时间', requested_deadline: '2099-01-02 00:00:00' },
    201,
  )
  const cleared = await call('teacher', 'put', '/assignments/' + a.id, {
    deadline: null,
  })
  assert.equal(cleared.cancelled_extension_count, 1)
  assert.equal(
    db.prepare('SELECT status FROM extension_requests WHERE id=?').get(extension.id).status,
    'cancelled',
  )
  const history = db
    .prepare('SELECT id FROM submission_history WHERE submission_id=?')
    .get(submitted.body.id)
  await call(
    'teacher',
    'get',
    submitted.body.api_base + `/file?history_id=${history.id}&history_id=${history.id}`,
    undefined,
    400,
  )

  const notice = await call(
    'teacher',
    'post',
    '/courses/' + c.id + '/notices',
    { title: '统计通知', content: '正文', status: 'published' },
    201,
  )
  await call('alice', 'post', '/notices/' + notice.id + '/read', {
    revision: 1,
  })
  assert.equal(
    (await call('teacher', 'get', '/courses/' + c.id + '/notices')).find(
      (row) => row.id === notice.id,
    ).read_count,
    1,
  )
  await call('teacher', 'delete', '/courses/' + c.id + '/students/' + alice)
  assert.equal(
    (await call('teacher', 'get', '/courses/' + c.id + '/notices')).find(
      (row) => row.id === notice.id,
    ).read_count,
    0,
  )
  assert.equal((await call('teacher', 'get', '/notices/' + notice.id + '/readers')).length, 0)

  const grouped = await groupFixture(),
    groupSubmission = await submit('alice', grouped.a, 'group-stat-submit', '小组答案')
  assert.equal(groupSubmission.status, 201, groupSubmission.text)
  const students = await call('teacher', 'get', '/courses/' + grouped.c.id + '/students')
  assert.equal(students.find((row) => row.username === 'alice').submission_count, 1)
  assert.equal(students.find((row) => row.username === 'bob').submission_count, 1)

  const quarantineDir = path.join(process.env.UPLOAD_DIR, '.quarantine')
  fs.mkdirSync(quarantineDir, { recursive: true })
  const expired = path.join(quarantineDir, 'expired.bin')
  fs.writeFileSync(expired, 'old')
  const quarantineId = db
    .prepare(
      "INSERT INTO storage_quarantine(original_path,quarantine_path,quarantined_at) VALUES(?,?,datetime('now','+08:00','-31 days'))",
    )
    .run(expired, expired).lastInsertRowid
  assert.equal(purgeExpiredQuarantine().removed, 1)
  assert.equal(fs.existsSync(expired), false)
  assert.ok(
    db.prepare('SELECT deleted_at FROM storage_quarantine WHERE id=?').get(quarantineId).deleted_at,
  )
})
test('F11 snapshot required, group permission, member reads, version conflict, privacy, frozen export', async () => {
  const f = await groupFixture(),
    { a, c, alice, bob, cara, g } = f
  const empty = await assignment(c, { work_mode: 'group', status: 'draft' })
  await call('teacher', 'post', '/assignments/' + empty.id + '/publish', {}, 400)
  const denied = await submit('bob', a, 'group-denied-key')
  assert.equal(denied.status, 403)
  const first = await submit('alice', a, 'group-success-key')
  assert.equal(first.status, 201, first.text)
  const studentAssignments = await call(
    'teacher',
    'get',
    '/courses/' + c.id + '/students/' + bob + '/submissions',
  )
  assert.equal(studentAssignments.length, 1)
  assert.equal(studentAssignments[0].assignment_id, a.id)
  assert.equal(studentAssignments[0].members.length, 2)
  const member = await call('bob', 'get', '/assignments/' + a.id + '/my-submission')
  assert.equal(member.id, first.body.id)
  assert.equal(member.can_submit, false)
  assert.equal((await call('bob', 'get', member.api_base + '/receipts')).length, 1)
  await call('cara', 'get', member.api_base + '/file', undefined, 403)
  await call('teacher', 'put', '/assignments/' + a.id, {
    group_submit_policy: 'any',
  })
  const responses = await Promise.all([
    submit('alice', a, 'group-race-alice', '甲', 1),
    submit('bob', a, 'group-race-bob', '乙', 1),
  ])
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409])
  const e = await call(
    'alice',
    'post',
    '/assignments/' + a.id + '/extensions',
    { reason: '保密延期原因', requested_deadline: '2099-02-01 00:00:00' },
    201,
  )
  const other = await call('bob', 'get', '/assignments/' + a.id + '/extensions')
  assert.equal(other[0].reason, undefined)
  await call('teacher', 'post', '/extensions/' + e.id + '/decision', {
    status: 'approved',
  })
  assert.equal(
    (await call('bob', 'get', '/assignments/' + a.id + '/submission-context')).effective_deadline,
    '2099-02-01 00:00:00',
  )
  await call('teacher', 'put', '/groups/' + g.id, {
    name: '新模板名',
    member_ids: [alice, cara],
    leader_id: alice,
  })
  assert.equal(
    (await call('teacher', 'get', '/assignments/' + a.id + '/groups'))[0].members.some(
      (m) => m.id === bob,
    ),
    true,
  )
  await submissionAction('teacher', 'grade', a.id, member.api_base, {
    score: 88,
    comment: '共享教师评语',
  })
  await call('teacher', 'delete', '/courses/' + c.id + '/students/' + bob)
  await call('bob', 'get', member.api_base + '/receipts', undefined, 403)
  const excel = await request(app)
    .get('/api/assignments/' + a.id + '/export')
    .set('Authorization', 'Bearer ' + (await login('teacher')))
    .buffer(true)
    .parse((r, cb) => {
      const chunks = []
      r.on('data', (c) => chunks.push(c))
      r.on('end', () => cb(null, Buffer.concat(chunks)))
    })
  assert.equal(excel.status, 200)
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(excel.body)
  const json = JSON.stringify(book.worksheets[0].getSheetValues())
  assert.ok(!json.includes('bob'))
  assert.ok(json.includes('88'))
  const rows = await submissionRows('teacher', a.id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].members.length, 1)
  assert.equal(rows[0].submit_count, 2)
})
test('F05 archive blocks mutations and invites, cancels pending work, reads remain; copying resets independent data', async () => {
  const { c, alice } = await fixture(),
    a = await assignment(c),
    e = await call(
      'alice',
      'post',
      '/assignments/' + a.id + '/extensions',
      { reason: '待处理', requested_deadline: '2099-02-01 00:00:00' },
      201,
    )
  const n = await call(
    'teacher',
    'post',
    '/courses/' + c.id + '/notices',
    { title: '排期', status: 'scheduled', scheduled_at: '2099-01-01 00:00:00' },
    201,
  )
  await call('teacher', 'post', '/courses/' + c.id + '/archive')
  for (const [method, url, body] of [
    ['post', '/courses/' + c.id + '/students', { username: 'new', name: '新' }],
    ['post', '/courses/' + c.id + '/assignments', { title: '新' }],
    ['put', '/assignments/' + a.id, { title: '新' }],
    ['post', '/courses/' + c.id + '/groups', { name: '组', member_ids: [alice], leader_id: alice }],
    ['delete', '/courses/' + c.id],
    ['get', '/courses/' + c.id + '/invite-code'],
  ])
    await call('teacher', method, url, body, 409)
  assert.equal((await call('teacher', 'get', '/courses/' + c.id)).invite_code, null)
  assert.equal(
    (await call('alice', 'get', '/assignments/' + a.id + '/extensions'))[0].status,
    'cancelled',
  )
  const draft = await call('teacher', 'get', '/notices/' + n.id)
  assert.equal(draft.status, 'draft')
  assert.equal(draft.scheduled_at, null)
  await call('alice', 'post', '/courses/join', { invite_code: c.invite_code }, 400)
  const copy = await request(app)
    .post('/api/courses/' + c.id + '/copy')
    .set('Authorization', 'Bearer ' + (await login('teacher')))
    .set('Idempotency-Key', 'copy-once-key')
    .send({ name: '副本' })
  assert.equal(copy.status, 201, copy.text)
  const again = await request(app)
    .post('/api/courses/' + c.id + '/copy')
    .set('Authorization', 'Bearer ' + (await login('teacher')))
    .set('Idempotency-Key', 'copy-once-key')
    .send({ name: '副本' })
  assert.equal(again.status, 200)
  assert.equal(again.body.id, copy.body.id)
  const as = await call('teacher', 'get', '/courses/' + copy.body.id + '/assignments')
  assert.equal(as[0].status, 'draft')
  assert.equal(as[0].deadline, null)
  assert.equal((await call('teacher', 'get', '/courses/' + copy.body.id + '/students')).length, 0)
})
test('F12 login help is role-specific; authenticated student has four workflow chapters', async () => {
  const pub = await request(app).get('/api/help/public')
  assert.equal(pub.status, 200)
  assert.deepEqual(
    pub.body.map((chapter) => chapter.id),
    ['student-login'],
  )
  assert.equal(pub.body[0].body.match(/^\d+\. /gm).length, 4)
  const teacherLogin = await request(app).get('/api/help/public?role=teacher')
  assert.deepEqual(
    teacherLogin.body.map((chapter) => chapter.id),
    ['teacher-login'],
  )
  assert.equal(teacherLogin.body[0].body.match(/^\d+\. /gm).length, 4)
  assert.ok(!teacherLogin.body[0].body.includes('学号和密码登录'))
  const student = await call('alice', 'get', '/help')
  assert.deepEqual(
    student.map((chapter) => chapter.id),
    ['student-submit', 'student-notice', 'student-material', 'student-qa'],
  )
  assert.ok(student.every((chapter) => chapter.format === 'student-manual'))
  assert.ok(student[0].body.includes('不占自行重交额度'))
  assert.ok(student[1].body.includes('成功打开通知全文'))
  assert.ok(student[2].body.includes('教师设置的顺序'))
  assert.ok(student[3].body.includes('匿名公开摘要和答复'))
  for (const alias of [
    'login',
    'student-course',
    'student-receipt',
    'student-extension',
    'student-group',
    'student-faq',
  ])
    assert.equal((await call('alice', 'get', '/help/' + alias)).id, 'student-submit')
  assert.equal((await call('alice', 'get', '/help/student-notice')).id, 'student-notice')
  await call('alice', 'get', '/help/maintenance', undefined, 404)
  assert.deepEqual(await call('alice', 'get', '/help?q=docker'), [])
  const teacher = await call('teacher', 'get', '/help')
  assert.equal(teacher.length, 8)
  assert.equal(teacher.at(-1).nav_title, '更新与部署')
  assert.ok(teacher.at(-1).body.includes('TAR 镜像文件'))
  const dl = await request(app)
    .get('/api/help/download')
    .set('Authorization', 'Bearer ' + (await login('alice')))
  assert.equal(dl.status, 200)
  assert.ok(!dl.text.includes('JWT_SECRET'))
})
test('time boundaries, interrupted requests recover and unknown files quarantine without deleting referenced files', async () => {
  const { c } = await fixture()
  const a = await assignment(c)
  const uploaded = await request(app)
    .post('/api/assignments/' + a.id + '/submit')
    .set('Authorization', 'Bearer ' + (await login('alice')))
    .attach('file', Buffer.from('referenced fixture'), {
      filename: 'referenced.txt',
    })
  assert.equal(uploaded.status, 201, uploaded.text)
  assert.equal(isLate('2026-08-31 12:00:00', '2026-08-31 12:00:00'), 0)
  assert.equal(isLate('2026-08-31 12:00:00', '2026-08-31 12:00:01'), 1)
  assert.equal(validTime('2026-02-30 12:00:00'), false)
  const at = nowText(),
    china = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date())
  assert.equal(at.slice(0, 16), china.slice(0, 16))
  const stage = path.join(process.env.UPLOAD_DIR, 'interrupted.txt')
  fs.writeFileSync(stage, 'partial')
  db.prepare(
    "INSERT INTO operation_requests(actor_id,kind,target_id,request_id,state,file_path,owner,created_at,updated_at) VALUES(1,'submission',999,'crash-test','processing',?,'previous-process',?,?)",
  ).run(stage, at, at)
  recoverOperations()
  assert.equal(
    db.prepare("SELECT state FROM operation_requests WHERE request_id='crash-test'").get().state,
    'failed',
  )
  assert.equal(fs.existsSync(stage), false)
  const unknown = path.join(process.env.UPLOAD_DIR, 'legacy-orphan.txt')
  fs.writeFileSync(unknown, 'preserve')
  fs.utimesSync(unknown, new Date('2020-01-01'), new Date('2020-01-01'))
  const refs = db
    .prepare(
      "SELECT file_url FROM submission_history WHERE submission_id=? AND file_state='available'",
    )
    .all(uploaded.body.id)
    .map((x) => x.file_url)
    .filter(Boolean)
    .map(diskPath)
  assert.equal(refs.length, 1, '必须自行准备非空的存活引用')
  for (const file of refs) {
    assert.equal(fs.readFileSync(file, 'utf8'), 'referenced fixture')
    fs.utimesSync(file, new Date('2020-01-01'), new Date('2020-01-01'))
  }
  const result = quarantineOrphans()
  assert.ok(result.quarantined >= 1)
  assert.equal(result.retention_days, 30)
  assert.ok(refs.every((p) => fs.existsSync(p)))
  for (const file of refs) assert.equal(fs.readFileSync(file, 'utf8'), 'referenced fixture')
  const q = db
    .prepare('SELECT quarantine_path FROM storage_quarantine WHERE original_path=?')
    .get('legacy-orphan.txt')
  assert.ok(q, '孤儿文件应进入隔离区')
  assert.equal(fs.readFileSync(diskPath(q.quarantine_path), 'utf8'), 'preserve')
})
test('completed operational records are pruned only after their retention windows', () => {
  const old = '2020-01-01 00:00:00',
    recent = nowText()
  db.prepare(
    "INSERT INTO operation_requests(actor_id,kind,target_id,request_id,state,created_at,updated_at) VALUES(1,'submission',1,'old-operation','succeeded',?,?)",
  ).run(old, old)
  db.prepare(
    "INSERT INTO operation_requests(actor_id,kind,target_id,request_id,state,created_at,updated_at) VALUES(1,'submission',1,'recent-operation','succeeded',?,?)",
  ).run(recent, recent)
  db.prepare(
    "INSERT INTO file_cleanup_jobs(path,reason,state,created_at,completed_at) VALUES('old-cleanup','test','removed',?,?)",
  ).run(old, old)
  db.prepare(
    "INSERT INTO storage_quarantine(original_path,quarantine_path,quarantined_at,deleted_at) VALUES('old-original','old-quarantine',?,?)",
  ).run(old, old)
  const result = pruneOperationalRecords()
  assert.deepEqual(result, { operation: 1, cleanup: 1, quarantine: 1 })
  assert.equal(
    db
      .prepare("SELECT count(*) n FROM operation_requests WHERE request_id='recent-operation'")
      .get().n,
    1,
  )
})

test('copying uses independent files; copy failure rolls back course and marks operation failed', async () => {
  const { c } = await fixture(),
    token = await login('teacher')
  for (const title of ['资料一', '资料二']) {
    const r = await request(app)
      .post('/api/courses/' + c.id + '/materials')
      .set('Authorization', 'Bearer ' + token)
      .field('title', title)
      .attach('file', Buffer.from(title), { filename: 'notes.txt' })
    assert.equal(r.status, 201, r.text)
  }
  const copy = await request(app)
    .post('/api/courses/' + c.id + '/copy')
    .set('Authorization', 'Bearer ' + token)
    .set('Idempotency-Key', 'copy-materials-key')
    .send({ name: '独立副本' })
  assert.equal(copy.status, 201, copy.text)
  const original = db.prepare('SELECT * FROM materials WHERE course_id=? ORDER BY id').all(c.id),
    cloned = db.prepare('SELECT * FROM materials WHERE course_id=? ORDER BY id').all(copy.body.id)
  assert.equal(cloned.length, 2)
  assert.notEqual(original[0].file_url, cloned[0].file_url)
  assert.equal(fs.readFileSync(diskPath(cloned[0].file_url), 'utf8'), '资料一')
  await call('teacher', 'delete', '/materials/' + original[0].id)
  processCleanupBatch()
  assert.equal(fs.readFileSync(diskPath(cloned[0].file_url), 'utf8'), '资料一')
  const count = db.prepare('SELECT count(*) n FROM courses').get().n
  const realCopy = fs.copyFileSync
  let calls = 0
  fs.copyFileSync = (...args) => {
    calls++
    if (calls === 2) throw new Error('simulated disk failure')
    return realCopy(...args)
  }
  try {
    const failed = await request(app)
      .post('/api/courses/' + copy.body.id + '/copy')
      .set('Authorization', 'Bearer ' + token)
      .set('Idempotency-Key', 'copy-failure-key')
      .send({ name: '不应留下半成品' })
    assert.equal(failed.status, 500)
    assert.equal(db.prepare('SELECT count(*) n FROM courses').get().n, count)
    assert.equal(
      db.prepare("SELECT state FROM operation_requests WHERE request_id='copy-failure-key'").get()
        .state,
      'failed',
    )
  } finally {
    fs.copyFileSync = realCopy
  }
})
test('failed receipt transaction preserves old file and attempt count; concurrent final attempt admits one', async () => {
  const { c } = await fixture(),
    a = await assignment(c),
    token = await login('alice')
  const upload = (key, value, base = 0) =>
    request(app)
      .post('/api/assignments/' + a.id + '/submit')
      .set('Authorization', 'Bearer ' + token)
      .set('Idempotency-Key', key)
      .field('base_version', String(base))
      .attach('file', Buffer.from(value), { filename: 'answer.txt' })
  const first = await upload('rollback-original', 'original')
  assert.equal(first.status, 201)
  const old = db.prepare('SELECT * FROM submissions WHERE id=?').get(first.body.id)
  db.exec(
    "CREATE TRIGGER reject_receipt BEFORE INSERT ON submission_receipts BEGIN SELECT RAISE(ABORT,'test receipt failure'); END",
  )
  try {
    const failed = await upload('rollback-failure', 'new', 1)
    assert.equal(failed.status, 500)
    const row = db.prepare('SELECT * FROM submissions WHERE id=?').get(first.body.id)
    assert.deepEqual(row, old)
    assert.equal(fs.readFileSync(diskPath(old.file_url), 'utf8'), 'original')
  } finally {
    db.exec('DROP TRIGGER reject_receipt')
  }
  await submissionAction('teacher', 'grade', a.id, first.body.api_base, {
    score: 99,
    comment: '评分后锁定',
  })
  const final = await assignment(c, { allow_resubmit_count: 0 })
  const race = await Promise.all([
    submit('alice', final, 'final-attempt-one'),
    submit('alice', final, 'final-attempt-two'),
  ])
  assert.deepEqual(race.map((r) => r.status).sort(), [201, 409])
  assert.equal(
    db.prepare('SELECT submit_count FROM submissions WHERE assignment_id=?').get(final.id)
      .submit_count,
    1,
  )
})
test('group empty rows retain members; group package includes each available history only once; archive denies grading', async () => {
  const { a, c } = await groupFixture()
  const before = await submissionRows('teacher', a.id)
  assert.equal(before.length, 1)
  assert.equal(before[0].members.length, 2)
  assert.equal(before[0].id, null)
  await call('teacher', 'put', '/assignments/' + a.id, {
    submission_mode: 'append',
  })
  const first = await submit('alice', a, 'group-package-one', 'first')
  assert.equal(first.status, 201, first.text)
  await call('teacher', 'post', first.body.api_base + '/grade', { score: 20 }, 404)
  await call(
    'teacher',
    'post',
    first.body.api_base + '/return',
    { returned_reason: '旧路由不再支持' },
    404,
  )
  const second = await submit('alice', a, 'group-package-two', 'second', 1)
  assert.equal(second.status, 201, second.text)
  const zip = await request(app)
    .get('/api/assignments/' + a.id + '/package')
    .set('Authorization', 'Bearer ' + (await login('teacher')))
    .buffer(true)
    .parse((r, cb) => {
      const list = []
      r.on('data', (c) => list.push(c))
      r.on('end', () => cb(null, Buffer.concat(list)))
    })
  assert.equal(zip.status, 200)
  let end = -1
  for (let i = zip.body.length - 22; i >= 0; i--)
    if (zip.body.readUInt32LE(i) === 0x06054b50) {
      end = i
      break
    }
  assert.ok(end >= 0)
  assert.equal(zip.body.readUInt16LE(end + 10), 2)
  await call('teacher', 'post', '/courses/' + c.id + '/archive')
  const item = submissionItem(first.body.api_base)
  await call(
    'teacher',
    'post',
    `/assignments/${a.id}/batch-grade`,
    { score: 20, items: [item] },
    409,
  )
  await call(
    'teacher',
    'post',
    `/assignments/${a.id}/batch-return`,
    { returned_reason: '不能退回', items: [item] },
    409,
  )
  assert.equal((await call('bob', 'get', first.body.api_base + '/receipts')).length, 2)
})
test('closing keeps pending extensions rejectable but not approvable; document assignments require a file', async () => {
  const { c } = await fixture()
  const doc = await call(
    'teacher',
    'post',
    '/courses/' + c.id + '/assignments',
    {
      title: '文件作业',
      type: 'document',
      status: 'published',
      allow_resubmit_count: -1,
      deadline: '2099-01-01 00:00:00',
    },
    201,
  )
  const textOnly = await submit('alice', doc, 'doc-text-only')
  assert.equal(textOnly.status, 400, textOnly.text)
  const withFile = await request(app)
    .post('/api/assignments/' + doc.id + '/submit')
    .set('Authorization', 'Bearer ' + (await login('alice')))
    .set('Idempotency-Key', 'doc-file-key')
    .attach('file', Buffer.from('ok'), { filename: '答案.pdf' })
  assert.equal(withFile.status, 201, withFile.text)
  const a = await assignment(c)
  const e = await call(
    'alice',
    'post',
    '/assignments/' + a.id + '/extensions',
    { reason: '关闭前申请', requested_deadline: '2099-03-01 00:00:00' },
    201,
  )
  await call('teacher', 'post', '/assignments/' + a.id + '/close')
  await call('teacher', 'post', '/extensions/' + e.id + '/decision', { status: 'approved' }, 409)
  await call('teacher', 'post', '/extensions/' + e.id + '/decision', {
    status: 'rejected',
    decision_reason: '已截止，请下学期重新申请',
  })
  assert.equal(
    (await call('alice', 'get', '/assignments/' + a.id + '/extensions'))[0].status,
    'rejected',
  )
})
test('teacher material retries preserve one row and replacement counts; group deletion cascades histories and receipts', async () => {
  const { c } = await fixture(),
    token = await login('teacher')
  const create = () =>
    request(app)
      .post('/api/courses/' + c.id + '/materials')
      .set('Authorization', 'Bearer ' + token)
      .set('Idempotency-Key', 'teacher-material-once')
      .field('title', '可重试资料')
      .attach('file', Buffer.from('old'), { filename: 'notes.txt' })
  const created = await create(),
    retry = await create()
  assert.equal(created.status, 201)
  assert.equal(retry.status, 200)
  assert.equal(created.body.id, retry.body.id)
  assert.equal(db.prepare('SELECT count(*) n FROM materials WHERE course_id=?').get(c.id).n, 1)
  await request(app)
    .get('/api/materials/' + created.body.id + '/file')
    .set('Authorization', 'Bearer ' + (await login('alice')))
    .expect(200)
  const replace = () =>
    request(app)
      .put('/api/materials/' + created.body.id)
      .set('Authorization', 'Bearer ' + token)
      .set('Idempotency-Key', 'teacher-replace-once')
      .field('title', '可重试资料')
      .attach('file', Buffer.from('new'), { filename: 'notes.txt' })
  const changed = await replace()
  assert.equal(changed.status, 200)
  assert.equal((await replace()).status, 200)
  assert.equal(changed.body.download_count, 1)
  const gf = await groupFixture(),
    submitted = await submit('alice', gf.a, 'delete-group-once', '组答案')
  assert.equal(submitted.status, 201)
  const gid = db.prepare('SELECT id FROM assignment_groups WHERE assignment_id=?').get(gf.a.id).id
  await call('teacher', 'delete', '/assignments/' + gf.a.id)
  assert.equal(
    db.prepare('SELECT count(*) n FROM group_submissions WHERE assignment_group_id=?').get(gid).n,
    0,
  )
  assert.equal(
    db.prepare('SELECT count(*) n FROM submission_receipts WHERE assignment_id=?').get(gf.a.id).n,
    0,
  )
  assert.deepEqual(db.pragma('foreign_key_check'), [])
})
test('teacher ordering reaches students and assignment cards expose progress counts', async () => {
  const { c } = await fixture()
  const first = await assignment(c, { title: '先创建' }),
    second = await assignment(c, { title: '后创建' })
  let teacher = await call('teacher', 'get', '/courses/' + c.id + '/assignments')
  assert.deepEqual(
    teacher.slice(0, 2).map((a) => a.id),
    [second.id, first.id],
  )
  await call('teacher', 'post', '/assignments/' + second.id + '/move', {
    direction: 'down',
  })
  teacher = await call('teacher', 'get', '/courses/' + c.id + '/assignments')
  assert.deepEqual(
    teacher.slice(0, 2).map((a) => a.id),
    [first.id, second.id],
  )
  assert.deepEqual(
    (await call('alice', 'get', '/courses/' + c.id + '/assignments')).slice(0, 2).map((a) => a.id),
    [first.id, second.id],
  )
  await submit('alice', first, 'ordered-progress')
  const progress = (await call('teacher', 'get', '/courses/' + c.id + '/assignments')).find(
    (a) => a.id === first.id,
  )
  assert.equal(progress.expected_count, 3)
  assert.equal(progress.unsubmitted_count, 2)
  assert.equal(progress.pending_review_count, 1)
  const n1 = await call(
      'teacher',
      'post',
      '/courses/' + c.id + '/notices',
      { title: '通知一', status: 'published' },
      201,
    ),
    n2 = await call(
      'teacher',
      'post',
      '/courses/' + c.id + '/notices',
      { title: '通知二', status: 'published' },
      201,
    )
  await call('teacher', 'post', '/notices/' + n2.id + '/move', {
    direction: 'down',
  })
  assert.deepEqual(
    (await call('alice', 'get', '/courses/' + c.id + '/notices')).slice(0, 2).map((n) => n.id),
    [n1.id, n2.id],
  )
  const q1 = await call(
      'alice',
      'post',
      '/courses/' + c.id + '/questions',
      { title: '问题一', content: '一' },
      201,
    ),
    q2 = await call(
      'bob',
      'post',
      '/courses/' + c.id + '/questions',
      { title: '问题二', content: '二' },
      201,
    )
  await call(
    'teacher',
    'post',
    '/questions/' + q1.id + '/publish',
    { summary: '公开一', reply: '答复一' },
    201,
  )
  await call(
    'teacher',
    'post',
    '/questions/' + q2.id + '/publish',
    { summary: '公开二', reply: '答复二' },
    201,
  )
  const publicRows = await call('teacher', 'get', '/courses/' + c.id + '/questions/public'),
    secondPublication = publicRows.find((p) => p.question_id === q2.id)
  await call(
    'teacher',
    'post',
    '/questions/' + q2.id + '/publications/' + secondPublication.id + '/move',
    { direction: 'down' },
  )
  assert.deepEqual(
    (await call('alice', 'get', '/courses/' + c.id + '/questions/public')).map((p) => p.summary),
    ['公开一', '公开二'],
  )
})
test('teacher pending-review counts exclude test students and test-only groups', async () => {
  const { c } = await fixture()
  await call(
    'teacher',
    'post',
    '/courses/' + c.id + '/students',
    { username: 'review_tester', name: '测试员账号' },
    201,
  )
  const individual = await assignment(c)
  await submit('alice', individual, 'review-real-student')
  await submit('review_tester', individual, 'review-test-student')
  let progress = (await call('teacher', 'get', '/courses/' + c.id + '/assignments')).find(
    (row) => row.id === individual.id,
  )
  assert.equal(progress.pending_review_count, 1)
  const nearest = await assignment(c, {
    title: '最近截止作业',
    deadline: '2098-01-01 00:00:00',
  })
  await submit('alice', nearest, 'review-nearest-real-student')
  await submit('review_tester', nearest, 'review-nearest-test-student')
  const courseSummary = (await call('teacher', 'get', '/courses')).find((row) => row.id === c.id)
  assert.equal(courseSummary.student_count, 3)
  assert.equal(courseSummary.latest_assignment_id, nearest.id)
  assert.equal(courseSummary.latest_assignment_title, '最近截止作业')
  assert.equal(courseSummary.latest_expected_count, 3)
  assert.equal(courseSummary.latest_unsubmitted_count, 2)
  assert.equal(courseSummary.pending_review_count, 2)
  assert.equal((await call('teacher', 'get', '/courses/' + c.id)).student_count, 3)

  const f = await fixture()
  await call(
    'teacher',
    'post',
    '/courses/' + f.c.id + '/students',
    { username: 'group_review_tester', name: '测试员账号' },
    201,
  )
  const testerId = db.prepare("SELECT id FROM users WHERE username='group_review_tester'").get().id
  const realGroup = await call(
    'teacher',
    'post',
    '/courses/' + f.c.id + '/groups',
    { name: '真实组', member_ids: [f.alice, f.bob], leader_id: f.alice },
    201,
  )
  const testerGroup = await call(
    'teacher',
    'post',
    '/courses/' + f.c.id + '/groups',
    { name: '测试组', member_ids: [testerId], leader_id: testerId },
    201,
  )
  const groupAssignment = await assignment(f.c, {
    work_mode: 'group',
    status: 'draft',
  })
  await call('teacher', 'post', '/assignments/' + groupAssignment.id + '/groups/snapshot', {
    group_ids: [realGroup.id, testerGroup.id],
  })
  await call('teacher', 'post', '/assignments/' + groupAssignment.id + '/publish')
  await submit('alice', groupAssignment, 'review-real-group')
  await submit('group_review_tester', groupAssignment, 'review-test-group')
  progress = (await call('teacher', 'get', '/courses/' + f.c.id + '/assignments')).find(
    (row) => row.id === groupAssignment.id,
  )
  assert.equal(progress.pending_review_count, 1)
  const groupSummary = (await call('teacher', 'get', '/courses')).find((row) => row.id === f.c.id)
  assert.equal(groupSummary.student_count, 3)
  assert.equal(groupSummary.latest_expected_count, 1)
  assert.equal(groupSummary.latest_unsubmitted_count, 0)
  assert.equal(groupSummary.pending_review_count, 1)
})
test('teacher may change submission requirements without hiding earlier work', async () => {
  const { c } = await fixture()
  const assignmentRow = await call(
    'teacher',
    'post',
    '/courses/' + c.id + '/assignments',
    {
      title: '原要求',
      type: 'document',
      status: 'published',
      allow_resubmit_count: -1,
      max_file_mb: 200,
      allowed_extensions: 'dwg',
    },
    201,
  )
  const submitted = await request(app)
    .post('/api/assignments/' + assignmentRow.id + '/submit')
    .set('Authorization', 'Bearer ' + (await login('alice')))
    .set('Idempotency-Key', 'requirements-before-change')
    .attach('file', Buffer.from('old drawing'), { filename: '成果.dwg' })
  assert.equal(submitted.status, 201, submitted.text)
  const changed = await call('teacher', 'put', '/assignments/' + assignmentRow.id, {
    title: '新要求',
    description: '之后改为在线提交',
    type: 'online',
    submission_mode: 'append',
    max_file_mb: 10,
    total_score: 60,
    require_preview_image: false,
  })
  assert.equal(changed.type, 'online')
  assert.equal(changed.total_score, 60)
  const rows = await submissionRows('teacher', assignmentRow.id),
    alice = rows.find((row) => row.username === 'alice')
  assert.equal(alice.id, submitted.body.id)
  assert.equal(alice.files.length, 1)
  assert.ok(alice.files[0].file_name.endsWith('.dwg'))
})
test('removing a student deletes course-owned records and physical preview files', async () => {
  const { c, alice } = await fixture()
  const a = await call(
    'teacher',
    'post',
    '/courses/' + c.id + '/assignments',
    {
      title: '清理测试',
      type: 'document',
      status: 'published',
      allow_resubmit_count: -1,
      deadline: '2099-01-01 00:00:00',
      require_preview_image: true,
      preview_max_count: 2,
    },
    201,
  )
  const submitted = await submitWithPreviews('alice', a, 'remove-preview', [PNG_1PX])
  assert.equal(submitted.status, 201, submitted.text)
  await call(
    'alice',
    'post',
    '/courses/' + c.id + '/questions',
    { title: '待清理问题', content: '内容' },
    201,
  )
  const notice = await call(
    'teacher',
    'post',
    '/courses/' + c.id + '/notices',
    { title: '阅读记录', status: 'published' },
    201,
  )
  await call('alice', 'post', '/notices/' + notice.id + '/read', {})
  const stored = db.prepare('SELECT file_url FROM submissions WHERE id=?').get(submitted.body.id)
  const preview = db
    .prepare(
      'SELECT file_url,thumbnail_url FROM submission_preview_images WHERE submission_history_id=(SELECT id FROM submission_history WHERE submission_id=? ORDER BY id DESC LIMIT 1)',
    )
    .get(submitted.body.id)
  const impact = await call(
    'teacher',
    'get',
    '/courses/' + c.id + '/students/' + alice + '/removal-impact',
  )
  assert.equal(impact.submissions, 1)
  assert.equal(impact.previews, 1)
  assert.equal(impact.questions, 1)
  const physicalFiles = [stored.file_url, preview.file_url, preview.thumbnail_url].map((key) => {
    assert.ok(key, '删除前必须存在源文件、原图和缩略图引用')
    const file = diskPath(key)
    assert.ok(file && path.isAbsolute(file))
    assert.equal(fs.existsSync(file), true, '删除前物理文件必须存在')
    return file
  })
  await call('teacher', 'delete', '/courses/' + c.id + '/students/' + alice)
  assert.equal(
    db
      .prepare('SELECT count(*) count FROM submissions WHERE student_id=? AND assignment_id=?')
      .get(alice, a.id).count,
    0,
  )
  assert.equal(
    db
      .prepare('SELECT count(*) count FROM course_questions WHERE course_id=? AND student_id=?')
      .get(c.id, alice).count,
    0,
  )
  assert.equal(
    db
      .prepare('SELECT count(*) count FROM notice_reads WHERE notice_id=? AND student_id=?')
      .get(notice.id, alice).count,
    0,
  )
  processCleanupBatch()
  for (const file of physicalFiles)
    assert.equal(fs.existsSync(file), false, `删除后文件仍残留：${file}`)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
})
test('group preview history uses the group history id and enforces course membership', async () => {
  const { c, alice, bob, cara } = await fixture()
  const group = await call(
    'teacher',
    'post',
    '/courses/' + c.id + '/groups',
    { name: '看图组', member_ids: [alice, bob], leader_id: alice },
    201,
  )
  const assignmentRow = await call(
    'teacher',
    'post',
    '/courses/' + c.id + '/assignments',
    {
      title: '小组图片',
      type: 'document',
      status: 'draft',
      work_mode: 'group',
      allow_resubmit_count: -1,
      deadline: '2099-01-01 00:00:00',
      require_preview_image: true,
    },
    201,
  )
  await call('teacher', 'post', '/assignments/' + assignmentRow.id + '/groups/snapshot', {
    group_ids: [group.id],
  })
  await call('teacher', 'post', '/assignments/' + assignmentRow.id + '/publish')
  const submitted = await submitWithPreviews('alice', assignmentRow, 'group-preview-history', [
    PNG_1PX,
  ])
  assert.equal(submitted.status, 201, submitted.text)
  const historyId = db
    .prepare('SELECT id FROM group_submission_history WHERE group_submission_id=?')
    .get(submitted.body.id).id
  const visible = await call('bob', 'get', '/group-submission-history/' + historyId + '/previews')
  assert.equal(visible.length, 1)
  await call('cara', 'get', '/group-submission-history/' + historyId + '/previews', undefined, 403)
  const image = visible[0]
  const tickets = await call('bob', 'post', '/previews/view-ticket', { ids: [image.id] })
  const ticketUrl = tickets.tickets[image.id].file
  assert.equal((await request(app).get(ticketUrl)).status, 200)
  await call('cara', 'get', '/group-submission-previews/' + image.id + '/file', undefined, 403)
  await call('cara', 'post', '/previews/view-ticket', { ids: [image.id] }, 403)
  db.prepare("UPDATE assignments SET status='draft' WHERE id=?").run(assignmentRow.id)
  assert.equal((await request(app).get(ticketUrl)).status, 404)
  db.prepare("UPDATE assignments SET status='published' WHERE id=?").run(assignmentRow.id)
  db.prepare('DELETE FROM course_students WHERE course_id=? AND student_id=?').run(c.id, bob)
  assert.equal((await request(app).get(ticketUrl)).status, 403)
})

test('资料顺序持久保存、学生同步、课程复制保序并限制归档修改', async () => {
  const { c } = await fixture()
  const token = await login('teacher')
  const ids = []
  for (const title of ['第一份', '第二份', '第三份']) {
    const response = await request(app)
      .post(`/api/courses/${c.id}/materials`)
      .set('Authorization', 'Bearer ' + token)
      .field('title', title)
      .attach('file', Buffer.from(title), { filename: 'notes.txt' })
    assert.equal(response.status, 201, response.text)
    ids.push(response.body.id)
  }
  const list = () => call('teacher', 'get', `/courses/${c.id}/materials`)
  assert.deepEqual(
    (await list()).map((row) => row.id),
    [ids[2], ids[1], ids[0]],
  )
  const original = await list()
  await call('teacher', 'post', `/materials/${ids[0]}/move`, { direction: 'up' })
  const ordered = await list()
  assert.deepEqual(
    ordered.map((row) => row.id),
    [ids[2], ids[0], ids[1]],
  )
  assert.deepEqual(
    (await call('alice', 'get', `/courses/${c.id}/materials`)).map((row) => row.id),
    ordered.map((row) => row.id),
  )
  for (const row of ordered) {
    const prior = original.find((item) => item.id === row.id)
    assert.equal(row.created_at, prior.created_at)
    assert.equal(row.download_count, prior.download_count)
  }
  await call('teacher', 'post', `/materials/${ids[2]}/move`, { direction: 'up' })
  assert.deepEqual(
    (await list()).map((row) => row.id),
    ordered.map((row) => row.id),
  )
  await call('alice', 'post', `/materials/${ids[0]}/move`, { direction: 'up' }, 403)
  const copied = await call('teacher', 'post', `/courses/${c.id}/copy`, { name: '顺序复制' }, 201)
  assert.deepEqual(
    (await call('teacher', 'get', `/courses/${copied.id}/materials`)).map((row) => row.title),
    ordered.map((row) => row.title),
  )
  await call('teacher', 'post', `/courses/${c.id}/archive`)
  await call('teacher', 'post', `/materials/${ids[0]}/move`, { direction: 'down' }, 409)
})

test('预览原图内嵌响应与明确下载兼容，缩略图存在但原文件缺失时返回可辨认的错误', async () => {
  const { c } = await fixture()
  const a = await assignment(c, {
    type: 'document',
    require_preview_image: 1,
    preview_max_count: 2,
  })
  const uploaded = await submitWithPreviews('alice', a, 'inline-preview-' + c.id, [PNG_1PX])
  assert.equal(uploaded.status, 201, uploaded.text)
  const rows = await submissionRows('teacher', a.id)
  const preview = rows.find((row) => row.id === uploaded.body.id).previews[0]
  const token = await login('teacher')
  const inline = await request(app)
    .get(preview.preview)
    .set('Authorization', 'Bearer ' + token)
  assert.equal(inline.status, 200)
  assert.match(inline.headers['content-type'], /^image\/png/)
  assert.equal(inline.headers['content-disposition'], 'inline')
  assert.deepEqual(inline.body, PNG_1PX)
  const download = await request(app)
    .get(preview.preview + '?download=1')
    .set('Authorization', 'Bearer ' + token)
  assert.match(download.headers['content-disposition'], /^attachment/)
  const stored = db.prepare('SELECT * FROM submission_preview_images WHERE id=?').get(preview.id)
  db.prepare('UPDATE submission_preview_images SET file_url=? WHERE id=?').run(
    'previews/nonexistent-original.png',
    preview.id,
  )
  try {
    const { tickets } = await call('teacher', 'post', '/previews/view-ticket', {
      ids: [preview.id],
    })
    assert.ok(tickets[preview.id])
    const thumbnail = await request(app).get(tickets[preview.id].thumbnail)
    assert.equal(thumbnail.status, 200)
    const missing = await request(app).get(tickets[preview.id].file)
    assert.equal(missing.status, 404)
    assert.match(missing.body.message, /预览图文件不存在/)
  } finally {
    db.prepare('UPDATE submission_preview_images SET file_url=? WHERE id=?').run(
      stored.file_url,
      preview.id,
    )
  }
})

test('退回原因显示在本人课程作业卡片，其他学生不能串读', async () => {
  const { c } = await fixture()
  const a = await assignment(c)
  const saved = await call('alice', 'post', `/assignments/${a.id}/submit`, { content: '答案' }, 201)
  await submissionAction('teacher', 'return', a.id, saved.api_base, {
    returned_reason: '请补充设计依据',
  })
  const own = await call('alice', 'get', `/courses/${c.id}/assignments`)
  const other = await call('bob', 'get', `/courses/${c.id}/assignments`)
  assert.equal(own.find((row) => row.id === a.id).returned_reason, '请补充设计依据')
  assert.ok(!JSON.stringify(other).includes('请补充设计依据'))
})
