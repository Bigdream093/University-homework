import test from 'node:test'
import assert from 'node:assert/strict'

test('front-end deadline stays on time within the deadline second and becomes late next second', async () => {
  const { deadlineState } = await import('../src/utils/deadline.js')
  const time = Date.parse('2026-08-31T12:00:00+08:00'),
    deadline = '2026-08-31 12:00:00'
  assert.notEqual(deadlineState(deadline, time).kind, 'late')
  assert.notEqual(deadlineState(deadline, time + 999).kind, 'late')
  assert.equal(deadlineState(deadline, time + 1000).kind, 'late')
})

