import test from 'node:test'
import assert from 'node:assert/strict'
import { computeScores, computeRawScores } from '../../server/src/domain/gradeScores.js'
const a = (id, extra = {}) => ({
  id,
  total_score: 100,
  grade_weight: 20,
  status: 'published',
  ...extra,
})
const graded = (score) => ({ status: 'graded', score })
const config = { daily_ratio: 40, final_ratio: 60, grade_absent_mode: 'zero' }
test('shared scores: normalization and daily/final weighting', () => {
  assert.deepEqual(
    computeScores(
      { 1: graded(40), 2: graded(90) },
      [a(1, { total_score: 50 }), a(2, { is_final: 1 })],
      config,
    ),
    { daily_score: 80, final_score: 90, total_score: 86 },
  )
})
test('shared scores: skip ungraded but count missing/not assigned as zero', () => {
  const assignments = [a(1), a(2), a(3), a(4)]
  const cells = { 1: graded(90), 2: { status: 'submitted' }, 3: { not_assigned: true } }
  assert.equal(computeScores(cells, assignments, config).daily_score, 22.5)
  assert.equal(
    computeScores(cells, assignments, { ...config, grade_absent_mode: 'skip_ungraded' })
      .daily_score,
    30,
  )
})
test('shared scores: draft, zero/invalid weight and invalid total do not contribute', () => {
  const assignments = [
    a(1),
    a(2, { status: 'draft' }),
    a(3, { total_score: 0 }),
    a(4, { grade_weight: 0 }),
    a(5, { grade_weight: 'bad' }),
  ]
  assert.equal(computeScores({ 1: graded(80) }, assignments, config).daily_score, 80)
})
test('shared scores: missing final falls back to daily; final-only and empty courses', () => {
  assert.equal(
    computeScores({ 1: graded(70) }, [a(1), a(2, { is_final: 1 })], config).total_score,
    70,
  )
  assert.equal(computeScores({ 2: graded(90) }, [a(2, { is_final: 1 })], config).total_score, 90)
  assert.deepEqual(computeScores({}, [], config), {
    daily_score: null,
    final_score: null,
    total_score: null,
  })
})
test('shared scores: round once after weighted calculation, including 2.55 boundary', () => {
  assert.equal(computeScores({ 1: graded(2.55) }, [a(1)], config).total_score, 2.6)
  const cells = { 1: graded(2.55), 2: graded(9.94) }
  assert.equal(computeRawScores(cells, [a(1), a(2, { is_final: 1 })], config).total, 6.984)
  assert.equal(computeScores(cells, [a(1), a(2, { is_final: 1 })], config).total_score, 7)
})

test('shared scores: all daily work awaiting grading yields null, final is normalized and rounded', () => {
  const assignments = [a(1), a(2, { total_score: 50 }), a(3, { is_final: 1, total_score: 80 })]
  const cells = {
    1: { status: 'submitted', score: null },
    2: { status: 'submitted', score: null },
    3: graded(53),
  }
  assert.deepEqual(
    computeScores(cells, assignments, { ...config, grade_absent_mode: 'skip_ungraded' }),
    { daily_score: null, final_score: 66.3, total_score: 66.3 },
  )
})
test('shared scores: fractional weights and normalized decimals round only at output', () => {
  const assignments = [
    a(1, { grade_weight: 17.5 }),
    a(2, { grade_weight: 17.5, total_score: 50 }),
    a(3, { is_final: 1, total_score: 80 }),
  ]
  const cells = { 1: graded(83.37), 2: graded(41.19), 3: graded(71.11) }
  assert.deepEqual(
    computeScores(cells, assignments, { ...config, daily_ratio: 35, final_ratio: 65 }),
    { daily_score: 82.9, final_score: 88.9, total_score: 86.8 },
  )
})
