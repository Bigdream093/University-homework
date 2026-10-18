import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { db } from '../db.js'
import { config } from '../config.js'
import { imageIds } from '../domain/richText.js'
import { queueCleanup } from './storage.js'
import { resolveUploadPath, toStorageKey } from '../utils/uploadPath.js'
import { storedFilename } from '../utils/storedFilename.js'

function assignmentFileUrls(assignmentId) {
  return db
    .prepare(
      `SELECT file_url FROM submissions WHERE assignment_id=? AND file_url IS NOT NULL
    UNION SELECT h.file_url FROM submission_history h
    JOIN submissions s ON s.id=h.submission_id
    WHERE s.assignment_id=? AND h.file_url IS NOT NULL
    UNION SELECT s.file_url FROM group_submissions s JOIN assignment_groups g ON g.id=s.assignment_group_id WHERE g.assignment_id=? AND s.file_url IS NOT NULL
    UNION SELECT h.file_url FROM group_submission_history h JOIN group_submissions s ON s.id=h.group_submission_id JOIN assignment_groups g ON g.id=s.assignment_group_id WHERE g.assignment_id=? AND h.file_url IS NOT NULL
    UNION SELECT p.file_url FROM submission_preview_images p LEFT JOIN submission_history h ON h.id=p.submission_history_id LEFT JOIN submissions s ON s.id=h.submission_id LEFT JOIN group_submission_history gh ON gh.id=p.group_submission_history_id LEFT JOIN group_submissions gs ON gs.id=gh.group_submission_id LEFT JOIN assignment_groups g ON g.id=gs.assignment_group_id WHERE COALESCE(s.assignment_id,g.assignment_id)=? AND p.file_url IS NOT NULL
    UNION SELECT p.thumbnail_url file_url FROM submission_preview_images p LEFT JOIN submission_history h ON h.id=p.submission_history_id LEFT JOIN submissions s ON s.id=h.submission_id LEFT JOIN group_submission_history gh ON gh.id=p.group_submission_history_id LEFT JOIN group_submissions gs ON gs.id=gh.group_submission_id LEFT JOIN assignment_groups g ON g.id=gs.assignment_group_id WHERE COALESCE(s.assignment_id,g.assignment_id)=? AND p.thumbnail_url IS NOT NULL`,
    )
    .all(assignmentId, assignmentId, assignmentId, assignmentId, assignmentId, assignmentId)
    .map((row) => row.file_url)
}

export function deleteAssignment(assignmentId) {
  const files = assignmentFileUrls(assignmentId)
  db.transaction(() => {
    queueCleanup(files, '删除作业')
    db.prepare('DELETE FROM assignments WHERE id=?').run(assignmentId)
  })()
}

export function deleteCourse(courseId) {
  const files = [
    ...db
      .prepare('SELECT id FROM assignments WHERE course_id=?')
      .all(courseId)
      .flatMap((assignment) => assignmentFileUrls(assignment.id)),
    ...db
      .prepare('SELECT file_url FROM materials WHERE course_id=? AND file_url IS NOT NULL')
      .all(courseId)
      .map((row) => row.file_url),
    ...db
      .prepare('SELECT file_url FROM editor_images WHERE course_id=?')
      .all(courseId)
      .map((row) => row.file_url),
  ]
  const copiedAssignments = db
    .prepare(
      "WITH RECURSIVE copies(id) AS (SELECT id FROM courses WHERE copied_from_id=? UNION SELECT c.id FROM courses c JOIN copies p ON c.copied_from_id=p.id) SELECT a.course_id,a.id assignment_id,a.description FROM assignments a JOIN copies c ON c.id=a.course_id WHERE a.description_format='html'",
    )
    .all(courseId)
  const sourceImages = new Map(
    db
      .prepare('SELECT * FROM editor_images WHERE course_id=?')
      .all(courseId)
      .map((image) => [image.id, image]),
  )
  const copiedImages = new Map(),
    rewrittenAssignments = []
  try {
    for (const assignment of copiedAssignments) {
      let description = assignment.description
      for (const id of imageIds(description)) {
        const image = sourceImages.get(id)
        if (!image) continue
        const key = `${assignment.course_id}:${id}`
        let copy = copiedImages.get(key)
        if (!copy) {
          const source = resolveUploadPath(image.file_url, { mustExist: true })
          if (!source) continue
          const newId = randomUUID()
          const target = path.join(config.uploadDir, 'editor-images', storedFilename(source, newId))
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
          copy = {
            courseId: assignment.course_id,
            image,
            id: newId,
            file: target,
          }
          copiedImages.set(key, copy)
        }
        description = description.replaceAll(
          `/api/editor-images/${id}`,
          `/api/editor-images/${copy.id}`,
        )
      }
      if (description !== assignment.description)
        rewrittenAssignments.push({
          id: assignment.assignment_id,
          courseId: assignment.course_id,
          description,
        })
    }
    db.transaction(() => {
      for (const copy of copiedImages.values())
        db.prepare(
          'INSERT INTO editor_images(id,course_id,uploader_id,file_url) VALUES(?,?,?,?)',
        ).run(copy.id, copy.courseId, copy.image.uploader_id, toStorageKey(copy.file))
      for (const assignment of rewrittenAssignments)
        db.prepare('UPDATE assignments SET description=? WHERE id=? AND course_id=?').run(
          assignment.description,
          assignment.id,
          assignment.courseId,
        )
      queueCleanup(files, '删除课程')
      db.prepare('DELETE FROM courses WHERE id=?').run(courseId)
    })()
  } catch (error) {
    for (const copy of copiedImages.values()) fs.rmSync(copy.file, { force: true })
    throw error
  }
}
