import { Router } from 'express';
import { db } from '../db.js';
import { auth } from '../middleware/auth.js';
import { teacherOnly } from '../middleware/teacher.js';
import { nowText } from '../utils/time.js';

const router = Router();
const teacherSub = (id, teacherId) => db.prepare(`SELECT s.* FROM submissions s JOIN assignments a ON a.id=s.assignment_id JOIN courses c ON c.id=a.course_id WHERE s.id=? AND c.teacher_id=?`).get(id, teacherId);

router.get('/assignments/:id/submissions', auth, teacherOnly, (req, res) => {
  const assignment = db.prepare(`SELECT a.* FROM assignments a JOIN courses c ON c.id=a.course_id WHERE a.id=? AND c.teacher_id=?`).get(req.params.id, req.user.id);
  if (!assignment) return res.status(404).json({ message: '作业不存在' });
  const keyword = `%${String(req.query.keyword || '')}%`;
  let rows = db.prepare(`SELECT u.id student_id,u.username,u.name,u.status user_status,s.id,s.content,s.file_name,s.file_size,s.file_type,s.submit_count,s.status,s.score,s.comment,s.returned_reason,s.is_late,s.submitted_at,s.graded_at
    FROM course_students cs JOIN users u ON u.id=cs.student_id LEFT JOIN submissions s ON s.student_id=u.id AND s.assignment_id=?
    WHERE cs.course_id=? AND (u.username LIKE ? OR u.name LIKE ?)
    ORDER BY COALESCE(cs.sort_order, cs.id), cs.id`).all(assignment.id, assignment.course_id, keyword, keyword);
  for (const row of rows) {
    row.files = row.id ? db.prepare(`SELECT h.id history_id,h.file_name,h.file_size,h.file_type,h.content,h.submitted_at,h.is_late FROM submission_history h WHERE h.submission_id=? AND (h.file_url IS NOT NULL OR (h.content IS NOT NULL AND h.content <> '')) ORDER BY h.submitted_at,h.id`).all(row.id) : [];
  }
  const filter = req.query.status;
  if (filter === 'unsubmitted') rows = rows.filter(r => !r.id);
  if (filter === 'submitted') rows = rows.filter(r => r.id && r.status === 'submitted');
  if (filter === 'late') rows = rows.filter(r => r.is_late === 1);
  if (filter === 'returned') rows = rows.filter(r => r.status === 'returned');
  if (filter === 'graded') rows = rows.filter(r => r.status === 'graded');
  res.json(rows);
});

router.post('/submissions/:id/grade', auth, teacherOnly, (req, res) => {
  const sub = teacherSub(req.params.id, req.user.id);
  if (!sub) return res.status(404).json({ message: '提交记录不存在' });
  const score = Number(req.body.score);
  const max = db.prepare('SELECT total_score FROM assignments WHERE id=?').get(sub.assignment_id).total_score;
  if (!Number.isFinite(score) || score < 0 || score > max) return res.status(400).json({ message: `成绩应在0到${max}之间` });
  db.prepare(`UPDATE submissions SET score=?,comment=?,status='graded',returned_reason=NULL,graded_at=? WHERE id=?`).run(score, String(req.body.comment || ''), nowText(), sub.id);
  res.json({ message: '批改已保存' });
});

router.post('/submissions/:id/return', auth, teacherOnly, (req, res) => {
  const sub = teacherSub(req.params.id, req.user.id);
  if (!sub) return res.status(404).json({ message: '提交记录不存在' });
  const reason = String(req.body.returned_reason || '').trim();
  if (!reason) return res.status(400).json({ message: '请填写退回原因' });
  db.prepare(`UPDATE submissions SET status='returned',returned_reason=?,score=NULL,comment=NULL,graded_at=NULL WHERE id=?`).run(reason, sub.id);
  res.json({ message: '作业已退回' });
});

router.get('/courses/:id/students/:sid/submissions', auth, teacherOnly, (req, res) => {
  const course = db.prepare('SELECT 1 FROM courses WHERE id=? AND teacher_id=?').get(req.params.id, req.user.id);
  if (!course) return res.status(404).json({ message: '课程不存在' });
  res.json(db.prepare(`SELECT a.title,a.deadline,s.* FROM assignments a LEFT JOIN submissions s ON s.assignment_id=a.id AND s.student_id=? WHERE a.course_id=? ORDER BY a.created_at DESC`).all(req.params.sid, req.params.id));
});

export default router;
