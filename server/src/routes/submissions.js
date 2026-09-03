import { Router } from 'express'
import { db } from '../db.js'
import { auth } from '../middleware/auth.js'
import { studentOnly } from '../middleware/teacher.js'
import { uploadSubmissionFiles } from '../middleware/upload.js'
import { saveSubmission } from '../services/submissionLogic.js'
import { assignmentAccess, subjectFor, fail } from '../services/access.js'
import {
  submissionAccess,
  historyRows,
  receipts,
  studentView,
} from '../services/submissionQueries.js'
import { effectiveDeadline } from '../services/extensions.js'
import { executeOperation, operationStatus } from '../services/operations.js'
import { queueCleanup } from '../services/storage.js'
import { serveSubmissionFile, serveSubmissionReceipt } from '../services/submissionFileService.js'
const router = Router()
router.get('/assignments/:id/my-submission', auth, studentOnly, (req, res) => {
  const assignment = assignmentAccess(req.params.id, req.user),
    subject = subjectFor(assignment, req.user)
  const row = subject.not_assigned
    ? null
    : subject.group
      ? db.prepare('SELECT * FROM group_submissions WHERE assignment_group_id=?').get(subject.group.id)
      : db
          .prepare('SELECT * FROM submissions WHERE assignment_id=? AND student_id=?')
          .get(assignment.id, req.user.id)
  res.json(
    row
      ? {
          ...studentView({ ...row, kind: subject.group ? 'group' : 'individual' }),
          can_submit: subject.can_submit,
          effective_deadline: effectiveDeadline(assignment, subject).deadline,
        }
      : null,
  )
})
router.get('/assignments/:id/submission-context', auth, studentOnly, (req, res) => {
  const assignment = assignmentAccess(req.params.id, req.user),
    subject = subjectFor(assignment, req.user)
  res.json({
    ...subject,
    effective_deadline: subject.not_assigned
      ? null
      : effectiveDeadline(assignment, subject).deadline,
    members: subject.group
      ? db
          .prepare(
            'SELECT student_id,name_snapshot name,username_snapshot username FROM assignment_group_members WHERE assignment_group_id=?',
          )
          .all(subject.group.id)
      : [],
  })
})
router.post(
  '/assignments/:id/submit',
  auth,
  studentOnly,
  (req, res, next) => {
    const assignment = assignmentAccess(req.params.id, req.user, { write: true })
    if (assignment.status !== 'published') fail(400, '作业已关闭')
    subjectFor(assignment, req.user, { submit: true })
    req.uploadLimit = (assignment.max_file_mb ?? 200) * 1024 * 1024
    req.allowedExtensions = assignment.allowed_extensions
      ? String(assignment.allowed_extensions).split(',')
      : null
    next()
  },
  uploadSubmissionFiles,
  async (req, res) => {
    try {
      const assignment = assignmentAccess(req.params.id, req.user, { write: true })
      const result = await executeOperation(req, 'submission', assignment.id, () =>
        studentView(
          saveSubmission({
            assignment,
            studentId: req.user.id,
            sourceFile: req.stagedSource,
            previewFiles: req.stagedPreviews,
            content: req.body.content,
            baseVersion: req.body.base_version,
          }),
        ),
      )
      res.status(result.replayed ? 200 : 201).json(result)
    } catch (error) {
      const staged = [req.stagedSource, ...(req.stagedPreviews || [])].filter(Boolean)
      if (staged.length)
        queueCleanup(
          [
            ...staged.map((file) => file.path),
            ...staged.flatMap((file) => (file.thumbnailPath ? [file.thumbnailPath] : [])),
          ],
          '未完成的上传',
        )
      throw error
    }
  },
)
router.get('/assignments/:id/upload-status/:key', auth, studentOnly, (req, res) => {
  const assignment = assignmentAccess(req.params.id, req.user)
  res.json(operationStatus(req.user.id, 'submission', assignment.id, req.params.key))
})
for (const [prefix, group] of [
  ['submissions', false],
  ['group-submissions', true],
]) {
  router.get('/' + prefix + '/:id/history', auth, (req, res) => {
    submissionAccess(req.params.id, req.user, group)
    res.json(historyRows(req.params.id, group))
  })
  router.get('/' + prefix + '/:id/receipts', auth, (req, res) => {
    submissionAccess(req.params.id, req.user, group)
    res.json(receipts(req.params.id, group))
  })
  router.get('/' + prefix + '/:id/receipts/:number/file', auth, (req, res) => {
    serveSubmissionReceipt({
      submissionId: req.params.id,
      receiptNumber: req.params.number,
      group,
      user: req.user,
      res,
    })
  })
  router.get('/' + prefix + '/:id/file', auth, (req, res, next) => {
    if (Array.isArray(req.query.history_id)) fail(400, '历史文件编号只能提供一次')
    serveSubmissionFile({
      submissionId: req.params.id,
      historyId: req.query.history_id,
      group,
      user: req.user,
      res,
      next,
    })
  })
}
export default router
