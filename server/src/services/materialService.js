import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';
import { safeName } from '../utils/fileFilter.js';
import { removeUploadFile } from '../utils/uploadPath.js';

export function listMaterials(courseId, user, res) {
  const course = db.prepare('SELECT * FROM courses WHERE id=?').get(courseId);
  if (!course) return res.status(404).json({ message: '课程不存在' });
  const viewer = user.role === 'teacher'
    ? db.prepare('SELECT 1 FROM courses WHERE id=? AND teacher_id=?').get(courseId, user.id) ? 'teacher' : null
    : db.prepare('SELECT 1 FROM course_students WHERE course_id=? AND student_id=?').get(courseId, user.id) ? 'student' : null;
  if (!viewer) return res.status(403).json({ message: '无权访问该课程' });
  res.json(db.prepare('SELECT id,title,description,file_name,file_size,file_type,created_at FROM materials WHERE course_id=? ORDER BY created_at DESC, id DESC').all(courseId));
}

export function createMaterial(courseId, teacherId, body, file, res) {
  const course = db.prepare('SELECT * FROM courses WHERE id=? AND teacher_id=?').get(courseId, teacherId);
  if (!course) {
    if (file) fs.rmSync(file.path, { force: true });
    return res.status(404).json({ message: '课程不存在' });
  }
  const title = String(body.title || '').trim();
  if (!title) {
    if (file) fs.rmSync(file.path, { force: true });
    return res.status(400).json({ message: '资料标题不能为空' });
  }
  if (!file) return res.status(400).json({ message: '请选择要上传的资料文件' });
  const info = db.prepare('INSERT INTO materials(course_id,teacher_id,title,description,file_url,file_name,file_size,file_type) VALUES(?,?,?,?,?,?,?,?)')
    .run(courseId, teacherId, title, String(body.description || ''), file.path, safeName(file.originalname), file.size, path.extname(file.originalname).slice(1).toLowerCase());
  res.status(201).json(db.prepare('SELECT id,title,description,file_name,file_size,file_type,created_at FROM materials WHERE id=?').get(info.lastInsertRowid));
}

export function updateMaterial(materialId, teacherId, body, file, res) {
  const material = db.prepare(`SELECT m.* FROM materials m JOIN courses c ON c.id=m.course_id WHERE m.id=? AND c.teacher_id=?`).get(materialId, teacherId);
  if (!material) {
    if (file) fs.rmSync(file.path, { force: true });
    return res.status(404).json({ message: '资料不存在' });
  }
  const title = String(body.title ?? material.title).trim();
  if (!title) {
    if (file) fs.rmSync(file.path, { force: true });
    return res.status(400).json({ message: '资料标题不能为空' });
  }
  let fileUrl = material.file_url, fileName = material.file_name, fileSize = material.file_size, fileType = material.file_type;
  if (file) {
    fileUrl = file.path;
    fileName = safeName(file.originalname);
    fileSize = file.size;
    fileType = path.extname(file.originalname).slice(1).toLowerCase();
  }
  db.prepare('UPDATE materials SET title=?,description=?,file_url=?,file_name=?,file_size=?,file_type=? WHERE id=?')
    .run(title, String(body.description ?? material.description), fileUrl, fileName, fileSize, fileType, material.id);
  if (file && material.file_url && material.file_url !== file.path) {
    removeUploadFile(material.file_url);
  }
  res.json(db.prepare('SELECT id,title,description,file_name,file_size,file_type,created_at FROM materials WHERE id=?').get(material.id));
}

export function deleteMaterial(materialId, teacherId, res) {
  const material = db.prepare(`SELECT m.* FROM materials m JOIN courses c ON c.id=m.course_id WHERE m.id=? AND c.teacher_id=?`).get(materialId, teacherId);
  if (!material) return res.status(404).json({ message: '资料不存在' });
  db.prepare('DELETE FROM materials WHERE id=?').run(material.id);
  removeUploadFile(material.file_url);
  res.json({ message: '资料已删除' });
}
