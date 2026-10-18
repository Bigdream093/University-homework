import test from 'node:test'
import assert from 'node:assert/strict'
import {
  validateCourseSummary,
  validateStudentPage,
  validateSingleGradingResult,
  validateSubmissionPolicy,
} from '../src/api/contracts.js'

test('summary distinguishes a zero grade, absent submission and a malformed graded score', () => {
  const data = {
    config: {},
    assignments: [{ id: 1, total_score: '100' }],
    students: [
      {
        id: 1,
        cells: {
          1: { status: 'graded', score: 0 },
          2: null,
          3: { status: 'not_assigned', not_assigned: true },
        },
      },
    ],
  }
  assert.equal(validateCourseSummary(data), data)
  for (const score of [null, '', false, 'NaN', Infinity, -1]) {
    data.students[0].cells[1].score = score
    assert.throws(() => validateCourseSummary(data), /成绩汇总返回格式异常/)
  }
  assert.throws(() => validateCourseSummary({}), /返回格式异常/)
})

test('single grading operation requires exactly one explicit boolean business result', () => {
  for (const results of [[], [{ success: 'false' }], [{ success: true }, { success: false }]])
    assert.throws(() => validateSingleGradingResult({ results }), /返回格式异常/)
  assert.throws(
    () => validateSingleGradingResult({ results: [{ success: false, message: '提交已更新' }] }),
    /提交已更新/,
  )
  assert.equal(validateSingleGradingResult({ results: [{ success: true }] }).success, true)
})

test('student page and policy reject ambiguous permissions instead of enabling submission', () => {
  const page = { assignment: { id: 1 }, context: { can_submit: false }, submission: null }
  assert.equal(validateStudentPage(page), page)
  page.context.can_submit = 'false'
  assert.throws(() => validateStudentPage(page), /返回格式异常/)
  assert.throws(() => validateSubmissionPolicy({ can_submit: true, is_late: 0 }), /返回格式异常/)
  assert.equal(validateSubmissionPolicy({ can_submit: true, is_late: false }).can_submit, true)
})
