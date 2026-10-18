import { db } from '../db.js'
import { placeholders } from '../utils/sql.js'

const memberColumns = 'student_id,username_snapshot username,name_snapshot name'

export function assignmentGroupMembers(groupId, { ordered = false } = {}) {
  const orderBy = ordered ? ' ORDER BY student_id' : ''
  return db
    .prepare(
      `SELECT ${memberColumns} FROM assignment_group_members WHERE assignment_group_id=?${orderBy}`,
    )
    .all(groupId)
}

export function assignmentGroupMembersForGroups(groupIds) {
  if (!groupIds.length) return []
  return db
    .prepare(
      `SELECT assignment_group_id,${memberColumns} FROM assignment_group_members WHERE assignment_group_id IN (${placeholders(groupIds)}) ORDER BY student_id`,
    )
    .all(...groupIds)
}

export function assignmentGroupMembersForAssignments(assignmentIds) {
  if (!assignmentIds.length) return []
  return db
    .prepare(
      `SELECT assignment_group_id,${memberColumns} FROM assignment_group_members WHERE assignment_id IN (${placeholders(assignmentIds)}) ORDER BY student_id`,
    )
    .all(...assignmentIds)
}
