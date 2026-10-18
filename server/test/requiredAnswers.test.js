import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatRequiredAnswerText,
  questionDefinitionError,
  requiredAnswerError,
  serializeRequiredAnswers,
  serializeRequiredQuestions,
} from '@university-homework/domain/requiredAnswers'

test('required questions validate, round-trip answers and render each specification', () => {
  const questions = serializeRequiredQuestions([
    { id: 'q1', title: '工作时长', guidance: '以小时为单位' },
    { id: 'q2', title: '主要收获', guidance: '写两点' },
  ])
  const answers = serializeRequiredAnswers(questions, {
    q1: '3小时',
    q2: '掌握了方法',
  })

  assert.equal(questionDefinitionError(questions), '')
  assert.equal(requiredAnswerError(questions, answers), '')
  assert.match(formatRequiredAnswerText(questions, answers), /答题规范：\n以小时为单位/)
  assert.match(formatRequiredAnswerText(questions, answers), /学生答案：\n掌握了方法/)
})

test('legacy single-question text remains required and readable', () => {
  assert.match(requiredAnswerError('请说明作业用时', ''), /请回答第1道/)
  assert.equal(requiredAnswerError('请说明作业用时', '3小时'), '')
  assert.match(formatRequiredAnswerText('请说明作业用时', '3小时'), /3小时/)
})

test('required answers default to 5000 characters and enforce configured limits', () => {
  const defaults = serializeRequiredQuestions([
    { id: 'default', title: '说明', guidance: '按要求作答' },
  ])
  assert.equal(JSON.parse(defaults).questions[0].maxChars, 5000)
  assert.equal(
    requiredAnswerError(
      defaults,
      serializeRequiredAnswers(defaults, { default: '字'.repeat(5000) }),
    ),
    '',
  )
  assert.match(
    requiredAnswerError(
      defaults,
      serializeRequiredAnswers(defaults, { default: '字'.repeat(5001) }),
    ),
    /不能超过5000字/,
  )

  const limited = serializeRequiredQuestions([
    { id: 'short', title: '简答', guidance: '简要说明', maxChars: 3 },
  ])
  assert.equal(questionDefinitionError(limited), '')
  assert.equal(
    requiredAnswerError(limited, serializeRequiredAnswers(limited, { short: '三个字' })),
    '',
  )
  assert.match(
    requiredAnswerError(limited, serializeRequiredAnswers(limited, { short: '超过三个字' })),
    /不能超过3字/,
  )
})

test('required answers reject empty and whitespace-only values but accept the text 0', () => {
  const questions = serializeRequiredQuestions([{ id: 'q1', title: '回答', guidance: '请作答' }])
  for (const value of ['', '   ', '\n\t\r\n']) {
    assert.ok(
      requiredAnswerError(questions, serializeRequiredAnswers(questions, { q1: value })),
      '空答案和纯空白答案必须被拒绝',
    )
  }
  assert.equal(requiredAnswerError(questions, serializeRequiredAnswers(questions, { q1: '0' })), '')
})

test('required question maximum must be between 1 and 5000 characters', () => {
  for (const maxChars of [0, 5001, 1.5, '10']) {
    const questions = JSON.stringify({
      kind: 'required-questions',
      version: 1,
      questions: [{ id: 'q1', title: '回答', guidance: '请作答', maxChars }],
    })
    assert.match(questionDefinitionError(questions), /最多字符数须设置为1至5000字/)
  }
})

test('required-answer payloads over the request-safe limit are rejected', () => {
  const questions = serializeRequiredQuestions([
    { id: 'q1', title: '说明', guidance: '请详细作答' },
  ])
  const answers = serializeRequiredAnswers(questions, {
    q1: '中'.repeat(600_000),
  })

  assert.match(requiredAnswerError(questions, answers), /1\.5MB/)
})
