import { Router } from 'express'
import { auth } from '../middleware/auth.js'
import { studentOnly, teacherOnly } from '../middleware/teacher.js'
import {
  applyExtension,
  getExtensions,
  withdrawExtension,
  decideExtension,
} from '../services/extensions.js'

const router = Router()
router.get('/assignments/:id/extensions', auth, (req, res) =>
  res.json(getExtensions(req.params.id, req.user)),
)
router.post('/assignments/:id/extensions', auth, studentOnly, (req, res) =>
  res.status(201).json(applyExtension(req.params.id, req.user, req.body)),
)
router.post('/extensions/:id/withdraw', auth, studentOnly, (req, res) =>
  res.json(withdrawExtension(req.params.id, req.user)),
)
router.post('/extensions/:id/decision', auth, teacherOnly, (req, res) =>
  res.json(decideExtension(req.params.id, req.user, req.body)),
)
export default router
