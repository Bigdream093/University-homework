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
const { computeScores: computeServerScores } = await import('../../server/src/services/summaryService.js')
const { db } = await import('../../server/src/db.js')

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

// 执行组件实际使用的显示函数，不能在测试中另写舍入函数代替它。
const formatStart = componentSource.indexOf('const formatScore =')
const formatEnd = componentSource.indexOf('\nasync function saveConfig', formatStart)
assert.ok(formatStart >= 0 && formatEnd > formatStart)
const formatScore = new Function(componentSource.slice(formatStart, formatEnd) + '\nreturn formatScore')()

const assignments = [
  { id: 1, total_score: 100, grade_weight: 20, is_final: 0, status: 'published' },
  { id: 2, total_score: 50, grade_weight: 20, is_final: 0, status: 'closed' },
  { id: 3, total_score: 80, grade_weight: 0, is_final: 1, status: 'published' },
  { id: 4, total_score: 100, grade_weight: 99, is_final: 0, status: 'draft' },
]

const cases = [
  {
    name: '全部评分',
    expected: [65, 80, 74], // (80+50)/2=65；65×40%+80×60%=74
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
    expected: [40, null, 40],
    config: { daily_ratio: 40, final_ratio: 60, grade_absent_mode: 'zero' },
    cells: {
      1: { status: 'graded', score: 80 },
      2: { status: 'submitted', score: null },
    },
  },
  {
    name: '未评成绩跳过并重分占比',
    expected: [80, null, 80],
    config: { daily_ratio: 40, final_ratio: 60, grade_absent_mode: 'skip_ungraded' },
    cells: {
      1: { status: 'graded', score: 80 },
      2: { status: 'submitted', score: null },
    },
  },
  {
    name: '未提交与未安排仍按零计入',
    expected: [0, null, 0],
    config: { daily_ratio: 40, final_ratio: 60, grade_absent_mode: 'skip_ungraded' },
    cells: {
      2: { status: 'not_assigned', not_assigned: true },
    },
  },
  {
    name: '平时全部待评跳过，只有期末成绩',
    expected: [null, 66.3, 66.3], // 53/80×100=66.25，平时分母为零
    config: { daily_ratio: 40, final_ratio: 60, grade_absent_mode: 'skip_ungraded' },
    cells: {
      1: { status: 'submitted', score: null },
      2: { status: 'submitted', score: null },
      3: { status: 'graded', score: 53 },
    },
  },
  {
    name: '小数成绩统一舍入到一位',
    expected: [82.9, 88.9, 86.8], // 平时82.875、期末88.8875、总分86.783125
    dailyWeight: 17.5,
    config: { daily_ratio: 35, final_ratio: 65, grade_absent_mode: 'zero' },
    cells: {
      1: { status: 'graded', score: 83.37 },
      2: { status: 'graded', score: 41.19 },
      3: { status: 'graded', score: 71.11 },
    },
  },
]

for (const testCase of cases) {
  test(`成绩计算与真实前端显示：${testCase.name}`, () => {
    const scenarioAssignments = assignments.map((assignment) =>
      assignment.id <= 2 && testCase.dailyWeight !== undefined
        ? { ...assignment, grade_weight: testCase.dailyWeight } : assignment)
    assert.equal(scenarioAssignments.filter((a) => !a.is_final && a.status !== 'draft')
      .reduce((sum, a) => sum + a.grade_weight, 0), testCase.config.daily_ratio,
      '正常案例必须满足可保存的权重配置')
    const serverScores = computeServerScores(testCase.cells, scenarioAssignments, testCase.config)
    const draft = {
      ...testCase.config,
      final_assignment_id: 3,
      weights: Object.fromEntries(
        scenarioAssignments.map((assignment) => [assignment.id, assignment.grade_weight]),
      ),
    }
    const computeClientScores = createClientScoreCalculator(draft, { value: scenarioAssignments })
    const clientScores = computeClientScores(testCase.cells)

    const [daily_score, final_score, total_score] = testCase.expected
    assert.deepEqual(serverScores, { daily_score, final_score, total_score })
    const expectedDisplay = testCase.expected.map((value) => value === null ? '—' : value.toFixed(1))
    assert.deepEqual([clientScores.daily, clientScores.final, clientScores.total].map(formatScore), expectedDisplay)
    assert.deepEqual([serverScores.daily_score, serverScores.final_score, serverScores.total_score].map(formatScore), expectedDisplay)
    if (daily_score === null) assert.equal(clientScores.daily, null, '必须实际触发无平时成绩分支')
  })
}
