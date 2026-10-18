import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeAbsenceMarks, submissionCounts } from '@university-homework/domain/gradingSummary'
import { LIMITS, boundedInt } from '@university-homework/domain/limits'

test('缺勤记0 分按个人与小组两种主体分别合并，命中行覆盖为0分', () => {
  const rows = [
    { id: 1, student_id: 10, status: 'graded', score: 88 },
    { id: 2, student_id: 11, status: 'submitted', score: null },
    { id: 3, assignment_group_id: 7, status: 'submitted', score: null },
    { id: 4, assignment_group_id: 8, status: 'submitted', score: null },
  ]
  const merged = mergeAbsenceMarks(rows, [
    { student_id: 11, assignment_group_id: null, graded_at: '2026-05-01 09:00:00' },
    { student_id: null, assignment_group_id: 7, graded_at: '2026-05-01 10:00:00' },
  ])

  assert.deepEqual(
    merged.map((row) => row.absence_graded === true),
    [false, true, true, false],
  )
  assert.equal(merged[1].score, 0)
  assert.equal(merged[1].graded_at, '2026-05-01 09:00:00')
  assert.equal(merged[2].score, 0)
  assert.equal(merged[2].graded_at, '2026-05-01 10:00:00')
  // 未命中的行保持原对象不变，不被复制污染。
  assert.equal(merged[0].score, 88)
  assert.equal(merged[3].score, null)
  // 原入参不被就地修改。
  assert.equal(rows[1].score, null)
})

test('统计口径区分应交人数与提交计数，并排除测试账号', () => {
  const rows = [
    { id: 1, student_id: 1, status: 'graded', is_late: 0, preview_count: 1 },
    { id: 2, student_id: 2, status: 'submitted', is_late: 1, preview_count: 0 },
    { id: null, student_id: 3, status: null, is_late: 0, preview_count: 0 },
    { id: 9, student_id: 9, status: 'returned', is_late: 0, preview_count: 0 },
  ]
  const { counts, stats } = submissionCounts(rows, {})

  assert.equal(counts.all, 4)
  assert.equal(counts.unsubmitted, 1)
  assert.equal(counts.submitted, 1)
  assert.equal(counts.late, 1)
  assert.equal(counts.returned, 1)
  assert.equal(counts.graded, 1)
  assert.equal(counts.missingPreview, 2)
  // 四行均非测试账号：应交 4 人；有提交记录（已批改/待批改/已退回）3 人、未交 1 人；
  // 其中处于"已批改"状态的 1 人。注意 stats.submitted 统计的是有提交记录的行，
  // 与counts.submitted（仅status='submitted'）口径不同。
  assert.equal(stats.all, 4)
  assert.equal(stats.submitted, 3)
  assert.equal(stats.unsubmitted, 1)
  assert.equal(stats.graded, 1)
})

test('测试账号不计入应交人数，但仍可出现在筛选计数中', () => {
  const rows = [
    { id: 1, student_id: 1, status: 'submitted', is_late: 0, preview_count: 1 },
    {
      id: 2,
      student_id: 99,
      status: 'submitted',
      is_late: 0,
      preview_count: 1,
      is_test_student: true,
    },
  ]
  const { counts, stats } = submissionCounts(rows, {})

  assert.equal(counts.all, 2)
  assert.equal(stats.all, 1)
  assert.equal(stats.submitted, 1)
})

test('作业记录了应交人数快照时，统计以其为准', () => {
  const rows = [{ id: null, student_id: 1, status: null, is_late: 0, preview_count: 0 }]
  const { stats } = submissionCounts(rows, { unsubmitted_expected_count: 45 })

  assert.equal(stats.all, 45)
})

test('boundedInt 非法输入回退默认值，超出上限时截断', () => {
  assert.equal(boundedInt('12', 1, 200), 12)
  assert.equal(boundedInt(undefined, 50, 200), 50)
  assert.equal(boundedInt('abc', 50, 200), 50)
  assert.equal(boundedInt('0', 50, 200), 50)
  assert.equal(boundedInt('-3', 50, 200), 50)
  assert.equal(boundedInt('1.5', 50, 200), 50)
  assert.equal(boundedInt('9999', 50, 200), 200)
})

test('常量表覆盖各处曾内联的取值，且分页上下限成对声明', () => {
  assert.ok(LIMITS.defaultPageSize <= LIMITS.maxPageSize)
  assert.ok(LIMITS.questionPageSize <= LIMITS.maxQuestionPageSize)
  assert.equal(LIMITS.materialTitle, 200)
  assert.equal(LIMITS.materialDescription, 20000)
  assert.equal(LIMITS.plainText, 20000)
  assert.equal(LIMITS.richText, 50000)
})
