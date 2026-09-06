import { db, transaction } from "../db.js";
import { queueCleanup } from "./storage.js";

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
    .all(
      assignmentId,
      assignmentId,
      assignmentId,
      assignmentId,
      assignmentId,
      assignmentId,
    )
    .map((row) => row.file_url);
}

export function deleteAssignment(assignmentId) {
  const files = assignmentFileUrls(assignmentId);
  transaction(() => {
    queueCleanup(files, "删除作业");
    db.prepare("DELETE FROM assignments WHERE id=?").run(assignmentId);
  })();
}

export function deleteCourse(courseId) {
  const files = [
    ...db
      .prepare("SELECT id FROM assignments WHERE course_id=?")
      .all(courseId)
      .flatMap((assignment) => assignmentFileUrls(assignment.id)),
    ...db
      .prepare(
        "SELECT file_url FROM materials WHERE course_id=? AND file_url IS NOT NULL",
      )
      .all(courseId)
      .map((row) => row.file_url),
    ...db
      .prepare("SELECT file_url FROM editor_images WHERE course_id=?")
      .all(courseId)
      .map((row) => row.file_url),
  ];
  transaction(() => {
    queueCleanup(files, "删除课程");
    db.prepare("DELETE FROM courses WHERE id=?").run(courseId);
  })();
}
