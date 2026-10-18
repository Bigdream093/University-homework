import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import bcrypt from 'bcryptjs'
import request from 'supertest'
import ExcelJS from 'exceljs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mohen-api-'))
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-secret'
process.env.DATA_DIR = dataDir
process.env.UPLOAD_DIR = path.join(dataDir, 'uploads')
fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true })
const { app } = await import('../src/index.js')
const { db } = await import('../src/db.js')
db.prepare(`INSERT INTO users(username,password_hash,name,role) VALUES(?,?,?,'student')`).run(
  '20260001',
  bcrypt.hashSync('123456', 4),
  '演示学生',
)

after(() => {
  db.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('health endpoint is available', async () => {
  const response = await request(app).get('/api/health')
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  const sourcePackage = JSON.parse(
    fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  )
  assert.equal(response.body.version, sourcePackage.version)
  assert.equal(response.body.build.version, sourcePackage.version)
  assert.ok(
    response.body.build.source_sha256 === null ||
      /^[a-f0-9]{64}$/.test(response.body.build.source_sha256),
  )
})

test('teacher can log in and access courses', async () => {
  const login = await request(app)
    .post('/api/auth/login')
    .send({ username: 'teacher', password: '123456' })
  assert.equal(login.status, 200)
  assert.equal(login.body.user.role, 'teacher')
  const courses = await request(app)
    .get('/api/courses')
    .set('Authorization', `Bearer ${login.body.token}`)
  assert.equal(courses.status, 200)
  assert.ok(Array.isArray(courses.body))
})

test('student cannot access teacher course management', async () => {
  const login = await request(app)
    .post('/api/auth/login')
    .send({ username: '20260001', password: '123456' })
  const response = await request(app)
    .get('/api/courses')
    .set('Authorization', `Bearer ${login.body.token}`)
  assert.equal(response.status, 403)
})

test('invalid token is rejected', async () => {
  const response = await request(app).get('/api/my/courses').set('Authorization', 'Bearer invalid')
  assert.equal(response.status, 401)
})

test('complete workflow: course, assignment, submit, grade and privacy boundary', async () => {
  const teacherLogin = await request(app)
    .post('/api/auth/login')
    .send({ username: 'teacher', password: '123456' })
  const studentLogin = await request(app)
    .post('/api/auth/login')
    .send({ username: '20260001', password: '123456' })
  const teacherToken = teacherLogin.body.token,
    studentToken = studentLogin.body.token
  const absentUsername = `2026${String(Date.now()).slice(-8)}`
  const absentStudentId = db
    .prepare(`INSERT INTO users(username,password_hash,name,role) VALUES(?,?,?,'student')`)
    .run(absentUsername, bcrypt.hashSync('123456', 4), '未交学生').lastInsertRowid

  const course = await request(app)
    .post('/api/courses')
    .set('Authorization', `Bearer ${teacherToken}`)
    .send({
      name: `自动测试课程-${Date.now()}`,
      code: 'TEST',
      description: '自动化完整流程',
    })
  assert.equal(course.status, 201)

  const addStudent = await request(app)
    .post(`/api/courses/${course.body.id}/students`)
    .set('Authorization', `Bearer ${teacherToken}`)
    .send({ username: '20260001', name: '演示学生' })
  assert.ok([200, 201].includes(addStudent.status))
  const addAbsentStudent = await request(app)
    .post(`/api/courses/${course.body.id}/students`)
    .set('Authorization', `Bearer ${teacherToken}`)
    .send({ username: absentUsername, name: '未交学生' })
  assert.ok([200, 201].includes(addAbsentStudent.status))

  const assignment = await request(app)
    .post(`/api/courses/${course.body.id}/assignments`)
    .set('Authorization', `Bearer ${teacherToken}`)
    .send({
      title: '在线测试作业',
      type: 'online',
      total_score: 100,
      allow_resubmit_count: 1,
      status: 'published',
    })
  assert.equal(assignment.status, 201)

  const policy = await request(app)
    .get(`/api/assignments/${assignment.body.id}/submission-policy`)
    .set('Authorization', `Bearer ${studentToken}`)
  assert.equal(policy.status, 200)
  assert.equal(typeof policy.body.is_late, 'boolean')
  assert.equal(policy.body.can_submit, true)

  const submit = await request(app)
    .post(`/api/assignments/${assignment.body.id}/submit`)
    .set('Authorization', `Bearer ${studentToken}`)
    .send({ content: '这是学生的在线作答。' })
  assert.equal(submit.status, 201)

  const list = await request(app)
    .get(`/api/assignments/${assignment.body.id}/submissions`)
    .set('Authorization', `Bearer ${teacherToken}`)
  assert.equal(list.status, 200)
  assert.equal(list.body.page, 1)
  assert.equal(list.body.page_size, 50)
  const record = list.body.rows.find((row) => row.username === '20260001')
  assert.ok(record?.id)

  const removedSingleGrade = await request(app)
    .post(`/api/submissions/${record.id}/grade`)
    .set('Authorization', `Bearer ${teacherToken}`)
    .send({ score: 92 })
  assert.equal(removedSingleGrade.status, 404)
  const removedSingleReturn = await request(app)
    .post(`/api/submissions/${record.id}/return`)
    .set('Authorization', `Bearer ${teacherToken}`)
    .send({ returned_reason: '旧路由不再支持' })
  assert.equal(removedSingleReturn.status, 404)

  const paged = await request(app)
    .get(`/api/assignments/${assignment.body.id}/submissions?page=1&page_size=1`)
    .set('Authorization', `Bearer ${teacherToken}`)
  assert.equal(paged.status, 200)
  assert.equal(paged.body.total, 2)
  assert.equal(paged.body.rows.length, 1)
  assert.equal(paged.body.counts.submitted, 1)

  const inbox = await request(app)
    .get('/api/teacher/pending-reviews?page=1&page_size=20')
    .set('Authorization', `Bearer ${teacherToken}`)
  assert.equal(inbox.status, 200)
  assert.equal(inbox.body.total, 1)
  assert.equal(inbox.body.rows[0].assignment_id, assignment.body.id)

  for (const score of [null, '']) {
    const emptyGrade = await request(app)
      .post(`/api/assignments/${assignment.body.id}/batch-grade`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ score, items: [{ id: record.id, kind: 'individual' }] })
    assert.equal(emptyGrade.status, 200)
    assert.equal(emptyGrade.body.failure_count, 1)
    assert.equal(emptyGrade.body.results[0].success, false)
  }
  const zeroGrade = await request(app)
    .post(`/api/assignments/${assignment.body.id}/batch-grade`)
    .set('Authorization', `Bearer ${teacherToken}`)
    .send({ score: 0, items: [{ id: record.id, kind: 'individual' }] })
  assert.equal(zeroGrade.status, 200)
  assert.equal(zeroGrade.body.success_count, 1)

  const grade = await request(app)
    .post(`/api/assignments/${assignment.body.id}/batch-grade`)
    .set('Authorization', `Bearer ${teacherToken}`)
    .send({
      score: 92,
      comment: '完成良好',
      items: [
        {
          id: record.id,
          kind: 'individual',
          expected_status: 'graded',
          expected_submit_count: record.submit_count,
        },
      ],
    })
  assert.equal(grade.status, 200)
  assert.equal(grade.body.success_count, 1)

  const batchGrade = await request(app)
    .post(`/api/assignments/${assignment.body.id}/batch-grade`)
    .set('Authorization', `Bearer ${teacherToken}`)
    .send({
      score: 0,
      comment: '批量核验',
      items: [
        {
          id: record.id,
          kind: 'individual',
          expected_status: 'graded',
          expected_submit_count: record.submit_count,
        },
        { student_id: absentStudentId, kind: 'individual' },
      ],
    })
  assert.equal(batchGrade.status, 200)
  assert.equal(batchGrade.body.success_count, 2)
  const rowsAfterBatch = await request(app)
    .get(`/api/assignments/${assignment.body.id}/submissions`)
    .set('Authorization', `Bearer ${teacherToken}`)
  const absenceRow = rowsAfterBatch.body.rows.find((row) => row.student_id === absentStudentId)
  assert.equal(absenceRow.id, null)
  assert.equal(absenceRow.absence_graded, true)
  assert.equal(absenceRow.score, 0)

  const absentStudentLogin = await request(app)
    .post('/api/auth/login')
    .send({ username: absentUsername, password: '123456' })
  const absentSubmission = await request(app)
    .get(`/api/assignments/${assignment.body.id}/my-submission`)
    .set('Authorization', `Bearer ${absentStudentLogin.body.token}`)
  assert.equal(absentSubmission.body, null)

  const studentView = await request(app)
    .get(`/api/assignments/${assignment.body.id}/my-submission`)
    .set('Authorization', `Bearer ${studentToken}`)
  assert.equal(studentView.body.status, 'graded')
  assert.equal(Object.hasOwn(studentView.body, 'score'), false)
  assert.equal(Object.hasOwn(studentView.body, 'comment'), false)

  const exported = await request(app)
    .get(`/api/assignments/${assignment.body.id}/export`)
    .set('Authorization', `Bearer ${teacherToken}`)
  assert.equal(exported.status, 200)
  assert.match(exported.headers['content-type'], /spreadsheetml/)

  const batchReturn = await request(app)
    .post(`/api/assignments/${assignment.body.id}/batch-return`)
    .set('Authorization', `Bearer ${teacherToken}`)
    .send({
      returned_reason: '请补充说明',
      items: [
        {
          id: record.id,
          kind: 'individual',
          expected_status: 'graded',
          expected_submit_count: record.submit_count,
        },
      ],
    })
  assert.equal(batchReturn.status, 200)
  assert.equal(batchReturn.body.success_count, 1)

  await request(app)
    .delete(`/api/courses/${course.body.id}`)
    .set('Authorization', `Bearer ${teacherToken}`)
})

const near = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `期望 ${expected}，实际 ${actual}`)

test('grade summary: config validation, weighted scores, regrade and export in roster order', async () => {
  const teacherLogin = await request(app)
    .post('/api/auth/login')
    .send({ username: 'teacher', password: '123456' })
  const teacherToken = teacherLogin.body.token
  const auth = (t) => ({ Authorization: `Bearer ${t}` })

  const course = await request(app)
    .post('/api/courses')
    .set(auth(teacherToken))
    .send({
      name: `汇总课程-${Date.now()}`,
      code: 'SUM',
      description: '成绩汇总测试',
    })
  assert.equal(course.status, 201)
  const courseId = course.body.id

  // 依次加入两名学生，名单原序 = 加入顺序。
  await request(app)
    .post(`/api/courses/${courseId}/students`)
    .set(auth(teacherToken))
    .send({ username: '20260101', name: '甲一' })
  await request(app)
    .post(`/api/courses/${courseId}/students`)
    .set(auth(teacherToken))
    .send({ username: '20260102', name: '乙二' })

  const mkAssignment = (title, extra = {}) =>
    request(app)
      .post(`/api/courses/${courseId}/assignments`)
      .set(auth(teacherToken))
      .send({
        title,
        type: 'online',
        total_score: 100,
        allow_resubmit_count: 1,
        status: 'published',
        ...extra,
      })
  const a1 = await mkAssignment('作业一')
  const a2 = await mkAssignment('作业二')
  const a3 = await mkAssignment('期末测验')
  const draftAssignment = await mkAssignment('草稿作业', { status: 'draft' })

  // 配置校验：单项占比不能超过 100。
  const badWeight = await request(app)
    .put(`/api/courses/${courseId}/grade-config`)
    .set(auth(teacherToken))
    .send({
      daily_ratio: 40,
      final_ratio: 60,
      grade_absent_mode: 'zero',
      final_assignment_id: a3.body.id,
      weights: [{ assignment_id: a1.body.id, grade_weight: 150 }],
    })
  assert.equal(badWeight.status, 400)

  // 配置校验：平时各项占比之和必须等于平时占比。
  const badRatio = await request(app)
    .put(`/api/courses/${courseId}/grade-config`)
    .set(auth(teacherToken))
    .send({
      daily_ratio: 40,
      final_ratio: 60,
      grade_absent_mode: 'zero',
      final_assignment_id: a3.body.id,
      weights: [
        { assignment_id: a1.body.id, grade_weight: 60 },
        { assignment_id: a2.body.id, grade_weight: 60 },
      ],
    })
  assert.equal(badRatio.status, 400)

  // 草稿作业不能设为期末。
  const draftFinal = await request(app)
    .put(`/api/courses/${courseId}/grade-config`)
    .set(auth(teacherToken))
    .send({
      daily_ratio: 40,
      final_ratio: 60,
      grade_absent_mode: 'zero',
      final_assignment_id: draftAssignment.body.id,
      weights: [],
    })
  assert.equal(draftFinal.status, 400)

  // 保存配置：平时占比 40 / 期末 60；作业一占总成绩 20%、作业二 20%（合计 40 = 平时占比）。
  const saved = await request(app)
    .put(`/api/courses/${courseId}/grade-config`)
    .set(auth(teacherToken))
    .send({
      daily_ratio: 40,
      final_ratio: 60,
      grade_absent_mode: 'zero',
      final_assignment_id: a3.body.id,
      weights: [
        { assignment_id: a1.body.id, grade_weight: 20 },
        { assignment_id: a2.body.id, grade_weight: 20 },
      ],
    })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.config.daily_ratio, 40)
  assert.equal(saved.body.config.final_ratio, 60)

  // 提交与批改：甲一 a1=80 已评分、a2 只交未评；乙二 a1=60；甲一期末 a3=70。
  const s1Login = await request(app)
    .post('/api/auth/login')
    .send({ username: '20260101', password: '123456' })
  const s2Login = await request(app)
    .post('/api/auth/login')
    .send({ username: '20260102', password: '123456' })
  const s1Token = s1Login.body.token,
    s2Token = s2Login.body.token

  const submitAs = (token, assignmentId, content) =>
    request(app)
      .post(`/api/assignments/${assignmentId}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content })
  await submitAs(s1Token, a1.body.id, '甲一作业一')
  await submitAs(s1Token, a2.body.id, '甲一作业二')
  await submitAs(s2Token, a1.body.id, '乙二作业一')
  await submitAs(s1Token, a3.body.id, '甲一期末')

  const gradeAs = async (assignmentId, username, score) => {
    const list = await request(app)
      .get(`/api/assignments/${assignmentId}/submissions`)
      .set(auth(teacherToken))
    const record = list.body.rows.find((row) => row.username === username)
    assert.ok(record?.id)
    const grade = await request(app)
      .post(`/api/assignments/${assignmentId}/batch-grade`)
      .set(auth(teacherToken))
      .send({ score, items: [{ id: record.id, kind: 'individual' }] })
    assert.equal(grade.status, 200)
    assert.equal(grade.body.success_count, 1)
    return record.id
  }
  await gradeAs(a1.body.id, '20260101', 80)
  await gradeAs(a1.body.id, '20260102', 60)
  await gradeAs(a3.body.id, '20260101', 70)

  // 学生无权访问汇总。
  const studentView = await request(app)
    .get(`/api/courses/${courseId}/summary`)
    .set('Authorization', `Bearer ${s1Token}`)
  assert.equal(studentView.status, 403)

  const summary = await request(app).get(`/api/courses/${courseId}/summary`).set(auth(teacherToken))
  assert.equal(summary.status, 200)
  const { students } = summary.body

  // 行序严格等于名单原序。
  assert.deepEqual(
    students.map((s) => s.username),
    ['20260101', '20260102'],
  )

  // 甲一：平时 = (80×20 + 0×20) ÷ 40 = 40；期末 70；总 = 40×0.4 + 70×0.6 = 58。
  near(students[0].scores.daily_score, 40)
  near(students[0].scores.final_score, 70)
  near(students[0].scores.total_score, 58)
  assert.equal(students[0].cells[a2.body.id].status, 'submitted')

  // 乙二：平时 = (60×20 + 未交0×20) ÷ 40 = 30；期末未交 → 无；总暂按平时 30。
  near(students[1].scores.daily_score, 30)
  assert.equal(students[1].scores.final_score, null)
  near(students[1].scores.total_score, 30)

  // 汇总里修改成绩：甲一 a1 80 → 90，平时 (90×20+0×20)÷40 = 45，总 = 45×0.4+70×0.6 = 60。
  const cell = students[0].cells[a1.body.id]
  const regrade = await request(app)
    .post(`/api/assignments/${a1.body.id}/batch-grade`)
    .set(auth(teacherToken))
    .send({
      score: 90,
      items: [
        {
          id: Number(cell.api_base.split('/').at(-1)),
          kind: 'individual',
          expected_status: cell.status,
          expected_submit_count: cell.submit_count,
        },
      ],
    })
  assert.equal(regrade.status, 200)
  assert.equal(regrade.body.success_count, 1)
  const after = await request(app).get(`/api/courses/${courseId}/summary`).set(auth(teacherToken))
  near(after.body.students[0].cells[a1.body.id].score, 90)
  near(after.body.students[0].scores.daily_score, 45)
  near(after.body.students[0].scores.total_score, 60)

  // 导出：行序不变、五列成绩表。
  const exported = await request(app)
    .get(`/api/courses/${courseId}/summary/export`)
    .set(auth(teacherToken))
    .buffer(true)
    .parse((res, callback) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => callback(null, Buffer.concat(chunks)))
      res.on('error', callback)
    })
  assert.equal(exported.status, 200)
  assert.match(exported.headers['content-type'], /spreadsheetml/)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(exported.body)
  const sheet = workbook.getWorksheet('成绩汇总')
  assert.ok(sheet)
  assert.equal(sheet.columnCount, 5)
  assert.equal(sheet.rowCount, 3)
  assert.deepEqual(sheet.getRow(1).values.slice(1), [
    '姓名',
    '学号',
    '平时成绩',
    '期末成绩',
    '总成绩',
  ])
  assert.deepEqual(sheet.getRow(2).values.slice(1), ['甲一', '20260101', 45, 70, 60])
  assert.deepEqual(sheet.getRow(3).values.slice(1), ['乙二', '20260102', 30, '—', 30])
  for (const [row, columns] of [
    [2, [3, 4, 5]],
    [3, [3, 5]],
  ])
    for (const column of columns) assert.equal(typeof sheet.getCell(row, column).value, 'number')

  await request(app).delete(`/api/courses/${courseId}`).set(auth(teacherToken))
})
