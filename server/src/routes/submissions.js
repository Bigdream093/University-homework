import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { db } from '../db.js';
import { config } from '../config.js';
import { auth } from '../middleware/auth.js';
import { teacherOnly, studentOnly } from '../middleware/teacher.js';
import { fileFilter, safeName } from '../utils/fileFilter.js';
import { saveSubmission } from '../services/submissionLogic.js';
import { serveSubmissionFile } from '../services/fileService.js';

fs.mkdirSync(config.uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination(req, _file, cb) {
    const dir = path.join(config.uploadDir, String(req.params.id));
    fs.mkdirSync(dir, { recursive: true }); cb(null, dir);
  },
  filename(req, file, cb) { cb(null, `${req.user.id}_${Date.now()}_${safeName(file.originalname)}`); }
});
const upload = multer({ storage, fileFilter, limits: { fileSize: config.uploadMaxMb * 1024 * 1024 } });
const router = Router();

router.get('/assignments/:id/my-submission', auth, studentOnly, (req, res) => {
  const sub = db.prepare('SELECT id,assignment_id,student_id,content,file_name,file_size,file_type,submit_count,status,returned_reason,is_late,submitted_at FROM submissions WHERE assignment_id=? AND student_id=?').get(req.params.id, req.user.id);
  res.json(sub || null);
});

router.post('/assignments/:id/submit', auth, studentOnly, upload.single('file'), (req, res) => {
  const assignment = db.prepare(`SELECT a.* FROM assignments a JOIN course_students cs ON cs.course_id=a.course_id WHERE a.id=? AND cs.student_id=?`).get(req.params.id, req.user.id);
  if (!assignment) {
    if (req.file) fs.rmSync(req.file.path, { force: true });
    return res.status(404).json({ message: '作业不存在或你未加入课程' });
  }
  try { res.status(201).json(saveSubmission({ assignment, studentId: req.user.id, file: req.file, content: req.body.content })); }
  catch (error) { if (req.file) fs.rmSync(req.file.path, { force: true }); throw error; }
});

router.get('/submissions/:id/history', auth, studentOnly, (req, res) => {
  const own = db.prepare('SELECT 1 FROM submissions WHERE id=? AND student_id=?').get(req.params.id, req.user.id);
  if (!own) return res.status(404).json({ message: '提交记录不存在' });
  res.json(db.prepare('SELECT id,file_name,file_size,file_type,content,is_late,submitted_at FROM submission_history WHERE submission_id=? ORDER BY submitted_at DESC').all(req.params.id));
});

router.get('/submissions/:id/file', auth, (req, res) => {
  serveSubmissionFile(req.params.id, req.user, req.query.history_id, res);
});

export default router;
