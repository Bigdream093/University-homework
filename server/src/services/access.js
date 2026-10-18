import { db } from '../db.js'
import { richTextValue } from '../domain/richText.js'
import { LIMITS, boundedInt } from '@university-homework/domain/limits'
import { httpError } from '../utils/httpError.js'
import { canSubmitAssignment } from '../domain/submissionPolicy.js'

export function fail(status, message) {
  throw httpError(status, message)
}
// 服务也校验角色，避免非 HTTP 调用绕过路由中间件。
export function requireRole(user, role) {
  if (user?.role !== role)
    fail(403, role === 'teacher' ? '仅教师可执行此操作' : '仅学生可执行此操作')
}
export function textValue(value, label, max = LIMITS.plainText, required = true) {
  const text = String(value ?? '').trim()
  if ((required && !text) || text.length > max)
    fail(400, `${label}${!text ? '不能为空' : `不能超过${max}字`}`)
  return text
}
// 按格式分流：html 走白名单清洗，plain 及遗留 markdown 按普通字符串保存，避免改写旧正文。
export function contentValue(
  value,
  format,
  label,
  max = LIMITS.richText,
  required = true,
  alreadySanitized = false,
) {
  return format === 'html'
    ? richTextValue(value, label, max, required, alreadySanitized)
    : textValue(value, label, max, required)
}
export function idValue(value, message = '无效的编号') {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id < 1) fail(400, message)
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
      can_submit: canSubmitAssignment(assignment, assignment.course_status, null, user.id),
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
  const canSubmit = canSubmitAssignment(assignment, assignment.course_status, group, user.id)
  if (submit && !canSubmit) fail(403, '你不是本组当前有权提交的成员')
  return { student_id: null, assignment_group_id: group.id, group, can_submit: canSubmit }
}
export function pageOf(query) {
  const page = boundedInt(query.page, 1, Number.MAX_SAFE_INTEGER),
    limit = boundedInt(query.limit, LIMITS.questionPageSize, LIMITS.maxQuestionPageSize)
  return { page, limit, offset: (page - 1) * limit }
}
