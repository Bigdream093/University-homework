import { db } from '../db.js'
import { nowText } from '../utils/time.js'
import { queueCleanup } from './storage.js'

function studentInCourse(courseId, studentId) {
  return db
    .prepare(
      `SELECT u.id,u.username,u.name FROM users u JOIN course_students cs ON cs.student_id=u.id
    WHERE cs.course_id=? AND u.id=? AND u.role='student'`,
    )
    .get(courseId, studentId)
}

export function removalImpact(courseId, studentId) {
  const student = studentInCourse(courseId, studentId)
  if (!student) return null
  const value = (sql) => db.prepare(sql).get(courseId, studentId).count
  const activity = db
    .prepare(
      `SELECT (SELECT count(*) FROM notice_reads r JOIN notices n ON n.id=r.notice_id WHERE n.course_id=? AND r.student_id=?)+
    (SELECT count(*) FROM material_downloads d JOIN materials m ON m.id=d.material_id WHERE m.course_id=? AND d.student_id=?) count`,
    )
    .get(courseId, studentId, courseId, studentId).count
  return {
    ...student,
    submissions: value(
      'SELECT count(*) count FROM submissions s JOIN assignments a ON a.id=s.assignment_id WHERE a.course_id=? AND s.student_id=?',
    ),
    history: value(
      'SELECT count(*) count FROM submission_history h JOIN submissions s ON s.id=h.submission_id JOIN assignments a ON a.id=s.assignment_id WHERE a.course_id=? AND s.student_id=?',
    ),
    previews: value(
      'SELECT count(*) count FROM submission_preview_images p JOIN submission_history h ON h.id=p.submission_history_id JOIN submissions s ON s.id=h.submission_id JOIN assignments a ON a.id=s.assignment_id WHERE a.course_id=? AND s.student_id=?',
    ),
    questions: value(
      'SELECT count(*) count FROM course_questions WHERE course_id=? AND student_id=?',
    ),
    group_assignments: value(
      'SELECT count(*) count FROM assignment_group_members m JOIN assignments a ON a.id=m.assignment_id WHERE a.course_id=? AND m.student_id=?',
    ),
    activity,
  }
}

function individualFiles(courseId, studentId) {
  return db
    .prepare(
      `SELECT s.file_url path FROM submissions s JOIN assignments a ON a.id=s.assignment_id WHERE a.course_id=? AND s.student_id=? AND s.file_url IS NOT NULL
    UNION SELECT h.file_url FROM submission_history h JOIN submissions s ON s.id=h.submission_id JOIN assignments a ON a.id=s.assignment_id WHERE a.course_id=? AND s.student_id=? AND h.file_url IS NOT NULL
    UNION SELECT p.file_url FROM submission_preview_images p JOIN submission_history h ON h.id=p.submission_history_id JOIN submissions s ON s.id=h.submission_id JOIN assignments a ON a.id=s.assignment_id WHERE a.course_id=? AND s.student_id=? AND p.file_url IS NOT NULL
    UNION SELECT p.thumbnail_url FROM submission_preview_images p JOIN submission_history h ON h.id=p.submission_history_id JOIN submissions s ON s.id=h.submission_id JOIN assignments a ON a.id=s.assignment_id WHERE a.course_id=? AND s.student_id=? AND p.thumbnail_url IS NOT NULL`,
    )
    .all(courseId, studentId, courseId, studentId, courseId, studentId, courseId, studentId)
    .map((row) => row.path)
}

function emptyGroupFiles(courseId, studentId) {
  return db
    .prepare(
      `SELECT s.file_url path FROM group_submissions s JOIN assignment_groups g ON g.id=s.assignment_group_id JOIN assignments a ON a.id=g.assignment_id WHERE a.course_id=? AND s.file_url IS NOT NULL AND EXISTS(SELECT 1 FROM assignment_group_members mine WHERE mine.assignment_group_id=g.id AND mine.student_id=?) AND NOT EXISTS(SELECT 1 FROM assignment_group_members other WHERE other.assignment_group_id=g.id AND other.student_id<>?)
    UNION SELECT h.file_url FROM group_submission_history h JOIN group_submissions s ON s.id=h.group_submission_id JOIN assignment_groups g ON g.id=s.assignment_group_id JOIN assignments a ON a.id=g.assignment_id WHERE a.course_id=? AND h.file_url IS NOT NULL AND EXISTS(SELECT 1 FROM assignment_group_members mine WHERE mine.assignment_group_id=g.id AND mine.student_id=?) AND NOT EXISTS(SELECT 1 FROM assignment_group_members other WHERE other.assignment_group_id=g.id AND other.student_id<>?)
    UNION SELECT p.file_url FROM submission_preview_images p JOIN group_submission_history h ON h.id=p.group_submission_history_id JOIN group_submissions s ON s.id=h.group_submission_id JOIN assignment_groups g ON g.id=s.assignment_group_id JOIN assignments a ON a.id=g.assignment_id WHERE a.course_id=? AND p.file_url IS NOT NULL AND EXISTS(SELECT 1 FROM assignment_group_members mine WHERE mine.assignment_group_id=g.id AND mine.student_id=?) AND NOT EXISTS(SELECT 1 FROM assignment_group_members other WHERE other.assignment_group_id=g.id AND other.student_id<>?)
    UNION SELECT p.thumbnail_url FROM submission_preview_images p JOIN group_submission_history h ON h.id=p.group_submission_history_id JOIN group_submissions s ON s.id=h.group_submission_id JOIN assignment_groups g ON g.id=s.assignment_group_id JOIN assignments a ON a.id=g.assignment_id WHERE a.course_id=? AND p.thumbnail_url IS NOT NULL AND EXISTS(SELECT 1 FROM assignment_group_members mine WHERE mine.assignment_group_id=g.id AND mine.student_id=?) AND NOT EXISTS(SELECT 1 FROM assignment_group_members other WHERE other.assignment_group_id=g.id AND other.student_id<>?)`,
    )
    .all(
      courseId,
      studentId,
      studentId,
      courseId,
      studentId,
      studentId,
      courseId,
      studentId,
      studentId,
      courseId,
      studentId,
      studentId,
    )
    .map((row) => row.path)
}

function anonymizeGroupReceipts(courseId, student) {
  const rows = db
    .prepare(
      `SELECT r.id,r.snapshot_json FROM submission_receipts r JOIN assignment_groups g ON g.id=r.assignment_group_id JOIN assignments a ON a.id=g.assignment_id
    WHERE a.course_id=? AND EXISTS(SELECT 1 FROM assignment_group_members m WHERE m.assignment_group_id=g.id AND m.student_id=?)`,
    )
    .all(courseId, student.id)
  const update = db.prepare('UPDATE submission_receipts SET snapshot_json=? WHERE id=?')
  for (const row of rows) {
    const snapshot = JSON.parse(row.snapshot_json)
    if (snapshot.group?.members)
      snapshot.group.members = snapshot.group.members.filter(
        (member) => member.username !== student.username,
      )
    if (snapshot.student?.username === student.username)
      snapshot.student = { username: '已移除', name: '已移除学生' }
    if (snapshot.file_name)
      snapshot.file_name = snapshot.file_name.replace(`_${student.username}_`, '_已移除_')
    update.run(JSON.stringify(snapshot), row.id)
  }
}

export function removeStudent(courseId, studentId) {
  const student = studentInCourse(courseId, studentId)
  if (!student) return null
  const files = [...individualFiles(courseId, studentId), ...emptyGroupFiles(courseId, studentId)]
  const sessions = db
    .prepare(
      `SELECT f.temporary_path path FROM upload_session_files f JOIN upload_sessions s ON s.id=f.session_id JOIN assignments a ON a.id=s.assignment_id WHERE a.course_id=? AND s.actor_id=?`,
    )
    .all(courseId, studentId)
    .map((row) => row.path)
  db.transaction(() => {
    queueCleanup([...files, ...sessions], '移除学生')
    anonymizeGroupReceipts(courseId, student)
    db.prepare(
      "UPDATE group_submissions SET file_name=replace(file_name,?,'_已移除_') WHERE submitted_by=? AND assignment_group_id IN (SELECT g.id FROM assignment_groups g JOIN assignments a ON a.id=g.assignment_id WHERE a.course_id=?)",
    ).run(`_${student.username}_`, studentId, courseId)
    db.prepare(
      "UPDATE group_submission_history SET file_name=replace(file_name,?,'_已移除_') WHERE submitted_by=? AND group_submission_id IN (SELECT s.id FROM group_submissions s JOIN assignment_groups g ON g.id=s.assignment_group_id JOIN assignments a ON a.id=g.assignment_id WHERE a.course_id=?)",
    ).run(`_${student.username}_`, studentId, courseId)
    db.prepare(
      'UPDATE group_submissions SET submitted_by=NULL WHERE submitted_by=? AND assignment_group_id IN (SELECT g.id FROM assignment_groups g JOIN assignments a ON a.id=g.assignment_id WHERE a.course_id=?)',
    ).run(studentId, courseId)
    db.prepare(
      'UPDATE group_submission_history SET submitted_by=NULL WHERE submitted_by=? AND group_submission_id IN (SELECT s.id FROM group_submissions s JOIN assignment_groups g ON g.id=s.assignment_group_id JOIN assignments a ON a.id=g.assignment_id WHERE a.course_id=?)',
    ).run(studentId, courseId)
    db.prepare(
      'DELETE FROM submissions WHERE student_id=? AND assignment_id IN (SELECT id FROM assignments WHERE course_id=?)',
    ).run(studentId, courseId)
    db.prepare(
      'DELETE FROM question_replies WHERE author_id=? AND question_id IN (SELECT id FROM course_questions WHERE course_id=?)',
    ).run(studentId, courseId)
    db.prepare('DELETE FROM course_questions WHERE course_id=? AND student_id=?').run(
      courseId,
      studentId,
    )
    db.prepare(
      "UPDATE course_questions SET status='open',updated_at=? WHERE course_id=? AND status='answered' AND NOT EXISTS(SELECT 1 FROM question_replies r JOIN users u ON u.id=r.author_id WHERE r.question_id=course_questions.id AND u.role='teacher')",
    ).run(nowText(), courseId)
    db.prepare(
      'DELETE FROM notice_reads WHERE student_id=? AND notice_id IN (SELECT id FROM notices WHERE course_id=?)',
    ).run(studentId, courseId)
    db.prepare(
      'DELETE FROM material_download_events WHERE student_id=? AND material_id IN (SELECT id FROM materials WHERE course_id=?)',
    ).run(studentId, courseId)
    db.prepare(
      'DELETE FROM material_downloads WHERE student_id=? AND material_id IN (SELECT id FROM materials WHERE course_id=?)',
    ).run(studentId, courseId)
    db.prepare(
      'DELETE FROM extension_requests WHERE assignment_id IN (SELECT id FROM assignments WHERE course_id=?) AND (student_id=? OR requester_id=?)',
    ).run(courseId, studentId, studentId)
    db.prepare(
      "DELETE FROM operation_requests WHERE actor_id=? AND kind='submission' AND target_id IN (SELECT id FROM assignments WHERE course_id=?)",
    ).run(studentId, courseId)
    db.prepare(
      'DELETE FROM upload_sessions WHERE actor_id=? AND assignment_id IN (SELECT id FROM assignments WHERE course_id=?)',
    ).run(studentId, courseId)
    db.prepare('DELETE FROM course_group_members WHERE course_id=? AND student_id=?').run(
      courseId,
      studentId,
    )
    db.prepare(
      'UPDATE course_groups SET leader_id=(SELECT MIN(m.student_id) FROM course_group_members m WHERE m.course_group_id=course_groups.id) WHERE course_id=? AND leader_id=?',
    ).run(courseId, studentId)
    db.prepare(
      'DELETE FROM course_groups WHERE course_id=? AND NOT EXISTS(SELECT 1 FROM course_group_members m WHERE m.course_group_id=course_groups.id)',
    ).run(courseId)
    db.prepare(
      'DELETE FROM assignment_group_members WHERE assignment_id IN (SELECT id FROM assignments WHERE course_id=?) AND student_id=?',
    ).run(courseId, studentId)
    db.prepare(
      'UPDATE assignment_groups SET submitter_id=(SELECT MIN(m.student_id) FROM assignment_group_members m WHERE m.assignment_group_id=assignment_groups.id) WHERE assignment_id IN (SELECT id FROM assignments WHERE course_id=?) AND submitter_id=?',
    ).run(courseId, studentId)
    db.prepare(
      'DELETE FROM assignment_groups WHERE assignment_id IN (SELECT id FROM assignments WHERE course_id=?) AND NOT EXISTS(SELECT 1 FROM assignment_group_members m WHERE m.assignment_group_id=assignment_groups.id)',
    ).run(courseId)
    db.prepare('DELETE FROM course_students WHERE course_id=? AND student_id=?').run(
      courseId,
      studentId,
    )
  })()
  return student
}
