import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import bcrypt from 'bcryptjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mohen-submission-policy-'))
process.env.DATA_DIR = dataDir
process.env.UPLOAD_DIR = path.join(dataDir, 'uploads')
fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true })

const { db } = await import('../src/db.js')
const { saveSubmission } = await import('../src/services/submissionLogic.js')
const { saveGradeConfig } = await import('../src/services/summaryService.js')
const { processCleanupBatch } = await import('../src/services/storage.js')
const { toStorageKey } = await import('../src/utils/uploadPath.js')

after(() => {
  db.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('更换或取消期末作业时按本次选择校验权重，非法权重不改写设置', () => {
  const { assignment } = createAssignment('2099-01-01 00:00:00')
  const course = db.prepare('SELECT * FROM courses WHERE id=?').get(assignment.course_id)
  db.prepare('UPDATE assignments SET grade_weight=40 WHERE id=?').run(assignment.id)
  const oldFinalId = Number(
    db
      .prepare(
        "INSERT INTO assignments(course_id,title,type,status,is_final,grade_weight) VALUES(?,'旧期末','online','published',1,0)",
      )
      .run(course.id).lastInsertRowid,
  )
  const config = { daily_ratio: 40, final_ratio: 60, grade_absent_mode: 'zero' }
  saveGradeConfig(course, {
    ...config,
    final_assignment_id: assignment.id,
    weights: [
      { assignment_id: assignment.id, grade_weight: 0 },
      { assignment_id: oldFinalId, grade_weight: 40 },
    ],
  })
  assert.equal(
    db.prepare('SELECT is_final FROM assignments WHERE id=?').get(assignment.id).is_final,
    1,
  )
  assert.equal(
    db.prepare('SELECT is_final FROM assignments WHERE id=?').get(oldFinalId).is_final,
    0,
  )
  assert.throws(
    () =>
      saveGradeConfig(course, {
        ...config,
        final_assignment_id: oldFinalId,
        weights: [{ assignment_id: assignment.id, grade_weight: 39 }],
      }),
    /必须等于平时占比/,
  )
  assert.equal(
    db.prepare('SELECT is_final FROM assignments WHERE id=?').get(assignment.id).is_final,
    1,
  )
  saveGradeConfig(course, {
    ...config,
    final_assignment_id: null,
    weights: [
      { assignment_id: assignment.id, grade_weight: 20 },
      { assignment_id: oldFinalId, grade_weight: 20 },
    ],
  })
  assert.equal(
    db.prepare('SELECT count(*) n FROM assignments WHERE course_id=? AND is_final=1').get(course.id)
      .n,
    0,
  )
})

function createAssignment(deadline) {
  const teacher = db.prepare("SELECT id FROM users WHERE username='teacher'").get()
  const studentId = Number(
    db
      .prepare(
        `INSERT INTO users(username,password_hash,name,role)
    VALUES(?,?,?,'student')`,
      )
      .run(`student-${Date.now()}-${Math.random()}`, bcrypt.hashSync('123456', 4), '张三')
      .lastInsertRowid,
  )
  const courseId = Number(
    db
      .prepare("INSERT INTO courses(name,teacher_id,invite_code) VALUES('提交测试',?,?)")
      .run(teacher.id, Math.random().toString(36).slice(2, 8)).lastInsertRowid,
  )
  db.prepare('INSERT INTO course_students(course_id,student_id,sort_order) VALUES(?,?,1)').run(
    courseId,
    studentId,
  )
  const assignmentId = Number(
    db
      .prepare(
        `INSERT INTO assignments(course_id,title,type,deadline,status)
    VALUES(?,'文件作业','document',?,'published')`,
      )
      .run(courseId, deadline).lastInsertRowid,
  )
  return {
    studentId,
    assignment: db.prepare('SELECT * FROM assignments WHERE id=?').get(assignmentId),
  }
}

test('uploaded display filename includes name, username and submission time, with lateness kept separate', () => {
  const { studentId, assignment } = createAssignment('2099-01-01 00:00:00')
  const username = db.prepare('SELECT username FROM users WHERE id=?').get(studentId).username
  const result = saveSubmission({
    assignment,
    studentId,
    sourceFile: { path: 'internal-safe-path', originalname: '我的最终版本.ZIP', size: 123 },
    content: '',
  })
  assert.match(result.file_name, new RegExp(`^张三_${username}_\\d{2}-\\d{2}-\\d{2}:\\d{2}\\.zip$`))
  assert.doesNotMatch(result.file_name, /_(?:准时|迟交)\./)
  assert.equal(result.is_late, 0)
  const receipt = db
    .prepare('SELECT snapshot_json FROM submission_receipts WHERE receipt_no=?')
    .get(result.receipt_no)
  const snapshot = JSON.parse(receipt.snapshot_json)
  assert.equal(snapshot.file_type, 'zip')
  assert.equal(snapshot.file_size, 123)
})

test('submission remains accepted after deadline and is marked late', () => {
  const { studentId, assignment } = createAssignment('2020-01-01 00:00:00')
  const result = saveSubmission({
    assignment,
    studentId,
    sourceFile: { path: 'late-internal-safe-path', originalname: '迟交.zip', size: 4 },
    content: '',
  })
  assert.equal(result.status, 'submitted')
  assert.equal(result.is_late, 1)
  assert.doesNotMatch(result.file_name, /_(?:准时|迟交)\./)
})

test('a new uploaded file replaces and removes the previous physical file', () => {
  const { studentId, assignment } = createAssignment('2099-01-01 00:00:00')
  const previousPath = path.join(process.env.UPLOAD_DIR, 'previous-file.zip')
  const latestPath = path.join(process.env.UPLOAD_DIR, 'latest-file.zip')
  fs.writeFileSync(previousPath, 'old')
  fs.writeFileSync(latestPath, 'new')

  const first = saveSubmission({
    assignment,
    studentId,
    sourceFile: {
      path: previousPath,
      storageKey: toStorageKey(previousPath),
      originalname: '第一次.zip',
      size: 3,
    },
    content: '',
  })
  const second = saveSubmission({
    assignment,
    studentId,
    sourceFile: {
      path: latestPath,
      storageKey: toStorageKey(latestPath),
      originalname: '第二次.zip',
      size: 3,
    },
    content: '',
    baseVersion: 1,
  })

  assert.equal(first.id, second.id)
  assert.equal(second.submit_count, 2)
  assert.equal(second.file_url, toStorageKey(latestPath))
  processCleanupBatch()
  assert.equal(fs.existsSync(previousPath), false)
  assert.equal(fs.existsSync(latestPath), true)
  const history = db
    .prepare('SELECT file_url,file_state FROM submission_history WHERE submission_id=? ORDER BY id')
    .all(second.id)
  assert.deepEqual(
    history.map((row) => row.file_state),
    ['replaced', 'available'],
  )
  assert.deepEqual(
    history.map((row) => row.file_url),
    [toStorageKey(previousPath), toStorageKey(latestPath)],
  )
})
