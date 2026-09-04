import { db } from '../db.js'
import { courseAccess, requireRole } from './access.js'

// 两类提交先分别按学生汇总，再合并，避免一对多 JOIN 造成乘积计数。
export const STUDENT_LIST_SQL = `
WITH counts AS (
  SELECT s.student_id, count(*) submission_count
  FROM submissions s JOIN assignments a ON a.id=s.assignment_id
  WHERE a.course_id=? GROUP BY s.student_id
  UNION ALL
  SELECT gm.student_id, count(*) submission_count
  FROM group_submissions gs
  JOIN assignment_groups ag ON ag.id=gs.assignment_group_id
  JOIN assignments a ON a.id=ag.assignment_id
  JOIN assignment_group_members gm ON gm.assignment_group_id=ag.id
  WHERE a.course_id=? GROUP BY gm.student_id
), totals AS (
  SELECT student_id, sum(submission_count) submission_count FROM counts GROUP BY student_id
)
SELECT u.id,u.username,u.name,u.status,cs.joined_at,
  coalesce(t.submission_count,0) submission_count
FROM course_students cs JOIN users u ON u.id=cs.student_id
LEFT JOIN totals t ON t.student_id=u.id
WHERE cs.course_id=? ORDER BY COALESCE(cs.sort_order,cs.id),cs.id`

export function listCourseStudents(courseId, user) {
  requireRole(user, 'teacher')
  const course = courseAccess(courseId, user)
  return db.prepare(STUDENT_LIST_SQL).all(course.id, course.id, course.id)
}
