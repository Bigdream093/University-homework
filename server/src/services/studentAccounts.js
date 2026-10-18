import { db } from '../db.js'

function isDetachedDisabledStudent(user) {
  if (!user || user.role !== 'student' || user.status !== 'disabled') return false
  return !db.prepare('SELECT 1 FROM course_students WHERE student_id=? LIMIT 1').get(user.id)
}

export function reactivateDetachedStudent(user, passwordHash) {
  if (!passwordHash || !isDetachedDisabledStudent(user)) return false
  const result = db
    .prepare(
      `UPDATE users
       SET password_hash=?,status='active',must_change_password=1,auth_version=auth_version+1
       WHERE id=? AND role='student' AND status='disabled'`,
    )
    .run(passwordHash, user.id)
  return result.changes > 0
}
