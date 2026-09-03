import { db } from '../db.js'
import { assignmentAccess, subjectFor, fail } from './access.js'
import { resolveUploadPath } from '../utils/uploadPath.js'
export function studentView(row) {
  if (!row) return null
  const { score, comment, graded_at, file_url, ...safe } = row
  const actor = row.submitted_by
    ? db.prepare('SELECT name,username FROM users WHERE id=?').get(row.submitted_by)
    : null
  return {
    ...safe,
    submitted_by_name: actor?.name,
    submitted_by_username: actor?.username,
    api_base: (row.kind === 'group' ? '/group-submissions/' : '/submissions/') + row.id,
    version: row.submit_count,
  }
}
export function submissionAccess(id, user, group = false, write = false) {
  const row = group
    ? db
        .prepare(
          'SELECT s.*,g.assignment_id FROM group_submissions s JOIN assignment_groups g ON g.id=s.assignment_group_id WHERE s.id=?',
        )
        .get(id)
    : db.prepare('SELECT * FROM submissions WHERE id=?').get(id)
  if (!row) fail(404, '提交记录不存在')
  const assignment = assignmentAccess(row.assignment_id, user, { write })
  if (user.role === 'student') {
    const subject = subjectFor(assignment, user)
    if (
      group ? subject.assignment_group_id !== row.assignment_group_id : row.student_id !== user.id
    )
      fail(403, '无权访问提交记录')
  }
  return {
    row,
    a: assignment,
    table: group ? 'group_submissions' : 'submissions',
    history: group ? 'group_submission_history' : 'submission_history',
    foreign: group ? 'group_submission_id' : 'submission_id',
  }
}
export function historyRows(id, group = false) {
  return db
    .prepare(
      `SELECT id,content,file_name,file_size,file_type,file_state,is_late,submitted_at${group ? ',submitted_by' : ''} FROM ${group ? 'group_submission_history' : 'submission_history'} WHERE ${group ? 'group_submission_id' : 'submission_id'}=? ORDER BY id DESC`,
    )
    .all(id)
}
export function receipts(id, group = false) {
  const history = group ? 'group_submission_history' : 'submission_history',
    foreign = group ? 'group_submission_id' : 'submission_id',
    receiptForeign = group ? 'group_submission_history_id' : 'submission_history_id'
  return db
    .prepare(
      `SELECT r.receipt_no,r.snapshot_json,r.created_at,h.file_state,h.file_url FROM submission_receipts r JOIN ${history} h ON h.id=r.${receiptForeign} WHERE h.${foreign}=? ORDER BY r.id DESC`,
    )
    .all(id)
    .map((receipt) => ({
      receipt_no: receipt.receipt_no,
      created_at: receipt.created_at,
      snapshot: JSON.parse(receipt.snapshot_json),
      current_file_state:
        receipt.file_state === 'available' &&
        !resolveUploadPath(receipt.file_url, { mustExist: true })
          ? 'missing'
          : receipt.file_state,
    }))
}
function placeholders(values) {
  return values.map(() => '?').join(',')
}
function addTeacherDetails(rows, group = false) {
  const ids = rows.map((row) => row.id).filter(Boolean),
    filesById = new Map(),
    membersByGroup = new Map(),
    previewsById = new Map()
  if (ids.length) {
    const history = group ? 'group_submission_history' : 'submission_history',
      foreign = group ? 'group_submission_id' : 'submission_id'
    for (const file of db
      .prepare(
        `SELECT ${foreign} owner_id,id history_id,file_name,file_size,file_type,content,submitted_at,is_late FROM ${history} WHERE ${foreign} IN (${placeholders(ids)}) AND file_state IN ('available','online') ORDER BY id`,
      )
      .all(...ids)) {
      const { owner_id, ...view } = file,
        files = filesById.get(owner_id) || []
      files.push(view)
      filesById.set(owner_id, files)
    }
    // 预览图：每个提交只挂最近一次历史的图片组，一次批量查询避免列表页 N+1。
    const latestByOwner = new Map()
    for (const historyRow of db
      .prepare(
        `SELECT id,${foreign} owner_id FROM ${history} WHERE ${foreign} IN (${placeholders(ids)}) ORDER BY id`,
      )
      .all(...ids))
      latestByOwner.set(historyRow.owner_id, historyRow.id)
    const prefix = group ? 'group-' : ''
    const column = group ? 'group_submission_history_id' : 'submission_history_id'
    const latestHistoryIds = [...latestByOwner.values()]
    const ownerByHistory = new Map(
      [...latestByOwner].map(([owner, historyId]) => [historyId, owner]),
    )
    if (latestHistoryIds.length)
      for (const preview of db
        .prepare(
          `SELECT ${column} history_id,id,original_name,file_size,sort_order,thumbnail_url FROM submission_preview_images WHERE ${column} IN (${placeholders(latestHistoryIds)}) AND file_state='available' ORDER BY sort_order,id`,
        )
        .all(...latestHistoryIds)) {
        const owner = ownerByHistory.get(preview.history_id)
        const previewRows = previewsById.get(owner) || []
        previewRows.push({
          id: preview.id,
          name: preview.original_name,
          size: preview.file_size,
          order: preview.sort_order,
          thumbnail: preview.thumbnail_url
            ? `/api/${prefix}submission-previews/${preview.id}/thumbnail`
            : null,
          preview: `/api/${prefix}submission-previews/${preview.id}/file`,
        })
        previewsById.set(owner, previewRows)
      }
  }
  if (group) {
    const groupIds = rows.map((row) => row.assignment_group_id).filter(Boolean)
    if (groupIds.length)
      for (const member of db
        .prepare(
          `SELECT assignment_group_id,student_id,username_snapshot username,name_snapshot name FROM assignment_group_members WHERE assignment_group_id IN (${placeholders(groupIds)}) ORDER BY student_id`,
        )
        .all(...groupIds)) {
        const members = membersByGroup.get(member.assignment_group_id) || []
        members.push(member)
        membersByGroup.set(member.assignment_group_id, members)
      }
  }
  return rows.map((row) => {
    const { file_url, _assignment_id, ...safe } = row
    const previews = previewsById.get(row.id) || []
    return {
      ...safe,
      assignment_id: row.assignment_id ?? _assignment_id,
      files: filesById.get(row.id) || [],
      preview_count: previews.length,
      previews,
      members: group ? membersByGroup.get(row.assignment_group_id) || [] : undefined,
      kind: group ? 'group' : 'individual',
      api_base: (group ? '/group-submissions/' : '/submissions/') + row.id,
    }
  })
}
export function teacherRows(assignment) {
  const group = assignment.work_mode === 'group'
  const rows = group
    ? db
        .prepare(
          'SELECT s.*,g.assignment_id _assignment_id,g.id assignment_group_id,g.name name,g.name username,actor.name submitted_by_name,actor.username submitted_by_username FROM assignment_groups g LEFT JOIN group_submissions s ON s.assignment_group_id=g.id LEFT JOIN users actor ON actor.id=s.submitted_by WHERE g.assignment_id=? ORDER BY g.id',
        )
        .all(assignment.id)
    : db
        .prepare(
          'SELECT s.*,? _assignment_id,u.id student_id,u.username,u.name,u.status user_status FROM course_students cs JOIN users u ON u.id=cs.student_id LEFT JOIN submissions s ON s.student_id=u.id AND s.assignment_id=? WHERE cs.course_id=? ORDER BY COALESCE(cs.sort_order,cs.id),cs.id',
        )
        .all(assignment.id, assignment.id, assignment.course_id)
  return addTeacherDetails(rows, group)
}
export function teacherRowsForStudent(courseId, studentId) {
  const individual = db
    .prepare(
      `SELECT s.*,a.id _assignment_id,a.title,a.deadline,u.id student_id,u.username,u.name,u.status user_status
  FROM assignments a JOIN course_students cs ON cs.course_id=a.course_id AND cs.student_id=? JOIN users u ON u.id=cs.student_id
  LEFT JOIN submissions s ON s.assignment_id=a.id AND s.student_id=u.id
  WHERE a.course_id=? AND a.work_mode<>'group' ORDER BY a.id DESC`,
    )
    .all(studentId, courseId)
  const groups = db
    .prepare(
      `SELECT s.*,a.id _assignment_id,a.title,a.deadline,g.id assignment_group_id,g.name name,g.name username,actor.name submitted_by_name,actor.username submitted_by_username
  FROM assignments a JOIN assignment_group_members member ON member.assignment_id=a.id AND member.student_id=?
  JOIN assignment_groups g ON g.id=member.assignment_group_id LEFT JOIN group_submissions s ON s.assignment_group_id=g.id
  LEFT JOIN users actor ON actor.id=s.submitted_by WHERE a.course_id=? AND a.work_mode='group' ORDER BY a.id DESC`,
    )
    .all(studentId, courseId)
  return [...addTeacherDetails(individual, false), ...addTeacherDetails(groups, true)].sort(
    (left, right) => right.assignment_id - left.assignment_id,
  )
}
