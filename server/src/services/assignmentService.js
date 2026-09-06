import { validateEditorImages } from '../services/editorImageAccess.js'
import { contentFormat } from '../domain/contentFormat.js'
import { db } from '../db.js'
import { courseAccess, assignmentAccess, textValue, fail, requireRole } from './access.js'
import { nowText, validTime } from '../utils/time.js'
import { parseAllowedExtensions } from '../utils/fileFilter.js'
import { moveContent, nextOrder } from './contentOrder.js'
import { deleteAssignment } from './deletionService.js'

const FILE_SIZE_OPTIONS = [10, 20, 50, 100, 200, 500, 1024]
function assignmentFields(body, current = {}) {
  const input = { ...current, ...body }
  const title = textValue(input.title, '作业标题', 200),
    deadline = input.deadline || null
  const maxFileMb = Number(input.max_file_mb ?? 200),
    totalScore = Number(input.total_score ?? 100),
    allowResubmit = Number(input.allow_resubmit_count ?? 1)
  if (deadline && !validTime(deadline)) fail(400, '截止时间格式无效')
  if (!FILE_SIZE_OPTIONS.includes(maxFileMb))
    fail(400, '文件大小上限只能是 10M、20M、50M、100M、200M、500M 或 1G')
  if (
    !Number.isFinite(totalScore) ||
    totalScore <= 0 ||
    !Number.isInteger(allowResubmit) ||
    allowResubmit < -1
  )
    fail(400, '分值或提交次数无效')
  const workMode = input.work_mode ?? 'individual',
    groupPolicy = input.group_submit_policy ?? 'designated'
  const submissionMode = input.submission_mode ?? 'overwrite',
    type = input.type ?? 'document'
  if (
    !['individual', 'group'].includes(workMode) ||
    !['designated', 'any'].includes(groupPolicy) ||
    !['overwrite', 'append'].includes(submissionMode) ||
    !['document', 'online'].includes(type)
  )
    fail(400, '作业设置无效')
  // 已发布或已有提交的作业冻结个人/分组类型；groups_locked 在发布时置位。
  const hasSubmissions =
    current.id &&
    (current.status !== 'draft' ||
      current.groups_locked ||
      db.prepare('SELECT 1 FROM submissions WHERE assignment_id=?').get(current.id))
  if (hasSubmissions && workMode !== current.work_mode)
    fail(400, '已发布或已有提交的作业不能改变个人/分组类型')
  // 后缀名限制仅对文档/文件作业生效；严格格式校验在 parseAllowedExtensions 内完成，其他类型一律不限制。
  const allowedExtensions =
    type === 'document' ? parseAllowedExtensions(input.allowed_extensions) : null
  // 预览图要求只约束之后的提交；既有提交按各自历史记录继续展示。
  const requirePreview = type === 'document' ? Number(Boolean(input.require_preview_image)) : 0
  const previewMax = Number(input.preview_max_count ?? 3)
  if (!Number.isInteger(previewMax) || previewMax < 1 || previewMax > 10)
    fail(400, '预览图上限必须是1到10张')
  return [
    title,
    textValue(input.description, '作业要求', 20000, false),
    type,
    deadline,
    totalScore,
    allowResubmit,
    submissionMode,
    maxFileMb,
    workMode,
    groupPolicy,
    allowedExtensions ? allowedExtensions.join(',') : null,
    requirePreview,
    previewMax,
    contentFormat(input.description_format),
  ]
}
function publishValidatedAssignment(assignment) {
  if (assignment.work_mode === 'group') {
    const groups = db
      .prepare('SELECT * FROM assignment_groups WHERE assignment_id=?')
      .all(assignment.id)
    if (!groups.length) fail(400, '分组作业必须先配置成员快照')
    for (const group of groups) {
      const members = db
        .prepare('SELECT student_id FROM assignment_group_members WHERE assignment_group_id=?')
        .all(group.id)
      if (!members.length) fail(400, '不能发布空小组')
      if (!assignment.groups_locked)
        for (const member of members) {
          const enrolled = db
            .prepare('SELECT 1 FROM course_students WHERE course_id=? AND student_id=?')
            .get(assignment.course_id, member.student_id)
          if (!enrolled) fail(400, '快照成员已退课，请重新配置')
        }
      if (
        assignment.group_submit_policy === 'designated' &&
        !members.some((member) => member.student_id === group.submitter_id)
      )
        fail(400, '小组没有有效提交人')
    }
  }
  db.prepare(
    "UPDATE assignments SET status='published',groups_locked=1,updated_at=? WHERE id=?",
  ).run(nowText(), assignment.id)
}
export function createAssignment(courseId, user, body) {
  requireRole(user, 'teacher')
  return db.transaction(() => {
    const course = courseAccess(courseId, user, { write: true }),
      fields = assignmentFields(body),
      status = body.status ?? 'draft'
    if (!['draft', 'published'].includes(status)) fail(400, '新作业状态无效')
    validateEditorImages(fields[1], fields[13], user)
    const inserted = db
      .prepare(
        "INSERT INTO assignments(course_id,title,description,type,deadline,total_score,allow_resubmit_count,submission_mode,max_file_mb,work_mode,group_submit_policy,allowed_extensions,require_preview_image,preview_max_count,description_format,grade_weight,status,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'draft',?,?,?)",
      )
      .run(
        course.id,
        ...fields,
        nextOrder('assignments', 'course_id', course.id),
        nowText(),
        nowText(),
      ).lastInsertRowid
    if (status === 'published')
      publishValidatedAssignment(db.prepare('SELECT * FROM assignments WHERE id=?').get(inserted))
    return db.prepare('SELECT * FROM assignments WHERE id=?').get(inserted)
  })()
}

export function updateAssignment(assignmentId, user, body) {
  requireRole(user, 'teacher')
  return db.transaction(() => {
    const assignment = assignmentAccess(assignmentId, user, { write: true }),
      fields = assignmentFields(body, assignment)
    validateEditorImages(fields[1], fields[13], user)
    const at = nowText()
    db.prepare(
      'UPDATE assignments SET title=?,description=?,type=?,deadline=?,total_score=?,allow_resubmit_count=?,submission_mode=?,max_file_mb=?,work_mode=?,group_submit_policy=?,allowed_extensions=?,require_preview_image=?,preview_max_count=?,description_format=?,updated_at=? WHERE id=?',
    ).run(...fields, at, assignment.id)
    const cancelled =
      assignment.deadline && !fields[3]
        ? db
            .prepare(
              "UPDATE extension_requests SET status='cancelled',decision_reason='作业截止时间已清空',decided_at=? WHERE assignment_id=? AND status='pending'",
            )
            .run(at, assignment.id).changes
        : 0
    return {
      ...db.prepare('SELECT * FROM assignments WHERE id=?').get(assignment.id),
      cancelled_extension_count: cancelled,
    }
  })()
}

export function getAssignment(assignmentId, user) {
  const assignment = assignmentAccess(assignmentId, user)
  delete assignment.teacher_id
  return { ...assignment, server_now: nowText() }
}

export function publishAssignment(assignmentId, user) {
  requireRole(user, 'teacher')
  return db.transaction(() => {
    publishValidatedAssignment(assignmentAccess(assignmentId, user, { write: true }))
    return { message: '作业已发布' }
  })()
}

export function closeAssignment(assignmentId, user) {
  requireRole(user, 'teacher')
  return db.transaction(() => {
    const assignment = assignmentAccess(assignmentId, user, { write: true })
    if (assignment.status === 'draft') fail(400, '草稿不能直接关闭')
    db.prepare("UPDATE assignments SET status='closed',updated_at=? WHERE id=?").run(
      nowText(),
      assignment.id,
    )
    return { message: '作业已关闭；待审批的延期申请保留，可拒绝但不可批准' }
  })()
}

export function removeAssignment(assignmentId, user) {
  requireRole(user, 'teacher')
  const assignment = assignmentAccess(assignmentId, user, { write: true })
  // 删除服务已有事务，将删除记录和文件清理队列一起提交。
  deleteAssignment(assignment.id)
  return { message: '作业已删除' }
}

export function moveAssignment(assignmentId, user, direction) {
  requireRole(user, 'teacher')
  const assignment = assignmentAccess(assignmentId, user, { write: true })
  return {
    moved: moveContent({
      table: 'assignments',
      id: assignment.id,
      scopeColumn: 'course_id',
      scopeId: assignment.course_id,
      direction,
    }),
  }
}
