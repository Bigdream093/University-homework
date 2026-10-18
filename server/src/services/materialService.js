import { nextOrder } from './contentOrder.js'
import { LIMITS } from '@university-homework/domain/limits'
import { db } from '../db.js'
import { courseAccess, fail, textValue } from './access.js'
import { fileExtension, safeName } from '../utils/fileFilter.js'
import { nowText } from '../utils/time.js'
import { queueCleanup } from './storage.js'

function materialView(id) {
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

// Keep writes, replacement cleanup and completion callbacks in the same transaction.
export function saveMaterial({ mode, courseId, materialId, user, file, metadata, onSaved }) {
  return db.transaction(() => {
    if (!['create', 'update'].includes(mode)) fail(400, '资料保存模式无效')
    const course = courseAccess(courseId, user, { write: true, teacher: true })
    const current =
      mode === 'update'
        ? db
            .prepare('SELECT * FROM materials WHERE id=? AND course_id=?')
            .get(materialId, course.id)
        : null
    if (mode === 'update' && !current) fail(404, '资料不存在')
    if (mode === 'create' && !file) fail(400, '请选择资料文件')
    const title = textValue(metadata.title ?? current?.title, '资料标题', LIMITS.materialTitle),
      description = textValue(
        metadata.description ?? current?.description,
        '资料说明',
        LIMITS.materialDescription,
        false,
      )
    let id
    if (mode === 'create') {
      id = db
        .prepare(
          'INSERT INTO materials(course_id,teacher_id,title,description,file_url,file_name,file_size,file_type,created_at,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          course.id,
          user.id,
          title,
          description,
          file.storageKey,
          safeName(file.originalname),
          file.size,
          fileExtension(file.originalname),
          nowText(),
          nextOrder('materials', 'course_id', course.id),
        ).lastInsertRowid
    } else {
      db.prepare(
        'UPDATE materials SET title=?,description=?,file_url=?,file_name=?,file_size=?,file_type=? WHERE id=?',
      ).run(
        title,
        description,
        file?.storageKey || current.file_url,
        file ? safeName(file.originalname) : current.file_name,
        file?.size ?? current.file_size,
        file ? fileExtension(file.originalname) : current.file_type,
        current.id,
      )
      if (file) queueCleanup([current.file_url], '资料替换')
      id = current.id
    }
    const result = materialView(id)
    onSaved?.(result)
    return result
  })()
}

export function saveMaterialSession({ session, user, file, metadata, onSaved }) {
  return saveMaterial({
    mode: session.mode,
    courseId: session.course_id,
    materialId: session.material_id,
    user,
    file,
    metadata,
    onSaved,
  })
}
