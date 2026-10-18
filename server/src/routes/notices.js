import { Router } from 'express'
import { auth } from '../middleware/auth.js'
import { teacherOnly } from '../middleware/teacher.js'
import { idValue } from '../services/access.js'
import {
  listNotices,
  getNotice,
  markRead,
  readers,
  createNotice,
  updateNotice,
  withdrawNotice,
  deleteDraftNotice,
  moveNotice,
} from '../services/noticeService.js'

const router = Router()

router.get('/courses/:id/notices', auth, (req, res) =>
  res.json(listNotices(idValue(req.params.id), req.user)),
)
router.get('/notices/:id', auth, (req, res) =>
  res.json(getNotice(idValue(req.params.id), req.user)),
)
router.post('/notices/:id/read', auth, (req, res) =>
  res.json(markRead(idValue(req.params.id), req.user, req.body || {})),
)
router.get('/notices/:id/readers', auth, teacherOnly, (req, res) =>
  res.json(readers(idValue(req.params.id), req.user.id)),
)
router.post('/courses/:id/notices', auth, teacherOnly, (req, res) =>
  res.status(201).json(createNotice(idValue(req.params.id), req.user.id, req.body)),
)
router.put('/notices/:id', auth, teacherOnly, (req, res) =>
  res.json(updateNotice(idValue(req.params.id), req.user.id, req.body)),
)
router.post('/notices/:id/withdraw', auth, teacherOnly, (req, res) =>
  res.json(withdrawNotice(idValue(req.params.id), req.user.id, req.body || {})),
)
router.delete('/notices/:id', auth, teacherOnly, (req, res) =>
  res.json(deleteDraftNotice(idValue(req.params.id), req.user.id)),
)
router.post('/notices/:id/move', auth, teacherOnly, (req, res) =>
  res.json(moveNotice(idValue(req.params.id), req.user.id, req.body.direction)),
)

export default router
