import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import { teacherOnly } from '../middleware/teacher.js';
import { listNotices, createNotice, updateNotice, deleteNotice } from '../services/noticeService.js';

const router = Router();

router.get('/courses/:id/notices', auth, (req, res) => listNotices(Number(req.params.id), req.user, res));
router.post('/courses/:id/notices', auth, teacherOnly, (req, res) => createNotice(Number(req.params.id), req.user.id, req.body, res));
router.put('/notices/:id', auth, teacherOnly, (req, res) => updateNotice(Number(req.params.id), req.user.id, req.body, res));
router.delete('/notices/:id', auth, teacherOnly, (req, res) => deleteNotice(Number(req.params.id), req.user.id, res));

export default router;
