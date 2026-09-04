import { db } from '../db.js'
import { nowText, validTime } from '../utils/time.js'
import { assignmentAccess, fail, requireRole, subjectFor, textValue } from './access.js'

export function effectiveDeadline(assignment, subject) {
  if (!assignment.deadline) return { deadline: null, extension: null }
  const column = subject.assignment_group_id ? 'assignment_group_id' : 'student_id'
  const extension = db
    .prepare(
      `SELECT * FROM extension_requests WHERE assignment_id=? AND ${column}=? AND status='approved' ORDER BY approved_deadline DESC,id DESC LIMIT 1`,
    )
    .get(assignment.id, subject[column])
  return {
    deadline:
      extension?.approved_deadline > assignment.deadline
        ? extension.approved_deadline
        : assignment.deadline,
    extension: extension || null,
  }
}
export function listExtensions(assignment, user) {
  if (user.role === 'teacher')
    return db
      .prepare(
        'SELECT e.*,u.name requester_name,u.username requester_username,g.name group_name FROM extension_requests e JOIN users u ON u.id=e.requester_id LEFT JOIN assignment_groups g ON g.id=e.assignment_group_id WHERE e.assignment_id=? ORDER BY e.id DESC',
      )
      .all(assignment.id)
  const subject = subjectFor(assignment, user)
  if (subject.not_assigned) return []
  const column = subject.assignment_group_id ? 'assignment_group_id' : 'student_id'
  return db
    .prepare(
      `SELECT * FROM extension_requests WHERE assignment_id=? AND ${column}=? ORDER BY id DESC`,
    )
    .all(assignment.id, subject[column])
    .map((request) =>
      request.requester_id === user.id
        ? request
        : {
            id: request.id,
            status: request.status,
            requested_deadline: request.requested_deadline,
            approved_deadline: request.approved_deadline,
            created_at: request.created_at,
            decided_at: request.decided_at,
          },
    )
}
function insertExtension(assignment, user, body) {
  if (assignment.status !== 'published' || !assignment.deadline)
    fail(400, '仅有截止时间的已发布作业可以申请延期')
  const subject = subjectFor(assignment, user, { submit: true }),
    current = effectiveDeadline(assignment, subject).deadline,
    at = nowText()
  const requested = body.requested_deadline
  if (!validTime(requested) || requested <= at || requested <= current)
    fail(400, '申请时间必须晚于当前截止时间和现在')
  const column = subject.assignment_group_id ? 'assignment_group_id' : 'student_id'
  if (
    db
      .prepare(
        `SELECT 1 FROM extension_requests WHERE assignment_id=? AND ${column}=? AND status='pending'`,
      )
      .get(assignment.id, subject[column])
  )
    fail(409, '已有待审批申请')
  const id = db
    .prepare(
      'INSERT INTO extension_requests(assignment_id,student_id,assignment_group_id,requester_id,reason,requested_deadline,status,created_at) VALUES(?,?,?,?,?,?,?,?)',
    )
    .run(
      assignment.id,
      subject.student_id || null,
      subject.assignment_group_id || null,
      user.id,
      textValue(body.reason, '延期理由', 2000),
      requested,
      'pending',
      at,
    ).lastInsertRowid
  return { id, message: '延期申请已提交' }
}

// 每个写入口拥有自己的事务，并在事务内重新读取权限和业务状态。
export function applyExtension(assignmentId, user, body) {
  requireRole(user, 'student')
  return db.transaction(() =>
    insertExtension(assignmentAccess(assignmentId, user, { write: true }), user, body),
  )()
}

export function getExtensions(assignmentId, user) {
  return listExtensions(assignmentAccess(assignmentId, user), user)
}

export function withdrawExtension(extensionId, user) {
  requireRole(user, 'student')
  return db.transaction(() => {
    const extension = db.prepare('SELECT * FROM extension_requests WHERE id=?').get(extensionId)
    if (!extension || extension.requester_id !== user.id) fail(404, '申请不存在')
    assignmentAccess(extension.assignment_id, user, { write: true })
    if (extension.status !== 'pending') fail(409, '申请已经处理')
    db.prepare("UPDATE extension_requests SET status='withdrawn',decided_at=? WHERE id=?").run(
      nowText(),
      extension.id,
    )
    return { message: '申请已撤回' }
  })()
}

export function decideExtension(extensionId, user, body) {
  requireRole(user, 'teacher')
  return db.transaction(() => {
    const extension = db.prepare('SELECT * FROM extension_requests WHERE id=?').get(extensionId)
    if (!extension) fail(404, '申请不存在')
    const assignment = assignmentAccess(extension.assignment_id, user, { write: true })
    if (extension.status !== 'pending') fail(409, '申请已经处理')
    const status = body.status,
      at = nowText()
    if (!['approved', 'rejected'].includes(status)) fail(400, '无效审批结果')
    // 关闭后的作业不能延长提交窗口，但仍需允许教师拒绝遗留申请。
    if (status === 'approved' && assignment.status !== 'published')
      fail(409, '作业已关闭，不能批准延期；如需处理请选择拒绝')
    let deadline = null
    if (status === 'approved') {
      deadline = body.approved_deadline || extension.requested_deadline
      const current = effectiveDeadline(assignment, extension).deadline
      if (!current || !validTime(deadline) || deadline <= at || deadline <= current)
        fail(400, '批准时间必须晚于当前截止时间和现在')
    }
    const reason = textValue(body.decision_reason, '审批说明', 2000, status === 'rejected')
    db.prepare(
      'UPDATE extension_requests SET status=?,approved_deadline=?,decision_reason=?,decided_by=?,decided_at=? WHERE id=?',
    ).run(status, deadline, reason, user.id, at, extension.id)
    return { message: '审批已保存' }
  })()
}
