import { Router } from 'express'
import { auth } from '../middleware/auth.js'
import { teacherOnly } from '../middleware/teacher.js'
import { downloadAssignmentPackage, downloadSubmissionPackage } from '../services/packageService.js'

const router = Router()

router.get('/assignments/:id/package', auth, teacherOnly, async (req, res) =>
  downloadAssignmentPackage(req.params.id, req.user.id, res),
)
router.get('/submissions/:id/package', auth, teacherOnly, async (req, res) =>
  downloadSubmissionPackage(req.params.id, req.user, false, res),
)
router.get('/group-submissions/:id/package', auth, teacherOnly, async (req, res) =>
  downloadSubmissionPackage(req.params.id, req.user, true, res),
)

export default router
