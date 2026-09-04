import { Router } from 'express'
import multer from 'multer'
import bcrypt from 'bcryptjs'
import { db, randomInvite } from '../db.js'
import { auth } from '../middleware/auth.js'
import { teacherOnly, studentOnly } from '../middleware/teacher.js'
import { importStudents } from '../services/importStudents.js'
import { deleteCourse } from '../services/deletionService.js'
import { courseAccess, fail } from '../services/access.js'
import { listCourseStudents } from '../services/studentQueries.js'
import { archiveCourse } from '../services/courseService.js'
import { asyncRoute } from '../middleware/error.js'
import { clientAddress, createFailureLimiter, rejectLimited } from '../services/attemptLimiter.js'
import { removalImpact, removeStudent } from '../services/studentRemovalService.js'

const router = Router()
const inviteIdentityAttempts = createFailureLimiter({
  maxFailures: 8,
  baseDelayMs: 1000,
  lockMs: 15 * 60 * 1000,
})
const inviteAddressAttempts = createFailureLimiter({
  maxFailures: 30,
  baseDelayMs: 0,
  lockMs: 15 * 60 * 1000,
})
const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
})
const ownCourse = (id, teacherId) =>
  courseAccess(id, { id: teacherId, role: 'teacher' }, { write: true })
const visibleCourse = (course) => ({
  ...course,
  invite_code: course.status === 'active' ? course.invite_code : null,
})
// 账号类管理不要求课程处于进行中：归档课程里的学生也需要重置密码和启停账号。
const ownStudent = (id, teacherId) =>
  db
    .prepare(
      `SELECT u.id FROM users u
  JOIN course_students cs ON cs.student_id=u.id JOIN courses c ON c.id=cs.course_id
  WHERE u.id=? AND u.role='student' AND c.teacher_id=? LIMIT 1`,
    )
    .get(id, teacherId)

router.get('/courses', auth, teacherOnly, (req, res) => {
  res.json(
    db
      .prepare(
        `SELECT c.*,
    (SELECT count(*) FROM course_students cs WHERE cs.course_id=c.id) student_count,
    (SELECT count(*) FROM assignments a WHERE a.course_id=c.id) assignment_count
    FROM courses c WHERE teacher_id=? ORDER BY c.status='active' DESC,c.created_at DESC`,
      )
      .all(req.user.id)
      .map(visibleCourse),
  )
})

router.post('/courses/:id/archive', auth, teacherOnly, (req, res) =>
  res.json(archiveCourse(req.params.id, req.user)),
)
router.post('/courses/:id/restore', auth, teacherOnly, (req, res) => {
  const course = db
    .prepare('SELECT * FROM courses WHERE id=? AND teacher_id=?')
    .get(req.params.id, req.user.id)
  if (!course) return res.status(404).json({ message: '课程不存在' })
  db.prepare("UPDATE courses SET status='active',archived_at=NULL WHERE id=?").run(course.id)
  res.json({ message: '课程已恢复' })
})

router.post('/courses', auth, teacherOnly, (req, res) => {
  if (!String(req.body.name || '').trim())
    return res.status(400).json({ message: '课程名称不能为空' })
  const info = db
    .prepare(
      "INSERT INTO courses(name,code,description,teacher_id,invite_code,created_at) VALUES(?,?,?,?,?,datetime('now','+08:00'))",
    )
    .run(
      String(req.body.name).trim(),
      String(req.body.code || '').trim(),
      String(req.body.description || '').trim(),
      req.user.id,
      randomInvite(),
    )
  res.status(201).json(db.prepare('SELECT * FROM courses WHERE id=?').get(info.lastInsertRowid))
})

router.get('/courses/:id', auth, (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id=?').get(req.params.id)
  if (!course) return res.status(404).json({ message: '课程不存在' })
  const allowed =
    req.user.role === 'teacher'
      ? course.teacher_id === req.user.id
      : db
          .prepare('SELECT 1 FROM course_students WHERE course_id=? AND student_id=?')
          .get(course.id, req.user.id)
  if (!allowed) return res.status(403).json({ message: '无权访问该课程' })
  res.json(visibleCourse(course))
})

router.put('/courses/:id', auth, teacherOnly, (req, res) => {
  if (!ownCourse(req.params.id, req.user.id)) return res.status(404).json({ message: '课程不存在' })
  const name = String(req.body.name || '').trim()
  if (!name) return res.status(400).json({ message: '课程名称不能为空' })
  db.prepare('UPDATE courses SET name=?,code=?,description=? WHERE id=?').run(
    name,
    String(req.body.code || '').trim(),
    String(req.body.description || '').trim(),
    req.params.id,
  )
  res.json(db.prepare('SELECT * FROM courses WHERE id=?').get(req.params.id))
})

router.delete('/courses/:id', auth, teacherOnly, (req, res) => {
  if (!ownCourse(req.params.id, req.user.id)) return res.status(404).json({ message: '课程不存在' })
  deleteCourse(Number(req.params.id))
  res.json({ message: '课程已删除' })
})

router.post(
  '/courses/:id/students/import',
  auth,
  teacherOnly,
  memoryUpload.single('file'),
  asyncRoute(async (req, res) => {
    if (!ownCourse(req.params.id, req.user.id))
      return res.status(404).json({ message: '课程不存在' })
    if (!req.file) return res.status(400).json({ message: '请选择Excel文件' })
    res.json(await importStudents(req.file.buffer, Number(req.params.id)))
  }),
)

router.get('/courses/:id/students', auth, teacherOnly, (req, res) =>
  res.json(listCourseStudents(req.params.id, req.user)),
)

router.post('/courses/:id/students', auth, teacherOnly, (req, res) => {
  if (!ownCourse(req.params.id, req.user.id)) return res.status(404).json({ message: '课程不存在' })
  const username = String(req.body.username || '').trim(),
    name = String(req.body.name || '').trim()
  if (!username || !name) return res.status(400).json({ message: '学号和姓名不能为空' })
  let user = db.prepare('SELECT * FROM users WHERE username=?').get(username)
  if (!user) {
    const info = db
      .prepare(
        `INSERT INTO users(username,password_hash,name,role,created_at) VALUES(?,?,?,'student',datetime('now','+08:00'))`,
      )
      .run(username, bcrypt.hashSync('123456', 10), name)
    user = { id: info.lastInsertRowid }
  }
  if (user.role && user.role !== 'student') fail(400, '该账号不是学生账号')
  const nextOrder = db
    .prepare('SELECT COALESCE(MAX(sort_order),0)+1 value FROM course_students WHERE course_id=?')
    .get(req.params.id).value
  const info = db
    .prepare(
      "INSERT OR IGNORE INTO course_students(course_id,student_id,sort_order,joined_at) VALUES(?,?,?,datetime('now','+08:00'))",
    )
    .run(req.params.id, user.id, nextOrder)
  res
    .status(info.changes ? 201 : 200)
    .json({ message: info.changes ? '学生已加入课程' : '学生已在课程中' })
})

router.get('/courses/:id/students/:sid/removal-impact', auth, teacherOnly, (req, res) => {
  const course = ownCourse(req.params.id, req.user.id)
  if (!course) fail(404, '课程不存在')
  const impact = removalImpact(course.id, Number(req.params.sid))
  if (!impact) fail(404, '学生不存在')
  res.json(impact)
})

router.delete('/courses/:id/students/:sid', auth, teacherOnly, (req, res) => {
  const course = ownCourse(req.params.id, req.user.id)
  if (!course) fail(404, '课程不存在')
  const removed = removeStudent(course.id, Number(req.params.sid))
  if (!removed) fail(404, '学生不存在')
  res.json({ message: '学生及其课程资料已删除' })
})

router.get('/courses/:id/invite-code', auth, teacherOnly, (req, res) => {
  const course = ownCourse(req.params.id, req.user.id)
  if (!course) return res.status(404).json({ message: '课程不存在' })
  res.json({ invite_code: course.invite_code })
})

router.post('/courses/:id/invite-code', auth, teacherOnly, (req, res) => {
  if (!ownCourse(req.params.id, req.user.id)) return res.status(404).json({ message: '课程不存在' })
  const code = randomInvite()
  db.prepare('UPDATE courses SET invite_code=? WHERE id=?').run(code, req.params.id)
  res.json({ invite_code: code })
})

router.get('/my/courses', auth, studentOnly, (req, res) => {
  res.json(
    db
      .prepare(
        `SELECT c.*,
    (SELECT count(*) FROM assignments a WHERE a.course_id=c.id AND a.status='published') assignment_count
    ,(SELECT count(*) FROM notices n WHERE n.course_id=c.id AND c.status='active' AND n.status='published' AND NOT EXISTS (SELECT 1 FROM notice_reads r WHERE r.notice_id=n.id AND r.student_id=cs.student_id AND r.last_seen_revision>=n.content_revision)) unread_notice_count
    FROM course_students cs JOIN courses c ON c.id=cs.course_id WHERE cs.student_id=? ORDER BY c.status='active' DESC,cs.joined_at DESC`,
      )
      .all(req.user.id)
      .map(visibleCourse),
  )
})

router.post('/courses/join', auth, studentOnly, (req, res) => {
  const address = clientAddress(req),
    identityKey = `${address}:${req.user.id}`
  const identityGate = inviteIdentityAttempts.check(identityKey),
    addressGate = inviteAddressAttempts.check(address)
  if (!identityGate.allowed || !addressGate.allowed)
    return rejectLimited(res, Math.max(identityGate.retryAfter, addressGate.retryAfter))
  const course = db.prepare('SELECT * FROM courses WHERE invite_code=?').get(
    String(req.body.invite_code || '')
      .trim()
      .toUpperCase(),
  )
  if (!course) {
    inviteIdentityAttempts.fail(identityKey)
    inviteAddressAttempts.fail(address)
    return res.status(404).json({ message: '邀请码无效' })
  }
  inviteIdentityAttempts.success(identityKey)
  inviteAddressAttempts.success(address)
  if (course.status !== 'active') return res.status(400).json({ message: '课程已归档，不能加入' })
  const nextOrder = db
    .prepare('SELECT COALESCE(MAX(sort_order),0)+1 value FROM course_students WHERE course_id=?')
    .get(course.id).value
  const info = db
    .prepare(
      "INSERT OR IGNORE INTO course_students(course_id,student_id,sort_order,joined_at) VALUES(?,?,?,datetime('now','+08:00'))",
    )
    .run(course.id, req.user.id, nextOrder)
  res.json({ message: info.changes ? '已加入课程' : '你已在该课程中', course })
})

router.post('/students/:id/reset-password', auth, teacherOnly, (req, res) => {
  if (!ownStudent(req.params.id, req.user.id))
    return res.status(404).json({ message: '学生不存在' })
  db.prepare(
    `UPDATE users SET password_hash=?,must_change_password=1 WHERE id=? AND role='student'`,
  ).run(bcrypt.hashSync('123456', 10), req.params.id)
  res.json({ message: '密码已重置为123456' })
})

router.put('/students/:id/status', auth, teacherOnly, (req, res) => {
  if (!ownStudent(req.params.id, req.user.id))
    return res.status(404).json({ message: '学生不存在' })
  const status = req.body.status === 'disabled' ? 'disabled' : 'active'
  db.prepare(`UPDATE users SET status=? WHERE id=? AND role='student'`).run(status, req.params.id)
  res.json({ message: status === 'active' ? '账号已启用' : '账号已停用' })
})

export default router
