import { db } from '../db.js'
import { placeholders } from '../utils/sql.js'
import { courseAccess } from './access.js'
import { nowText } from '../utils/time.js'
import { canSubmitAssignment } from '../domain/submissionPolicy.js'

function withTeacherStats(rows, courseId) {
  const roster = db
    .prepare(
      "SELECT count(*) total,sum(instr(u.name,'测试员')=0) counted FROM course_students cs JOIN users u ON u.id=cs.student_id WHERE cs.course_id=?",
    )
    .get(courseId)
  const individual = new Map(
    db
      .prepare(
        `SELECT s.assignment_id,sum(instr(u.name,'测试员')=0) submitted,
  sum(s.status='submitted' AND instr(u.name,'测试员')=0) pending_review,sum(s.status='returned') returned
  FROM submissions s JOIN assignments a ON a.id=s.assignment_id JOIN users u ON u.id=s.student_id WHERE a.course_id=? GROUP BY s.assignment_id`,
      )
      .all(courseId)
      .map((row) => [row.assignment_id, row]),
  )
  const groups = new Map(
    db
      .prepare(
        `SELECT g.assignment_id,count(*) total_expected,
  sum(EXISTS(SELECT 1 FROM assignment_group_members m WHERE m.assignment_group_id=g.id AND instr(m.name_snapshot,'测试员')=0)) expected,
  sum(CASE WHEN s.id IS NOT NULL AND EXISTS(SELECT 1 FROM assignment_group_members m WHERE m.assignment_group_id=g.id AND instr(m.name_snapshot,'测试员')=0) THEN 1 ELSE 0 END) submitted,
  coalesce(sum(CASE WHEN s.status='submitted' AND EXISTS(SELECT 1 FROM assignment_group_members m WHERE m.assignment_group_id=g.id AND instr(m.name_snapshot,'测试员')=0) THEN 1 ELSE 0 END),0) pending_review,coalesce(sum(s.status='returned'),0) returned
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
    const expected =
      assignment.work_mode === 'group' ? Number(stats.total_expected || 0) : roster.total
    const unsubmittedExpected =
      assignment.work_mode === 'group' ? Number(stats.expected || 0) : Number(roster.counted || 0)
    return {
      ...assignment,
      expected_count: expected,
      unsubmitted_expected_count: unsubmittedExpected,
      unsubmitted_count: Math.max(0, unsubmittedExpected - Number(stats.submitted || 0)),
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
  if (user.role === 'student' && rows.length) {
    const assignmentIds = rows.map((assignment) => assignment.id)
    const groups = new Map(
      db
        .prepare(
          `SELECT g.assignment_id,g.id,g.submitter_id FROM assignment_groups g
          JOIN assignment_group_members m ON m.assignment_group_id=g.id
          WHERE g.assignment_id IN (${placeholders(assignmentIds)}) AND m.student_id=?`,
        )
        .all(...assignmentIds, user.id)
        .map((group) => [group.assignment_id, group]),
    )
    const individualSubmissions = new Map(
      db
        .prepare(
          `SELECT assignment_id,status,submitted_at,returned_reason FROM submissions
          WHERE student_id=? AND assignment_id IN (${placeholders(assignmentIds)})`,
        )
        .all(user.id, ...assignmentIds)
        .map((submission) => [submission.assignment_id, submission]),
    )
    const groupIds = [...groups.values()].map((group) => group.id)
    const groupSubmissions = new Map(
      groupIds.length
        ? db
            .prepare(
              `SELECT assignment_group_id,status,submitted_at,returned_reason FROM group_submissions
              WHERE assignment_group_id IN (${placeholders(groupIds)})`,
            )
            .all(...groupIds)
            .map((submission) => [submission.assignment_group_id, submission])
        : [],
    )
    const extensionParams = [user.id, ...groupIds]
    const extensionRows = db
      .prepare(
        `SELECT assignment_id,student_id,assignment_group_id,approved_deadline FROM extension_requests
        WHERE status='approved' AND assignment_id IN (${placeholders(assignmentIds)})
        AND ((student_id=? AND assignment_group_id IS NULL)${groupIds.length ? ` OR assignment_group_id IN (${placeholders(groupIds)})` : ''})
        ORDER BY approved_deadline DESC,id DESC`,
      )
      .all(...assignmentIds, ...extensionParams)
    const extensions = new Map()
    for (const extension of extensionRows) {
      const subjectId = extension.assignment_group_id ?? extension.student_id
      const key = `${extension.assignment_id}:${subjectId}`
      if (!extensions.has(key)) extensions.set(key, extension.approved_deadline)
    }
    return rows.map((assignment) => {
      const group = assignment.work_mode === 'group' ? groups.get(assignment.id) : null
      const submission = group
        ? groupSubmissions.get(group.id)
        : individualSubmissions.get(assignment.id)
      const notAssigned = assignment.work_mode === 'group' && !group
      const canSubmit = canSubmitAssignment(assignment, course.status, group, user.id)
      const baseDeadline = assignment.deadline || null
      const subjectId = group?.id ?? user.id
      const extensionDeadline = baseDeadline
        ? extensions.get(`${assignment.id}:${subjectId}`)
        : null
      return {
        ...assignment,
        submission_status: submission?.status,
        returned_reason: submission?.status === 'returned' ? submission.returned_reason : undefined,
        submitted_at: submission?.submitted_at,
        can_submit: canSubmit,
        not_assigned: notAssigned,
        effective_deadline: notAssigned
          ? null
          : extensionDeadline > baseDeadline
            ? extensionDeadline
            : baseDeadline,
        server_now: nowText(),
      }
    })
  }
  return rows.map((assignment) => ({ ...assignment, server_now: nowText() }))
}
