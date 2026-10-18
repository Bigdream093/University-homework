import { computeScores, dailyWeightSum } from '@university-homework/domain/gradeScores'
import { db } from '../db.js'
import { fail, idValue } from './access.js'
import { assignmentGroupMembersForAssignments } from './assignmentGroupMembers.js'
import { round1 } from '@university-homework/domain/numbers'
import { placeholders } from '../utils/sql.js'

function gradeConfigOf(course) {
  return {
    daily_ratio: Number(course.daily_ratio ?? 40),
    final_ratio: Number(course.final_ratio ?? 60),
    grade_absent_mode: course.grade_absent_mode === 'skip_ungraded' ? 'skip_ungraded' : 'zero',
  }
}

function cellFromSubmission(row, kind, previewRows, members, groupName) {
  return {
    id: row.id,
    kind,
    api_base: (kind === 'group' ? '/group-submissions/' : '/submissions/') + row.id,
    status: row.status,
    score: row.score,
    comment: row.comment || '',
    returned_reason: row.returned_reason || '',
    is_late: Number(row.is_late ?? 0),
    submit_count: row.submit_count ?? 1,
    submitted_at: row.submitted_at,
    file_name: row.file_name,
    file_size: row.file_size,
    has_content: Boolean(row.has_content ?? row.content),
    previews: previewRows.map((preview) => ({
      id: preview.id,
      name: preview.original_name,
      size: preview.file_size,
      order: preview.sort_order,
    })),
    preview_count: previewRows.length,
    members: members || undefined,
    group_name: groupName || undefined,
  }
}

export function courseSummary(course, { includePreviews = true } = {}) {
  const config = gradeConfigOf(course)
  const assignments = db
    .prepare(
      'SELECT id,title,total_score,status,work_mode,sort_order,grade_weight,is_final FROM assignments WHERE course_id=? ORDER BY sort_order,id',
    )
    .all(course.id)
    .map((assignment) => ({
      ...assignment,
      grade_weight: Number(assignment.grade_weight ?? 1),
      is_final: Number(assignment.is_final ?? 0),
    }))
  const students = db
    .prepare(
      'SELECT u.id,u.username,u.name,u.status FROM course_students cs JOIN users u ON u.id=cs.student_id WHERE cs.course_id=? ORDER BY COALESCE(cs.sort_order,cs.id),cs.id',
    )
    .all(course.id)
  const cellsByStudent = new Map(students.map((student) => [student.id, {}]))

  const individual = db
    .prepare(
      "SELECT s.id,s.assignment_id,s.student_id,s.status,s.score,s.comment,s.returned_reason,s.is_late,s.submit_count,s.submitted_at,s.file_name,s.file_size,CASE WHEN s.content IS NOT NULL AND s.content<>'' THEN 1 ELSE 0 END has_content FROM submissions s JOIN assignments a ON a.id=s.assignment_id WHERE a.course_id=?",
    )
    .all(course.id)
  const submissionIds = individual.map((submission) => submission.id)

  const groupAssignmentIds = assignments
    .filter((assignment) => assignment.work_mode === 'group')
    .map((assignment) => assignment.id)
  const groupSubByGroup = new Map(),
    membersByGroup = new Map(),
    groupById = new Map()
  if (groupAssignmentIds.length) {
    const groupPlaceholders = placeholders(groupAssignmentIds)
    for (const group of db
      .prepare(
        `SELECT id,assignment_id,name FROM assignment_groups WHERE assignment_id IN (${groupPlaceholders})`,
      )
      .all(...groupAssignmentIds)) {
      groupById.set(group.id, group)
      membersByGroup.set(group.id, [])
    }
    for (const member of assignmentGroupMembersForAssignments(groupAssignmentIds)) {
      membersByGroup
        .get(member.assignment_group_id)
        ?.push({ username: member.username, name: member.name, student_id: member.student_id })
    }
    for (const submission of db
      .prepare(
        `SELECT gs.id,gs.assignment_group_id,gs.status,gs.score,gs.comment,gs.returned_reason,gs.is_late,gs.submit_count,gs.submitted_at,gs.file_name,gs.file_size,CASE WHEN gs.content IS NOT NULL AND gs.content<>'' THEN 1 ELSE 0 END has_content FROM group_submissions gs JOIN assignment_groups g ON g.id=gs.assignment_group_id WHERE g.assignment_id IN (${groupPlaceholders})`,
      )
      .all(...groupAssignmentIds)) {
      groupSubByGroup.set(submission.assignment_group_id, submission)
    }
  }

  const previewsByHistory = new Map(),
    historyIdBySubmission = new Map(),
    historyIdByGroupSubmission = new Map()
  if (includePreviews) {
    const historyIdsByColumn = new Map([
      ['submission_history_id', []],
      ['group_submission_history_id', []],
    ])
    if (submissionIds.length) {
      for (const history of db
        .prepare(
          `SELECT submission_id owner_id,MAX(id) hid FROM submission_history WHERE submission_id IN (${placeholders(submissionIds)}) GROUP BY submission_id`,
        )
        .all(...submissionIds)) {
        historyIdBySubmission.set(history.owner_id, history.hid)
        historyIdsByColumn.get('submission_history_id').push(history.hid)
      }
    }
    const groupSubmissionIds = [...groupSubByGroup.values()].map((submission) => submission.id)
    if (groupSubmissionIds.length) {
      for (const history of db
        .prepare(
          `SELECT group_submission_id owner_id,MAX(id) hid FROM group_submission_history WHERE group_submission_id IN (${placeholders(groupSubmissionIds)}) GROUP BY group_submission_id`,
        )
        .all(...groupSubmissionIds)) {
        historyIdByGroupSubmission.set(history.owner_id, history.hid)
        historyIdsByColumn.get('group_submission_history_id').push(history.hid)
      }
    }
    for (const [column, historyIds] of historyIdsByColumn) {
      if (!historyIds.length) continue
      for (const preview of db
        .prepare(
          `SELECT ${column} history_id,id,original_name,file_size,sort_order FROM submission_preview_images WHERE ${column} IN (${placeholders(historyIds)}) AND file_state='available' ORDER BY sort_order,id`,
        )
        .all(...historyIds)) {
        const item = {
          id: preview.id,
          original_name: preview.original_name,
          file_size: preview.file_size,
          sort_order: preview.sort_order,
        }
        const rows = previewsByHistory.get(preview.history_id)
        if (rows) rows.push(item)
        else previewsByHistory.set(preview.history_id, [item])
      }
    }
  }

  for (const row of individual) {
    const cells = cellsByStudent.get(row.student_id)
    if (!cells) continue
    cells[row.assignment_id] = cellFromSubmission(
      row,
      'individual',
      previewsByHistory.get(historyIdBySubmission.get(row.id)) || [],
    )
  }
  for (const row of groupSubByGroup.values()) {
    const group = groupById.get(row.assignment_group_id),
      members = membersByGroup.get(row.assignment_group_id) || []
    if (!group) continue
    const previews = previewsByHistory.get(historyIdByGroupSubmission.get(row.id)) || []
    const memberViews = members.map(({ username, name }) => ({ username, name }))
    const cell = cellFromSubmission(row, 'group', previews, memberViews, group.name)
    for (const member of members) {
      const cells = cellsByStudent.get(member.student_id)
      if (!cells) continue
      cells[group.assignment_id] = { ...cell }
    }
  }

  // 分组作业里没有安排到组的学生按"未安排"显示，成绩按未交口径计入。
  for (const assignment of assignments) {
    if (assignment.work_mode !== 'group') continue
    for (const student of students) {
      const cells = cellsByStudent.get(student.id)
      if (cells && !cells[assignment.id])
        cells[assignment.id] = { not_assigned: true, status: 'not_assigned' }
    }
  }

  const absenceMarks = db
    .prepare(
      `SELECT assignment_id,student_id,assignment_group_id,graded_at FROM absence_grade_marks
       WHERE assignment_id IN (${placeholders(assignments.map((assignment) => assignment.id)) || 'NULL'})`,
    )
    .all(...assignments.map((assignment) => assignment.id))
  for (const mark of absenceMarks) {
    const cell = {
      absence_graded: true,
      status: 'graded',
      score: 0,
      comment: '未交记 0 分',
      graded_at: mark.graded_at,
    }
    if (mark.student_id) {
      const cells = cellsByStudent.get(mark.student_id)
      if (cells && !cells[mark.assignment_id]) cells[mark.assignment_id] = cell
      continue
    }
    for (const member of membersByGroup.get(mark.assignment_group_id) || []) {
      const cells = cellsByStudent.get(member.student_id)
      if (cells && !cells[mark.assignment_id]) cells[mark.assignment_id] = { ...cell }
    }
  }

  for (const student of students) {
    const cells = cellsByStudent.get(student.id)
    Object.assign(student, { cells, scores: computeScores(cells, assignments, config) })
  }
  return { config, assignments, students }
}

// 占比口径：grade_weight 直接存该作业占总成绩的百分比（0-100）。平时/期末占比由「平时占比」
// 输入框独立设置（两者之和必须为 100，期末占比随之联动），并强校验平时各项占比之和等于平时占比，
// 保证 Σ(折算分×占比)÷100 恰为平时部分贡献、总成绩满分恒为 100。
export function saveGradeConfig(course, body) {
  const daily = Number(body.daily_ratio),
    final = Number(body.final_ratio)
  if (
    !Number.isFinite(daily) ||
    !Number.isFinite(final) ||
    daily < 0 ||
    final < 0 ||
    daily > 100 ||
    final > 100
  )
    fail(400, '占比必须是 0-100 之间的数字')
  if (Math.round((daily + final) * 10) !== 1000) fail(400, '平时占比与期末占比之和必须等于 100')
  const absentMode = body.grade_absent_mode === 'skip_ungraded' ? 'skip_ungraded' : 'zero'
  const finalAssignmentId = body.final_assignment_id ? idValue(body.final_assignment_id) : null
  if (finalAssignmentId) {
    const finalAssignment = db
      .prepare('SELECT id,course_id,status FROM assignments WHERE id=?')
      .get(finalAssignmentId)
    if (!finalAssignment || finalAssignment.course_id !== course.id)
      fail(400, '期末作业不属于本课程')
    if (finalAssignment.status === 'draft') fail(400, '草稿作业不能设为期末')
  }
  const weights = Array.isArray(body.weights) ? body.weights : []
  const seen = new Set()
  for (const item of weights) {
    const assignmentId = idValue(item.assignment_id)
    if (seen.has(assignmentId)) fail(400, '权重列表里有重复的作业')
    seen.add(assignmentId)
    const weight = Number(item.grade_weight)
    if (!Number.isFinite(weight) || weight < 0 || weight > 100)
      fail(400, '占比必须是 0-100 之间的数字')
  }
  // 平时各项之和按本次选中的期末作业排除（草稿与期末作业不参与）；
  // 本次未提交权重的作业沿用库中现值。
  const counted = db
    .prepare('SELECT id,grade_weight,status FROM assignments WHERE course_id=?')
    .all(course.id)
  const weightOf = Object.fromEntries(
    weights.map((item) => [String(idValue(item.assignment_id)), Number(item.grade_weight) || 0]),
  )
  const weightSum = dailyWeightSum(counted, finalAssignmentId, weightOf)
  if (weightSum !== round1(daily))
    fail(400, `平时各项占比之和（${weightSum}%）必须等于平时占比（${round1(daily)}%）`)
  db.transaction(() => {
    db.prepare('UPDATE courses SET daily_ratio=?,final_ratio=?,grade_absent_mode=? WHERE id=?').run(
      daily,
      final,
      absentMode,
      course.id,
    )
    const updateWeight = db.prepare(
      'UPDATE assignments SET grade_weight=? WHERE id=? AND course_id=?',
    )
    for (const item of weights)
      updateWeight.run(Number(item.grade_weight), idValue(item.assignment_id), course.id)
    db.prepare('UPDATE assignments SET is_final=0 WHERE course_id=?').run(course.id)
    if (finalAssignmentId)
      db.prepare('UPDATE assignments SET is_final=1 WHERE id=? AND course_id=?').run(
        finalAssignmentId,
        course.id,
      )
  })()
  return gradeConfigOf(db.prepare('SELECT * FROM courses WHERE id=?').get(course.id))
}
