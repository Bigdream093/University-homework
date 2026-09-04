import path from 'node:path'
import { db } from '../db.js'
import { courseAccess, fail, textValue } from './access.js'
import { safeName } from '../utils/fileFilter.js'
import { nowText } from '../utils/time.js'
import { queueCleanup } from './storage.js'

export function materialView(id) {
  return db
    .prepare(
      'SELECT m.id,m.title,m.description,m.file_name,m.file_size,m.file_type,m.created_at,COALESCE((SELECT SUM(download_count) FROM material_downloads d WHERE d.material_id=m.id),0) download_count FROM materials m WHERE m.id=?',
    )
    .get(id)
}

export function deleteMaterial(id, user) {
  const row = db.prepare('SELECT * FROM materials WHERE id=?').get(id)
  if (!row) fail(404, '资料不存在')
  courseAccess(row.course_id, user, { write: true })
  db.transaction(() => {
    queueCleanup([row.file_url], '删除资料')
    db.prepare('DELETE FROM materials WHERE id=?').run(row.id)
  })()
}

export function saveMaterialSession({ session, user, file, metadata, onSaved }) {
  const title = textValue(metadata.title, '资料标题', 200),
    description = textValue(metadata.description, '资料说明', 20000, false)
  return db.transaction(() => {
    const course = courseAccess(session.course_id, user, { write: true, teacher: true })
    if (session.mode === 'create') {
      const id = db
        .prepare(
          'INSERT INTO materials(course_id,teacher_id,title,description,file_url,file_name,file_size,file_type,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        )
        .run(
          course.id,
          user.id,
          title,
          description,
          file.storageKey,
          safeName(file.originalname),
          file.size,
          path.extname(file.originalname).slice(1).toLowerCase(),
          nowText(),
        ).lastInsertRowid
      const result = materialView(id)
      onSaved?.(result)
      return result
    }
    const current = db
      .prepare('SELECT * FROM materials WHERE id=? AND course_id=?')
      .get(session.material_id, course.id)
    if (!current) fail(404, '资料不存在')
    db.prepare(
      'UPDATE materials SET title=?,description=?,file_url=?,file_name=?,file_size=?,file_type=? WHERE id=?',
    ).run(
      title,
      description,
      file.storageKey,
      safeName(file.originalname),
      file.size,
      path.extname(file.originalname).slice(1).toLowerCase(),
      current.id,
    )
    queueCleanup([current.file_url], '资料替换')
    const result = materialView(current.id)
    onSaved?.(result)
    return result
  })()
}
