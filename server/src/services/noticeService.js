import { db } from '../db.js';

export function listNotices(courseId, user, res) {
  const course = db.prepare('SELECT * FROM courses WHERE id=?').get(courseId);
  if (!course) return res.status(404).json({ message: '课程不存在' });
  const viewer = user.role === 'teacher'
    ? db.prepare('SELECT 1 FROM courses WHERE id=? AND teacher_id=?').get(courseId, user.id) ? 'teacher' : null
    : db.prepare('SELECT 1 FROM course_students WHERE course_id=? AND student_id=?').get(courseId, user.id) ? 'student' : null;
  if (!viewer) return res.status(403).json({ message: '无权访问该课程' });
  const rows = viewer === 'teacher'
    ? db.prepare('SELECT * FROM notices WHERE course_id=? ORDER BY pinned DESC, created_at DESC, id DESC').all(courseId)
    : db.prepare(`SELECT * FROM notices WHERE course_id=? AND status='published' ORDER BY pinned DESC, created_at DESC, id DESC`).all(courseId);
  res.json(rows);
}

export function createNotice(courseId, teacherId, body, res) {
  const course = db.prepare('SELECT * FROM courses WHERE id=? AND teacher_id=?').get(courseId, teacherId);
  if (!course) return res.status(404).json({ message: '课程不存在' });
  const title = String(body.title || '').trim();
  if (!title) return res.status(400).json({ message: '通知标题不能为空' });
  const status = body.status === 'published' ? 'published' : 'draft';
  const pinned = body.pinned ? 1 : 0;
  const info = db.prepare('INSERT INTO notices(course_id,teacher_id,title,content,pinned,status) VALUES(?,?,?,?,?,?)')
    .run(courseId, teacherId, title, String(body.content || ''), pinned, status);
  res.status(201).json(db.prepare('SELECT * FROM notices WHERE id=?').get(info.lastInsertRowid));
}

export function updateNotice(noticeId, teacherId, body, res) {
  const notice = db.prepare(`SELECT n.* FROM notices n JOIN courses c ON c.id=n.course_id WHERE n.id=? AND c.teacher_id=?`).get(noticeId, teacherId);
  if (!notice) return res.status(404).json({ message: '通知不存在' });
  const title = String(body.title ?? notice.title).trim();
  if (!title) return res.status(400).json({ message: '通知标题不能为空' });
  const status = body.status === 'published' ? 'published' : body.status === 'draft' ? 'draft' : notice.status;
  const pinned = body.pinned === undefined ? notice.pinned : (body.pinned ? 1 : 0);
  db.prepare(`UPDATE notices SET title=?,content=?,pinned=?,status=?,updated_at=datetime('now','localtime') WHERE id=?`)
    .run(title, String(body.content ?? notice.content), pinned, status, notice.id);
  res.json(db.prepare('SELECT * FROM notices WHERE id=?').get(notice.id));
}

export function deleteNotice(noticeId, teacherId, res) {
  const notice = db.prepare(`SELECT n.* FROM notices n JOIN courses c ON c.id=n.course_id WHERE n.id=? AND c.teacher_id=?`).get(noticeId, teacherId);
  if (!notice) return res.status(404).json({ message: '通知不存在' });
  db.prepare('DELETE FROM notices WHERE id=?').run(notice.id);
  res.json({ message: '通知已删除' });
}
