import { Router } from 'express';
import { db } from '../db.js';
import { auth } from '../middleware/auth.js';
import { teacherOnly } from '../middleware/teacher.js';
import { deleteAssignment } from '../services/deletionService.js';
import { nowText } from '../utils/time.js';

const router = Router();
const ownAssignment = (id, teacherId) => db.prepare(`SELECT a.* FROM assignments a JOIN courses c ON c.id=a.course_id WHERE a.id=? AND c.teacher_id=?`).get(id, teacherId);
const MAX_FILE_MB_OPTIONS = [100, 200, 500, 1024];
function parseMaxFileMb(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const num = Number(value);
  return MAX_FILE_MB_OPTIONS.includes(num) ? num : null;
}

router.get('/courses/:id/assignments', auth, (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id=?').get(req.params.id);
  if (!course) return res.status(404).json({ message: '课程不存在' });
  const teacher = req.user.role === 'teacher' && course.teacher_id === req.user.id;
  const student = req.user.role === 'student' && db.prepare('SELECT 1 FROM course_students WHERE course_id=? AND student_id=?').get(course.id, req.user.id);
  if (!teacher && !student) return res.status(403).json({ message: '无权访问' });
  const sql = `SELECT a.*${student ? `,(SELECT status FROM submissions s WHERE s.assignment_id=a.id AND s.student_id=?) submission_status,(SELECT submitted_at FROM submissions s WHERE s.assignment_id=a.id AND s.student_id=?) submitted_at` : ''} FROM assignments a WHERE course_id=?${student ? ` AND status='published'` : ''} ORDER BY deadline IS NULL, deadline`;
  const rows = student ? db.prepare(sql).all(req.user.id, req.user.id, req.params.id) : db.prepare(sql).all(req.params.id);
  const serverNow = nowText();
  res.json(rows.map(row => ({ ...row, server_now: serverNow })));
});

router.get('/assignments/:id', auth, (req, res) => {
  const assignment = db.prepare('SELECT a.*,c.name course_name,c.teacher_id FROM assignments a JOIN courses c ON c.id=a.course_id WHERE a.id=?').get(req.params.id);
  if (!assignment) return res.status(404).json({ message: '作业不存在' });
  const allowed = req.user.role === 'teacher' ? assignment.teacher_id === req.user.id : assignment.status === 'published' && db.prepare('SELECT 1 FROM course_students WHERE course_id=? AND student_id=?').get(assignment.course_id, req.user.id);
  if (!allowed) return res.status(403).json({ message: '无权访问' });
  delete assignment.teacher_id;
  res.json({ ...assignment, server_now: nowText() });
});

router.post('/courses/:id/assignments', auth, teacherOnly, (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id=? AND teacher_id=?').get(req.params.id, req.user.id);
  if (!course) return res.status(404).json({ message: '课程不存在' });
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ message: '作业标题不能为空' });
  const submissionMode = req.body.submission_mode === 'append' ? 'append' : 'overwrite';
  const maxFileMb = parseMaxFileMb(req.body.max_file_mb, 200);
  if (maxFileMb === null) return res.status(400).json({ message: '文件大小上限只能是 100M、200M、500M 或 1G' });
  const info = db.prepare(`INSERT INTO assignments(course_id,title,description,type,deadline,total_score,allow_resubmit_count,submission_mode,max_file_mb,status) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(course.id, title, req.body.description || '', req.body.type || 'document', req.body.deadline || null, Number(req.body.total_score ?? 100), Number(req.body.allow_resubmit_count ?? 1), submissionMode, maxFileMb, req.body.status || 'draft');
  res.status(201).json(db.prepare('SELECT * FROM assignments WHERE id=?').get(info.lastInsertRowid));
});

router.put('/assignments/:id', auth, teacherOnly, (req, res) => {
  const current = ownAssignment(req.params.id, req.user.id);
  if (!current) return res.status(404).json({ message: '作业不存在' });
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ message: '作业标题不能为空' });
  const submissionMode = req.body.submission_mode === 'append' ? 'append' : 'overwrite';
  const maxFileMb = parseMaxFileMb(req.body.max_file_mb, current.max_file_mb ?? 200);
  if (maxFileMb === null) return res.status(400).json({ message: '文件大小上限只能是 100M、200M、500M 或 1G' });
  db.prepare(`UPDATE assignments SET title=?,description=?,type=?,deadline=?,total_score=?,allow_resubmit_count=?,submission_mode=?,max_file_mb=?,updated_at=datetime('now','localtime') WHERE id=?`)
    .run(title, req.body.description || '', req.body.type || 'document', req.body.deadline || null, Number(req.body.total_score ?? 100), Number(req.body.allow_resubmit_count ?? 1), submissionMode, maxFileMb, current.id);
  res.json(db.prepare('SELECT * FROM assignments WHERE id=?').get(current.id));
});

router.delete('/assignments/:id', auth, teacherOnly, (req, res) => {
  if (!ownAssignment(req.params.id, req.user.id)) return res.status(404).json({ message: '作业不存在' });
  deleteAssignment(Number(req.params.id)); res.json({ message: '作业已删除' });
});

for (const [action, status] of [['publish','published'],['close','closed']]) router.post(`/assignments/:id/${action}`, auth, teacherOnly, (req, res) => {
  if (!ownAssignment(req.params.id, req.user.id)) return res.status(404).json({ message: '作业不存在' });
  db.prepare(`UPDATE assignments SET status=?,updated_at=datetime('now','localtime') WHERE id=?`).run(status, req.params.id);
  res.json({ message: status === 'published' ? '作业已发布' : '作业已关闭' });
});

export default router;
