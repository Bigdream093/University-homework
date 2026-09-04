import { Router } from 'express'
import { db } from '../db.js'
import { auth } from '../middleware/auth.js'
import { teacherOnly } from '../middleware/teacher.js'
import { deleteAssignment } from '../services/deletionService.js'
import { courseAccess, assignmentAccess, subjectFor, textValue, fail } from '../services/access.js'
import { nowText, validTime } from '../utils/time.js'
import { parseAllowedExtensions } from '../utils/fileFilter.js'
import { effectiveDeadline } from '../services/extensions.js'
import { moveContent, nextOrder } from '../services/contentOrder.js'
const router = Router()
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
  ]
}
function publishAssignment(assignment) {
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
function withTeacherStats(rows, courseId) {
  const studentTotal = db
    .prepare('SELECT count(*) total FROM course_students WHERE course_id=?')
    .get(courseId).total
  const individual = new Map(
    db
      .prepare(
        `SELECT s.assignment_id,count(*) submitted,
  sum(s.status='submitted') pending_review,sum(s.status='returned') returned
  FROM submissions s JOIN assignments a ON a.id=s.assignment_id WHERE a.course_id=? GROUP BY s.assignment_id`,
      )
      .all(courseId)
      .map((row) => [row.assignment_id, row]),
  )
  const groups = new Map(
    db
      .prepare(
        `SELECT g.assignment_id,count(*) expected,count(s.id) submitted,
  coalesce(sum(s.status='submitted'),0) pending_review,coalesce(sum(s.status='returned'),0) returned
  FROM assignment_groups g LEFT JOIN group_submissions s ON s.assignment_group_id=g.id
  WHERE g.assignment_id IN (SELECT id FROM assignments WHERE course_id=?) GROUP BY g.assignment_id`,
      )
      .all(courseId)
      .map((row) => [row.assignment_id, row]),
  )
  return rows.map((assignment) => {
    const stats =
      assignment.work_mode === 'group'
        ? groups.get(assignment.id) || {}
        : individual.get(assignment.id) || {}
    const expected = assignment.work_mode === 'group' ? Number(stats.expected || 0) : studentTotal
    return {
      ...assignment,
      expected_count: expected,
      unsubmitted_count: Math.max(0, expected - Number(stats.submitted || 0)),
      pending_review_count: Number(stats.pending_review || 0),
      returned_count: Number(stats.returned || 0),
    }
  })
}
router.get('/courses/:id/assignments', auth, (req, res) => {
  const course = courseAccess(req.params.id, req.user)
  let rows = db
    .prepare(
      'SELECT * FROM assignments WHERE course_id=?' +
        (req.user.role === 'student' ? " AND status IN ('published','closed')" : '') +
        ' ORDER BY sort_order,id',
    )
    .all(course.id)
  if (req.user.role === 'teacher') rows = withTeacherStats(rows, course.id)
  res.json(
    rows.map((assignment) => {
      if (req.user.role === 'student') {
        const subject = subjectFor({ ...assignment, course_status: course.status }, req.user)
        const submission = subject.not_assigned
          ? null
          : subject.group
            ? db
                .prepare(
                  'SELECT status,submitted_at FROM group_submissions WHERE assignment_group_id=?',
                )
                .get(subject.group.id)
            : db
                .prepare(
                  'SELECT status,submitted_at FROM submissions WHERE assignment_id=? AND student_id=?',
                )
                .get(assignment.id, req.user.id)
        return {
          ...assignment,
          submission_status: submission?.status,
          submitted_at: submission?.submitted_at,
          can_submit: subject.can_submit,
          not_assigned: subject.not_assigned || false,
          effective_deadline: subject.not_assigned
            ? null
            : effectiveDeadline(assignment, subject).deadline,
          server_now: nowText(),
        }
      }
      return { ...assignment, server_now: nowText() }
    }),
  )
})
router.get('/assignments/:id', auth, (req, res) => {
  const assignment = assignmentAccess(req.params.id, req.user)
  delete assignment.teacher_id
  res.json({ ...assignment, server_now: nowText() })
})
router.post('/courses/:id/assignments', auth, teacherOnly, (req, res) => {
  const course = courseAccess(req.params.id, req.user, { write: true }),
    fields = assignmentFields(req.body),
    status = req.body.status ?? 'draft'
  if (!['draft', 'published'].includes(status)) fail(400, '新作业状态无效')
  const id = db.transaction(() => {
    const inserted = db
      .prepare(
        "INSERT INTO assignments(course_id,title,description,type,deadline,total_score,allow_resubmit_count,submission_mode,max_file_mb,work_mode,group_submit_policy,allowed_extensions,require_preview_image,preview_max_count,grade_weight,status,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'draft',?,?,?)",
      )
      .run(
        course.id,
        ...fields,
        nextOrder('assignments', 'course_id', course.id),
        nowText(),
        nowText(),
      ).lastInsertRowid
    if (status === 'published')
      publishAssignment(db.prepare('SELECT * FROM assignments WHERE id=?').get(inserted))
    return inserted
  })()
  res.status(201).json(db.prepare('SELECT * FROM assignments WHERE id=?').get(id))
})
router.put('/assignments/:id', auth, teacherOnly, (req, res) => {
  const assignment = assignmentAccess(req.params.id, req.user, { write: true }),
    fields = assignmentFields(req.body, assignment)
  const at = nowText(),
    cancelled = db.transaction(() => {
      db.prepare(
        'UPDATE assignments SET title=?,description=?,type=?,deadline=?,total_score=?,allow_resubmit_count=?,submission_mode=?,max_file_mb=?,work_mode=?,group_submit_policy=?,allowed_extensions=?,require_preview_image=?,preview_max_count=?,updated_at=? WHERE id=?',
      ).run(...fields, at, assignment.id)
      return assignment.deadline && !fields[3]
        ? db
            .prepare(
              "UPDATE extension_requests SET status='cancelled',decision_reason='作业截止时间已清空',decided_at=? WHERE assignment_id=? AND status='pending'",
            )
            .run(at, assignment.id).changes
        : 0
    })()
  res.json({
    ...db.prepare('SELECT * FROM assignments WHERE id=?').get(assignment.id),
    cancelled_extension_count: cancelled,
  })
})
router.delete('/assignments/:id', auth, teacherOnly, (req, res) => {
  const assignment = assignmentAccess(req.params.id, req.user, { write: true })
  deleteAssignment(assignment.id)
  res.json({ message: '作业已删除' })
})
router.post('/assignments/:id/publish', auth, teacherOnly, (req, res) => {
  db.transaction(() =>
    publishAssignment(assignmentAccess(req.params.id, req.user, { write: true })),
  )()
  res.json({ message: '作业已发布' })
})
router.post('/assignments/:id/close', auth, teacherOnly, (req, res) => {
  db.transaction(() => {
    const assignment = assignmentAccess(req.params.id, req.user, { write: true })
    if (assignment.status === 'draft') fail(400, '草稿不能直接关闭')
    db.prepare("UPDATE assignments SET status='closed',updated_at=? WHERE id=?").run(
      nowText(),
      assignment.id,
    )
  })()
  res.json({ message: '作业已关闭；待审批的延期申请保留，可拒绝但不可批准' })
})
router.post('/assignments/:id/move', auth, teacherOnly, (req, res) => {
  const assignment = assignmentAccess(req.params.id, req.user, { write: true })
  res.json({
    moved: moveContent({
      table: 'assignments',
      id: assignment.id,
      scopeColumn: 'course_id',
      scopeId: assignment.course_id,
      direction: req.body.direction,
    }),
  })
})
export default router
