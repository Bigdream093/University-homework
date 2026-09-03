import { Router } from 'express'
import { auth } from '../middleware/auth.js'
import { teacherOnly } from '../middleware/teacher.js'
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
  listNotices(Number(req.params.id), req.user, res),
)
router.get('/notices/:id', auth, (req, res) => getNotice(Number(req.params.id), req.user, res))
router.post('/notices/:id/read', auth, (req, res) =>
  markRead(Number(req.params.id), req.user, res, req.body || {}),
)
router.get('/notices/:id/readers', auth, teacherOnly, (req, res) =>
  readers(Number(req.params.id), req.user.id, res),
)
router.post('/courses/:id/notices', auth, teacherOnly, (req, res) =>
  createNotice(Number(req.params.id), req.user.id, req.body, res),
)
router.put('/notices/:id', auth, teacherOnly, (req, res) =>
  updateNotice(Number(req.params.id), req.user.id, req.body, res),
)
router.post('/notices/:id/withdraw', auth, teacherOnly, (req, res) =>
  withdrawNotice(Number(req.params.id), req.user.id, req.body || {}, res),
)
router.delete('/notices/:id', auth, teacherOnly, (req, res) =>
  deleteDraftNotice(Number(req.params.id), req.user.id, res),
)
router.post('/notices/:id/move', auth, teacherOnly, (req, res) =>
  moveNotice(Number(req.params.id), req.user.id, req.body.direction, res),
)

export default router
