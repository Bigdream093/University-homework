import { db, transaction } from '../db.js';
import { removeUploadFile } from '../utils/uploadPath.js';

function assignmentFileUrls(assignmentId) {
  return db.prepare(`SELECT file_url FROM submissions WHERE assignment_id=? AND file_url IS NOT NULL
    UNION SELECT h.file_url FROM submission_history h
    JOIN submissions s ON s.id=h.submission_id
    WHERE s.assignment_id=? AND h.file_url IS NOT NULL`).all(assignmentId, assignmentId).map(row => row.file_url);
}

export function deleteAssignment(assignmentId) {
  const files = assignmentFileUrls(assignmentId);
  transaction(() => db.prepare('DELETE FROM assignments WHERE id=?').run(assignmentId))();
  files.forEach(removeUploadFile);
}

export function deleteCourse(courseId) {
  const files = [
    ...db.prepare('SELECT file_url FROM materials WHERE course_id=? AND file_url IS NOT NULL').all(courseId).map(row => row.file_url),
    ...db.prepare(`SELECT s.file_url FROM submissions s JOIN assignments a ON a.id=s.assignment_id
      WHERE a.course_id=? AND s.file_url IS NOT NULL
      UNION SELECT h.file_url FROM submission_history h
      JOIN submissions s ON s.id=h.submission_id JOIN assignments a ON a.id=s.assignment_id
      WHERE a.course_id=? AND h.file_url IS NOT NULL`).all(courseId, courseId).map(row => row.file_url)
  ];
  transaction(() => db.prepare('DELETE FROM courses WHERE id=?').run(courseId))();
  [...new Set(files)].forEach(removeUploadFile);
}
