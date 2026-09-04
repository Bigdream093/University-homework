import { db } from '../db.js'
import { courseAccess, fail, requireRole } from './access.js'
import { nowText } from '../utils/time.js'

export function archiveCourse(courseId, user) {
  requireRole(user, 'teacher')
  return db.transaction(() => {
    const course = courseAccess(courseId, user)
    if (course.status !== 'active') fail(409, '课程已归档，无需重复操作')
    db.prepare("UPDATE courses SET status='archived',archived_at=? WHERE id=?").run(
      nowText(),
      course.id,
    )
    db.prepare(
      "UPDATE extension_requests SET status='cancelled',decision_reason='课程归档',decided_at=? WHERE status='pending' AND assignment_id IN (SELECT id FROM assignments WHERE course_id=?)",
    ).run(nowText(), course.id)
    db.prepare(
      "UPDATE notices SET status='draft',scheduled_at=NULL,updated_at=? WHERE course_id=? AND status='scheduled'",
    ).run(nowText(), course.id)
    return { message: '课程已归档' }
  })()
}
