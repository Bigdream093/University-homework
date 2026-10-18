import test from 'node:test'
import assert from 'node:assert/strict'
import {
  closestDeadlineAssignment,
  deadlineRemainingText,
  deadlineState,
} from '../src/utils/deadline.js'

const now = Date.parse('2026-10-16T17:00:00+08:00')
const assignment = (id, effective_deadline, extra = {}) => ({
  id,
  effective_deadline,
  status: 'published',
  ...extra,
})

test('最近截止作业按学生实际截止时间选择，已批改作业仍可查看截止日期', () => {
  const selected = closestDeadlineAssignment(
    [
      assignment(1, '2026-10-26 17:00:00', { submission_status: 'graded' }),
      assignment(2, '2026-10-18 17:00:00', { deadline: '2026-10-17 17:00:00' }),
      assignment(3, '2026-10-15 17:00:00'),
    ],
    now,
  )
  assert.equal(selected.id, 2)
  assert.equal(selected.effective_deadline, '2026-10-18 17:00:00')
  assert.equal(
    closestDeadlineAssignment(
      [assignment(1, '2026-10-26 17:00:00', { submission_status: 'graded' })],
      now,
    ).id,
    1,
  )
})

test('最近截止作业忽略关闭、草稿、未安排参与以及无有效截止时间的作业', () => {
  const rows = [
    assignment(1, '2026-10-17 17:00:00', { status: 'closed' }),
    assignment(2, '2026-10-17 17:00:00', { status: 'draft' }),
    assignment(3, '2026-10-17 17:00:00', { not_assigned: true }),
    assignment(4, null),
    assignment(5, 'invalid'),
  ]
  assert.equal(closestDeadlineAssignment(rows, now), null)
  assert.equal(closestDeadlineAssignment([], now), null)
})

test('没有未来截止作业时显示最近一次截止日期，并保持截止秒边界一致', () => {
  const rows = [assignment(1, '2026-10-14 17:00:00'), assignment(2, '2026-10-15 17:00:00')]
  assert.equal(closestDeadlineAssignment(rows, now).id, 2)
  const boundary = assignment(3, '2026-10-16 17:00:00')
  assert.equal(
    closestDeadlineAssignment([boundary, assignment(4, '2026-10-17 17:00:00')], now + 999).id,
    3,
  )
})

test('front-end deadline stays on time within the deadline second and becomes late next second', async () => {
  const { deadlineState } = await import('../src/utils/deadline.js')
  const time = Date.parse('2026-08-31T12:00:00+08:00'),
    deadline = '2026-08-31 12:00:00'
  assert.notEqual(deadlineState(deadline, time).kind, 'late')
  assert.notEqual(deadlineState(deadline, time + 999).kind, 'late')
  assert.equal(deadlineState(deadline, time + 1000).kind, 'late')
})

test('截止提醒使用完整天数和小时，不把不足一天的部分算作一整天', () => {
  const deadline = '2026-10-26 17:00:00'
  for (const [current, expected] of [
    ['2026-10-17T12:00:00+08:00', '剩余 9 天 5 小时'],
    ['2026-10-17T18:00:00+08:00', '剩余 8 天 23 小时'],
    ['2026-10-16T16:00:00+08:00', '剩余 10 天 1 小时'],
    ['2026-10-16T17:00:00+08:00', '剩余 10 天'],
    ['2026-10-17T12:30:00+08:00', '剩余 9 天 4 小时'],
    ['2026-10-17T04:00:00Z', '剩余 9 天 5 小时'],
  ]) {
    assert.equal(deadlineRemainingText(deadlineState(deadline, Date.parse(current))), expected)
  }
})

test('截止提醒保留一天以内的小时分钟、已截止和无截止时间状态', () => {
  const deadline = '2026-10-26 17:00:00'
  assert.equal(
    deadlineRemainingText(deadlineState(deadline, Date.parse('2026-10-25T17:00:00+08:00'))),
    '剩余 24小时',
  )
  assert.equal(
    deadlineRemainingText(deadlineState(deadline, Date.parse('2026-10-26T16:30:00+08:00'))),
    '剩余 30分钟',
  )
  assert.equal(
    deadlineRemainingText(deadlineState(deadline, Date.parse('2026-10-26T17:00:01+08:00'))),
    '已截止',
  )
  assert.equal(deadlineRemainingText(deadlineState(null, now)), '')
  assert.equal(deadlineRemainingText(undefined), '')
})
