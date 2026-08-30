import { db } from '../db.js';
import { resolveUploadPath } from '../utils/uploadPath.js';

export function serveMaterialFile(materialId, user, res) {
  const material = db.prepare(`SELECT m.* FROM materials m JOIN courses c ON c.id=m.course_id WHERE m.id=?`).get(materialId);
  if (!material) {
    res.status(404).json({ message: '资料不存在' });
    return;
  }
  const allowed = user.role === 'teacher'
    ? db.prepare('SELECT 1 FROM courses WHERE id=? AND teacher_id=?').get(material.course_id, user.id)
    : db.prepare('SELECT 1 FROM course_students WHERE course_id=? AND student_id=?').get(material.course_id, user.id);
  if (!allowed) {
    res.status(403).json({ message: '无权下载该资料' });
    return;
  }
  if (!material.file_url) {
    res.status(404).json({ message: '资料文件不存在' });
    return;
  }
  const resolved = resolveUploadPath(material.file_url, { mustExist: true });
  if (!resolved) {
    res.status(404).json({ message: '资料文件不存在' });
    return;
  }
  res.download(resolved, material.file_name);
}
