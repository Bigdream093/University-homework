import { Router } from 'express'
import { db } from '../db.js'
import { auth } from '../middleware/auth.js'
import { studentOnly, teacherOnly } from '../middleware/teacher.js'
import { assignmentAccess, fail, textValue } from '../services/access.js'
import { applyExtension, listExtensions, effectiveDeadline } from '../services/extensions.js'
import { nowText, validTime } from '../utils/time.js'
const router = Router()
router.get('/assignments/:id/extensions', auth, (req, res) =>
  res.json(listExtensions(assignmentAccess(req.params.id, req.user), req.user)),
)
router.post('/assignments/:id/extensions', auth, studentOnly, (req, res) =>
  res
    .status(201)
    .json(
      db.transaction(() =>
        applyExtension(
          assignmentAccess(req.params.id, req.user, { write: true }),
          req.user,
          req.body,
        ),
      )(),
    ),
)
router.post('/extensions/:id/withdraw', auth, studentOnly, (req, res) =>
  res.json(
    db.transaction(() => {
      const extension = db.prepare('SELECT * FROM extension_requests WHERE id=?').get(req.params.id)
      if (!extension || extension.requester_id !== req.user.id) fail(404, '申请不存在')
      assignmentAccess(extension.assignment_id, req.user, { write: true })
      if (extension.status !== 'pending') fail(409, '申请已经处理')
      db.prepare("UPDATE extension_requests SET status='withdrawn',decided_at=? WHERE id=?").run(
        nowText(),
        extension.id,
      )
      return { message: '申请已撤回' }
    })(),
  ),
)
router.post('/extensions/:id/decision', auth, teacherOnly, (req, res) =>
  res.json(
    db.transaction(() => {
      const extension = db.prepare('SELECT * FROM extension_requests WHERE id=?').get(req.params.id)
      if (!extension) fail(404, '申请不存在')
      const assignment = assignmentAccess(extension.assignment_id, req.user, { write: true })
      if (extension.status !== 'pending') fail(409, '申请已经处理')
      const status = req.body.status,
        at = nowText()
      if (!['approved', 'rejected'].includes(status)) fail(400, '无效审批结果')
      // 关闭后的作业不能延长提交窗口，但仍需允许教师拒绝遗留申请。
      if (status === 'approved' && assignment.status !== 'published')
        fail(409, '作业已关闭，不能批准延期；如需处理请选择拒绝')
      let deadline = null
      if (status === 'approved') {
        deadline = req.body.approved_deadline || extension.requested_deadline
        const current = effectiveDeadline(assignment, extension).deadline
        if (!current || !validTime(deadline) || deadline <= at || deadline <= current)
          fail(400, '批准时间必须晚于当前截止时间和现在')
      }
      const reason = textValue(req.body.decision_reason, '审批说明', 2000, status === 'rejected')
      db.prepare(
        'UPDATE extension_requests SET status=?,approved_deadline=?,decision_reason=?,decided_by=?,decided_at=? WHERE id=?',
      ).run(status, deadline, reason, req.user.id, at, extension.id)
      return { message: '审批已保存' }
    })(),
  ),
)
export default router
