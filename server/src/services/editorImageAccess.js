import { db } from '../db.js'
import { imageIds } from '../domain/markdown.js'
import { fail } from './access.js'

export function canReadEditorImage(row, user) {
  const ownsSource =
    user.role === 'teacher' &&
    db.prepare('SELECT 1 FROM courses WHERE id=? AND teacher_id=?').get(row.course_id, user.id)
  const ownUpload =
    row.uploader_id === user.id &&
    db
      .prepare('SELECT 1 FROM course_students WHERE course_id=? AND student_id=?')
      .get(row.course_id, user.id)
  let allowed = !!ownsSource || !!ownUpload
  if (!allowed) {
    const courses =
      user.role === 'teacher'
        ? db.prepare('SELECT id FROM courses WHERE teacher_id=?').all(user.id)
        : db.prepare('SELECT course_id AS id FROM course_students WHERE student_id=?').all(user.id)
    for (const course of courses) {
      const rows = db
        .prepare(
          `SELECT description AS content FROM assignments WHERE course_id=? AND description_format='markdown' ${user.role === 'student' ? "AND status IN ('published','closed')" : ''}
        UNION ALL SELECT content FROM notices WHERE course_id=? AND content_format='markdown' ${user.role === 'student' ? "AND status='published'" : ''}`,
        )
        .all(course.id, course.id)
      if (user.role === 'teacher')
        rows.push(
          ...db
            .prepare(
              "SELECT r.content FROM notice_revisions r JOIN notices n ON n.id=r.notice_id WHERE n.course_id=? AND r.content_format='markdown'",
            )
            .all(course.id),
        )
      const privateFilter = user.role === 'teacher' ? '' : ' AND q.student_id=?'
      const args = user.role === 'teacher' ? [course.id] : [course.id, user.id]
      rows.push(
        ...db
          .prepare(
            `SELECT q.content FROM course_questions q WHERE q.course_id=? AND q.content_format='markdown' ${privateFilter}`,
          )
          .all(...args),
      )
      rows.push(
        ...db
          .prepare(
            `SELECT r.content FROM question_replies r JOIN course_questions q ON q.id=r.question_id WHERE q.course_id=? AND r.content_format='markdown' ${privateFilter}`,
          )
          .all(...args),
      )
      const pubs = db
        .prepare(
          `SELECT p.summary,p.reply FROM question_publications p JOIN course_questions q ON q.id=p.question_id WHERE q.course_id=? AND p.content_format='markdown' ${user.role === 'teacher' ? '' : "AND ((p.status='published' AND q.hidden=0) OR q.student_id=?)"}`,
        )
        .all(...args)
      for (const pub of pubs) rows.push({ content: pub.summary }, { content: pub.reply })
      if (rows.some((item) => imageIds(item.content).has(row.id))) {
        allowed = true
        break
      }
    }
  }
  return allowed
}

export function validateEditorImages(content, format, user) {
  if (format !== 'markdown') return
  for (const id of imageIds(content)) {
    const row = db.prepare('SELECT * FROM editor_images WHERE id=?').get(id)
    if (!row || !canReadEditorImage(row, user)) fail(403, '正文包含不存在或无权使用的图片')
  }
}
