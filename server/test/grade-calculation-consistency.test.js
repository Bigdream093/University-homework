import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mohen-grade-consistency-'))
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'grade-consistency-test-only'
process.env.DATA_DIR = dataDirectory
process.env.UPLOAD_DIR = path.join(dataDirectory, 'uploads')
const { computeScores: computeServerScores } = await import('../src/services/summaryService.js')
const { db } = await import('../src/db.js')

after(() => {
  db.close()
  fs.rmSync(dataDirectory, { recursive: true, force: true })
})

const componentPath = path.resolve(
  import.meta.dirname,
  '../../web/src/components/CourseSummary.vue',
)
const componentSource = fs.readFileSync(componentPath, 'utf8')

function extractFunction(functionName) {
  const declaration = `function ${functionName}(`
  const start = componentSource.indexOf(declaration)
  assert.notEqual(start, -1, `前端缺少 ${functionName} 函数`)

  const bodyStart = componentSource.indexOf('{', start)
  let braceDepth = 0
  for (let index = bodyStart; index < componentSource.length; index++) {
    if (componentSource[index] === '{') braceDepth += 1
    if (componentSource[index] === '}') braceDepth -= 1
    if (braceDepth === 0) return componentSource.slice(start, index + 1)
  }
  throw new Error(`无法读取前端 ${functionName} 函数`)
}

const createClientScoreCalculator = new Function(
  'draft',
  'assignments',
  `'use strict'
${extractFunction('normalize')}
${extractFunction('computeScores')}
return computeScores`,
)

const assignments = [
  { id: 1, total_score: 100, grade_weight: 20, is_final: 0, status: 'published' },
  { id: 2, total_score: 50, grade_weight: 20, is_final: 0, status: 'closed' },
  { id: 3, total_score: 80, grade_weight: 0, is_final: 1, status: 'published' },
  { id: 4, total_score: 100, grade_weight: 99, is_final: 0, status: 'draft' },
]

const cases = [
  {
    name: '全部评分',
    config: { daily_ratio: 40, final_ratio: 60, grade_absent_mode: 'zero' },
    cells: {
      1: { status: 'graded', score: 80 },
      2: { status: 'graded', score: 25 },
      3: { status: 'graded', score: 64 },
      4: { status: 'graded', score: 100 },
    },
  },
  {
    name: '未评成绩按零计入',
    config: { daily_ratio: 40, final_ratio: 60, grade_absent_mode: 'zero' },
    cells: {
      1: { status: 'graded', score: 80 },
      2: { status: 'submitted', score: null },
    },
  },
  {
    name: '未评成绩跳过并重分占比',
    config: { daily_ratio: 40, final_ratio: 60, grade_absent_mode: 'skip_ungraded' },
    cells: {
      1: { status: 'graded', score: 80 },
      2: { status: 'submitted', score: null },
    },
  },
  {
    name: '未提交与未安排仍按零计入',
    config: { daily_ratio: 40, final_ratio: 60, grade_absent_mode: 'skip_ungraded' },
    cells: {
      2: { status: 'submitted', score: null, not_assigned: true },
    },
  },
  {
    name: '只有期末成绩',
    config: { daily_ratio: 40, final_ratio: 60, grade_absent_mode: 'skip_ungraded' },
    cells: {
      3: { status: 'graded', score: 53 },
    },
  },
  {
    name: '小数成绩统一舍入到一位',
    config: { daily_ratio: 35, final_ratio: 65, grade_absent_mode: 'zero' },
    cells: {
      1: { status: 'graded', score: 83.37 },
      2: { status: 'graded', score: 41.19 },
      3: { status: 'graded', score: 71.11 },
    },
  },
]

function roundNullable(value) {
  return value === null ? null : Math.round(value * 10) / 10
}

test('前后端成绩计算规则保持一致', () => {
  for (const testCase of cases) {
    const serverScores = computeServerScores(testCase.cells, assignments, testCase.config)
    const draft = {
      ...testCase.config,
      final_assignment_id: 3,
      weights: Object.fromEntries(
        assignments.map((assignment) => [assignment.id, assignment.grade_weight]),
      ),
    }
    const computeClientScores = createClientScoreCalculator(draft, { value: assignments })
    const clientScores = computeClientScores(testCase.cells)

    assert.deepEqual(
      {
        daily_score: roundNullable(clientScores.daily),
        final_score: roundNullable(clientScores.final),
        total_score: roundNullable(clientScores.total),
      },
      serverScores,
      testCase.name,
    )
  }
})
