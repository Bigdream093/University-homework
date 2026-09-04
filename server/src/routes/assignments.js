import { Router } from 'express'
import { auth } from '../middleware/auth.js'
import { teacherOnly } from '../middleware/teacher.js'
import { listAssignments } from '../services/assignmentQueries.js'
import {
  getAssignment,
  createAssignment,
  updateAssignment,
  removeAssignment,
  publishAssignment,
  closeAssignment,
  moveAssignment,
} from '../services/assignmentService.js'

const router = Router()
router.get('/courses/:id/assignments', auth, (req, res) =>
  res.json(listAssignments(req.params.id, req.user)),
)
router.get('/assignments/:id', auth, (req, res) => res.json(getAssignment(req.params.id, req.user)))
router.post('/courses/:id/assignments', auth, teacherOnly, (req, res) =>
  res.status(201).json(createAssignment(req.params.id, req.user, req.body)),
)
router.put('/assignments/:id', auth, teacherOnly, (req, res) =>
  res.json(updateAssignment(req.params.id, req.user, req.body)),
)
router.delete('/assignments/:id', auth, teacherOnly, (req, res) =>
  res.json(removeAssignment(req.params.id, req.user)),
)
router.post('/assignments/:id/publish', auth, teacherOnly, (req, res) =>
  res.json(publishAssignment(req.params.id, req.user)),
)
router.post('/assignments/:id/close', auth, teacherOnly, (req, res) =>
  res.json(closeAssignment(req.params.id, req.user)),
)
router.post('/assignments/:id/move', auth, teacherOnly, (req, res) =>
  res.json(moveAssignment(req.params.id, req.user, req.body.direction)),
)
export default router
