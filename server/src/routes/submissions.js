import { Router } from 'express'
import { auth } from '../middleware/auth.js'
import { studentOnly } from '../middleware/teacher.js'
import { uploadSubmissionFiles } from '../middleware/upload.js'
import { saveSubmission } from '../services/submissionLogic.js'
import { assignmentAccess, subjectFor, fail } from '../services/access.js'
import { getAssignment } from '../services/assignmentService.js'
import {
  submissionAccess,
  historyRows,
  receipts,
  studentView,
  currentSubmission,
  studentAssignmentContext,
} from '../services/submissionQueries.js'
import { effectiveDeadline } from '../services/extensions.js'
import { executeOperation, operationStatus } from '../services/operations.js'
import { queueCleanup } from '../services/storage.js'
import { serveSubmissionFile, serveSubmissionReceipt } from '../services/submissionFileService.js'
import { isLate, nowText } from '../utils/time.js'
import { DEFAULT_ASSIGNMENT_FILE_MAX_MB } from '@university-homework/domain/limits'
const router = Router()
router.get('/assignments/:id/student-page', auth, studentOnly, (req, res) => {
  const assignment = getAssignment(req.params.id, req.user),
    subject = subjectFor(assignment, req.user),
    row = currentSubmission(assignment, subject, req.user.id),
    context = studentAssignmentContext(assignment, subject)
  res.json({
    assignment,
    context,
    submission: row
      ? {
          ...studentView({
            ...row,
            kind: subject.group ? 'group' : 'individual',
          }),
          can_submit: subject.can_submit,
          effective_deadline: context.effective_deadline,
        }
      : null,
  })
})
router.get('/assignments/:id/my-submission', auth, studentOnly, (req, res) => {
  const assignment = assignmentAccess(req.params.id, req.user),
    subject = subjectFor(assignment, req.user)
  const row = currentSubmission(assignment, subject, req.user.id)
  res.json(
    row
      ? {
          ...studentView({
            ...row,
            kind: subject.group ? 'group' : 'individual',
          }),
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
    ...studentAssignmentContext(assignment, subject),
  })
})
// New clients can refresh this additive preflight immediately before the confirmation dialog.
// The actual submission transaction still records its own server-side deadline result.
router.get('/assignments/:id/submission-policy', auth, studentOnly, (req, res) => {
  const assignment = assignmentAccess(req.params.id, req.user),
    subject = subjectFor(assignment, req.user),
    serverNow = nowText(),
    deadline = subject.not_assigned ? null : effectiveDeadline(assignment, subject).deadline
  res.json({
    server_now: serverNow,
    effective_deadline: deadline,
    is_late: Boolean(isLate(deadline, serverNow)),
    can_submit: Boolean(
      !subject.not_assigned &&
      subject.can_submit &&
      assignment.status === 'published' &&
      assignment.course_status !== 'archived',
    ),
  })
})
router.post(
  '/assignments/:id/submit',
  auth,
  studentOnly,
  (req, res, next) => {
    const assignment = assignmentAccess(req.params.id, req.user, {
      write: true,
    })
    if (assignment.status !== 'published') fail(400, '作业已关闭')
    subjectFor(assignment, req.user, { submit: true })
    req.uploadLimit = (assignment.max_file_mb ?? DEFAULT_ASSIGNMENT_FILE_MAX_MB) * 1024 * 1024
    req.allowedExtensions = assignment.allowed_extensions
      ? String(assignment.allowed_extensions).split(',')
      : null
    next()
  },
  uploadSubmissionFiles,
  async (req, res) => {
    try {
      const assignment = assignmentAccess(req.params.id, req.user, {
        write: true,
      })
      const result = await executeOperation(req, 'submission', assignment.id, () =>
        studentView(
          saveSubmission({
            assignment,
            studentId: req.user.id,
            sourceFile: req.stagedSource,
            previewFiles: req.stagedPreviews,
            content: req.body.content,
            answerQuestion: req.body.answer_question,
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
