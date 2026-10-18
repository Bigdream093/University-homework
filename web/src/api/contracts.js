// Validate business responses before they enter reactive page state.
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const finite = (value) =>
  (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) &&
  Number.isFinite(Number(value))
const positiveId = (value) =>
  finite(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0
const statuses = new Set(['submitted', 'returned', 'graded'])
function invalid(name) {
  throw new Error(`${name}返回格式异常，请刷新重试或检查服务器版本`)
}

/** @typedef {{success: boolean, message?: string, id?: number, kind?: 'individual'|'group'}} GradingResult */
/** @typedef {{status: 'submitted'|'returned'|'graded'|'not_assigned', score?: number|string|null, not_assigned?: boolean}} SubmissionCell */
/** @typedef {{config: object, assignments: object[], students: {id: number, cells: Object<string, SubmissionCell|null>}[]}} CourseSummaryResponse */

export function validateStudentPage(data) {
  if (
    !record(data) ||
    !record(data.assignment) ||
    !positiveId(data.assignment.id) ||
    !record(data.context) ||
    typeof data.context.can_submit !== 'boolean' ||
    !(data.submission === null || (record(data.submission) && statuses.has(data.submission.status)))
  )
    invalid('作业页面')
  return data
}

export function validateSubmissionPolicy(data) {
  if (!record(data) || typeof data.can_submit !== 'boolean' || typeof data.is_late !== 'boolean')
    invalid('提交规则')
  return data
}

/** @param {CourseSummaryResponse} data */
export function validateCourseSummary(data) {
  if (
    !record(data) ||
    !record(data.config) ||
    !Array.isArray(data.assignments) ||
    !Array.isArray(data.students)
  )
    invalid('成绩汇总')
  for (const key of ['daily_ratio', 'final_ratio']) {
    if (
      data.config[key] != null &&
      (!finite(data.config[key]) || Number(data.config[key]) < 0 || Number(data.config[key]) > 100)
    )
      invalid('成绩汇总')
  }
  if (
    data.config.grade_absent_mode != null &&
    !['zero', 'skip_ungraded'].includes(data.config.grade_absent_mode)
  )
    invalid('成绩汇总')
  for (const assignment of data.assignments) {
    if (
      !record(assignment) ||
      !positiveId(assignment.id) ||
      !finite(assignment.total_score) ||
      Number(assignment.total_score) <= 0
    )
      invalid('成绩汇总')
    if (
      assignment.grade_weight != null &&
      (!finite(assignment.grade_weight) || Number(assignment.grade_weight) < 0)
    )
      invalid('成绩汇总')
  }
  for (const student of data.students) {
    if (!record(student) || !positiveId(student.id) || !record(student.cells)) invalid('成绩汇总')
    for (const cell of Object.values(student.cells)) {
      // Missing submission cells are explicitly null; zero is a valid graded score.
      if (cell === null) continue
      if (record(cell) && cell.status === 'not_assigned' && cell.not_assigned === true) continue
      if (
        !record(cell) ||
        !statuses.has(cell.status) ||
        (cell.status === 'graded' && (!finite(cell.score) || Number(cell.score) < 0))
      )
        invalid('成绩汇总')
    }
  }
  return data
}

export function validateSingleGradingResult(data) {
  if (
    !record(data) ||
    !Array.isArray(data.results) ||
    data.results.length !== 1 ||
    !record(data.results[0]) ||
    typeof data.results[0].success !== 'boolean'
  )
    invalid('批改结果')
  const result = data.results[0]
  if (!result.success) throw new Error(result.message || '批改失败，请刷新后重试')
  return result
}
