import { db, transaction } from '../db.js';
import { queueCleanup,flushCleanup } from './storage.js';

function assignmentFileUrls(assignmentId) {
  return db.prepare(`SELECT file_url FROM submissions WHERE assignment_id=? AND file_url IS NOT NULL
    UNION SELECT h.file_url FROM submission_history h
    JOIN submissions s ON s.id=h.submission_id
    WHERE s.assignment_id=? AND h.file_url IS NOT NULL
    UNION SELECT s.file_url FROM group_submissions s JOIN assignment_groups g ON g.id=s.assignment_group_id WHERE g.assignment_id=? AND s.file_url IS NOT NULL
    UNION SELECT h.file_url FROM group_submission_history h JOIN group_submissions s ON s.id=h.group_submission_id JOIN assignment_groups g ON g.id=s.assignment_group_id WHERE g.assignment_id=? AND h.file_url IS NOT NULL`).all(assignmentId, assignmentId,assignmentId,assignmentId).map(row => row.file_url);
}

export function deleteAssignment(assignmentId) {
  const files = assignmentFileUrls(assignmentId);
  transaction(() => {queueCleanup(files,'删除作业');db.prepare('DELETE FROM assignments WHERE id=?').run(assignmentId);})();
  flushCleanup();
}

export function deleteCourse(courseId) {
  const files = [
    ...db.prepare('SELECT id FROM assignments WHERE course_id=?').all(courseId).flatMap(a=>assignmentFileUrls(a.id)),
    ...db.prepare('SELECT file_url FROM materials WHERE course_id=? AND file_url IS NOT NULL').all(courseId).map(row => row.file_url),
    ...db.prepare(`SELECT s.file_url FROM submissions s JOIN assignments a ON a.id=s.assignment_id
      WHERE a.course_id=? AND s.file_url IS NOT NULL
      UNION SELECT h.file_url FROM submission_history h
      JOIN submissions s ON s.id=h.submission_id JOIN assignments a ON a.id=s.assignment_id
      WHERE a.course_id=? AND h.file_url IS NOT NULL`).all(courseId, courseId).map(row => row.file_url)
  ];
  transaction(() => {queueCleanup(files,'删除课程');db.prepare('DELETE FROM courses WHERE id=?').run(courseId);})();
  flushCleanup();
}
