import { db } from '../db.js'

export function fail(status, message) {
  throw Object.assign(new Error(message), { status })
}
export function textValue(value, label, max = 20000, required = true) {
  const text = String(value ?? '').trim()
  if ((required && !text) || text.length > max)
    fail(400, `${label}${!text ? '不能为空' : `不能超过${max}字`}`)
  return text
}
export function idValue(value) {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id < 1) fail(400, '无效的编号')
  return id
}
export function courseAccess(courseId, user, { write = false, teacher = false } = {}) {
  const course = db.prepare('SELECT * FROM courses WHERE id=?').get(idValue(courseId))
  if (!course) fail(404, '课程不存在')
  if (user.role === 'teacher') {
    if (course.teacher_id !== user.id) fail(403, '无权访问该课程')
  } else if (
    teacher ||
    !db
      .prepare('SELECT 1 FROM course_students WHERE course_id=? AND student_id=?')
      .get(course.id, user.id)
  )
    fail(403, '无权访问该课程')
  if (write && course.status !== 'active')
    fail(
      409,
      user.role === 'teacher' ? '课程已归档，请先恢复课程' : '课程已归档，当前仅可查看历史记录',
    )
  return course
}
export function assignmentAccess(id, user, options = {}) {
  const assignment = db.prepare('SELECT * FROM assignments WHERE id=?').get(idValue(id))
  if (!assignment) fail(404, '作业不存在')
  const course = courseAccess(assignment.course_id, user, options)
  if (user.role === 'student' && !['published', 'closed'].includes(assignment.status))
    fail(404, '作业尚未发布')
  return {
    ...assignment,
    course_name: course.name,
    course_status: course.status,
    teacher_id: course.teacher_id,
  }
}
export function subjectFor(assignment, user, { submit = false } = {}) {
  if (user.role !== 'student') fail(403, '仅学生可提交')
  if (assignment.work_mode !== 'group')
    return {
      student_id: user.id,
      group: null,
      can_submit: assignment.status === 'published' && assignment.course_status !== 'archived',
    }
  const group = db
    .prepare(
      'SELECT g.* FROM assignment_groups g JOIN assignment_group_members m ON m.assignment_group_id=g.id WHERE g.assignment_id=? AND m.student_id=?',
    )
    .get(assignment.id, user.id)
  if (!group) {
    if (submit) fail(403, '本次作业未安排你参与')
    return { student_id: null, group: null, can_submit: false, not_assigned: true }
  }
  const canSubmit =
    assignment.status === 'published' &&
    assignment.course_status !== 'archived' &&
    (assignment.group_submit_policy === 'any' || group.submitter_id === user.id)
  if (submit && !canSubmit) fail(403, '你不是本组当前有权提交的成员')
  return { student_id: null, assignment_group_id: group.id, group, can_submit: canSubmit }
}
export function pageOf(query) {
  const page = Math.max(1, Math.floor(Number(query.page) || 1))
  const limit = Math.min(100, Math.max(1, Math.floor(Number(query.limit) || 20)))
  return { page, limit, offset: (page - 1) * limit }
}
