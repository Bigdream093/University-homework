import { db } from '../db.js'
import { courseAccess, subjectFor } from './access.js'
import { nowText } from '../utils/time.js'
import { effectiveDeadline } from './extensions.js'

function withTeacherStats(rows, courseId) {
  const studentTotal = db
    .prepare('SELECT count(*) total FROM course_students WHERE course_id=?')
    .get(courseId).total
  const individual = new Map(
    db
      .prepare(
        `SELECT s.assignment_id,count(*) submitted,
  sum(s.status='submitted') pending_review,sum(s.status='returned') returned
  FROM submissions s JOIN assignments a ON a.id=s.assignment_id WHERE a.course_id=? GROUP BY s.assignment_id`,
      )
      .all(courseId)
      .map((row) => [row.assignment_id, row]),
  )
  const groups = new Map(
    db
      .prepare(
        `SELECT g.assignment_id,count(*) expected,count(s.id) submitted,
  coalesce(sum(s.status='submitted'),0) pending_review,coalesce(sum(s.status='returned'),0) returned
  FROM assignment_groups g LEFT JOIN group_submissions s ON s.assignment_group_id=g.id
  WHERE g.assignment_id IN (SELECT id FROM assignments WHERE course_id=?) GROUP BY g.assignment_id`,
      )
      .all(courseId)
      .map((row) => [row.assignment_id, row]),
  )
  return rows.map((assignment) => {
    const stats =
      assignment.work_mode === 'group'
        ? groups.get(assignment.id) || {}
        : individual.get(assignment.id) || {}
    const expected = assignment.work_mode === 'group' ? Number(stats.expected || 0) : studentTotal
    return {
      ...assignment,
      expected_count: expected,
      unsubmitted_count: Math.max(0, expected - Number(stats.submitted || 0)),
      pending_review_count: Number(stats.pending_review || 0),
      returned_count: Number(stats.returned || 0),
    }
  })
}
export function listAssignments(courseId, user) {
  const course = courseAccess(courseId, user)
  let rows = db
    .prepare(
      'SELECT * FROM assignments WHERE course_id=?' +
        (user.role === 'student' ? " AND status IN ('published','closed')" : '') +
        ' ORDER BY sort_order,id',
    )
    .all(course.id)
  if (user.role === 'teacher') rows = withTeacherStats(rows, course.id)
  return rows.map((assignment) => {
    if (user.role === 'student') {
      const subject = subjectFor({ ...assignment, course_status: course.status }, user)
      const submission = subject.not_assigned
        ? null
        : subject.group
          ? db
              .prepare(
                'SELECT status,submitted_at FROM group_submissions WHERE assignment_group_id=?',
              )
              .get(subject.group.id)
          : db
              .prepare(
                'SELECT status,submitted_at FROM submissions WHERE assignment_id=? AND student_id=?',
              )
              .get(assignment.id, user.id)
      return {
        ...assignment,
        submission_status: submission?.status,
        submitted_at: submission?.submitted_at,
        can_submit: subject.can_submit,
        not_assigned: subject.not_assigned || false,
        effective_deadline: subject.not_assigned
          ? null
          : effectiveDeadline(assignment, subject).deadline,
        server_now: nowText(),
      }
    }
    return { ...assignment, server_now: nowText() }
  })
}
