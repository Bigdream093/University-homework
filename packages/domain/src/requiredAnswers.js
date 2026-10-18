const MAX_REQUIRED_ANSWERS_BYTES = 1_500_000
export const DEFAULT_REQUIRED_ANSWER_MAX_CHARS = 5000

function envelope(value, kind) {
  try {
    const parsed = JSON.parse(String(value || ''))
    return parsed?.kind === kind ? parsed : null
  } catch {
    return null
  }
}

function isRequiredQuestionSet(value) {
  return !!envelope(value, 'required-questions')
}

export function requiredQuestions(value) {
  if (!String(value || '').trim()) return []
  const parsed = envelope(value, 'required-questions')
  if (parsed && Array.isArray(parsed.questions)) return parsed.questions
  // Before multiple questions were supported, the teacher's entire prompt was plain text.
  return [
    {
      id: 'legacy',
      title: String(value),
      guidance: '',
      maxChars: DEFAULT_REQUIRED_ANSWER_MAX_CHARS,
    },
  ]
}

export function questionDefinitionError(value) {
  const parsed = envelope(value, 'required-questions')
  if (!parsed) return ''
  if (
    parsed.version !== 1 ||
    !Array.isArray(parsed.questions) ||
    !parsed.questions.length ||
    parsed.questions.length > 50
  )
    return '必答题目清单无效，最多可添加50道题目'
  const ids = new Set()
  for (const question of parsed.questions) {
    if (
      !question ||
      typeof question.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(question.id) ||
      ids.has(question.id)
    )
      return '必答题目编号无效或重复'
    ids.add(question.id)
    if (
      typeof question.title !== 'string' ||
      !question.title.trim() ||
      question.title.length > 2000
    )
      return '每道必答题目需要填写题目内容，且不能超过2000字'
    if (typeof question.guidance !== 'string' || question.guidance.length > 10000)
      return '每道题的答题规范不能超过10000字'
    if (question.id !== 'legacy' && !question.guidance.trim()) return '每道必答题目需要填写答题规范'
    const maxChars = question.maxChars ?? DEFAULT_REQUIRED_ANSWER_MAX_CHARS
    if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > DEFAULT_REQUIRED_ANSWER_MAX_CHARS)
      return '每道题的最多字符数须设置为1至5000字'
  }
  return ''
}

export function serializeRequiredQuestions(questions) {
  if (!questions.length) return ''
  return JSON.stringify({
    kind: 'required-questions',
    version: 1,
    questions: questions.map(({ id, title, guidance, maxChars }) => {
      const configuredMax =
        maxChars == null || maxChars === '' ? DEFAULT_REQUIRED_ANSWER_MAX_CHARS : Number(maxChars)
      return {
        id,
        title: title.trim(),
        guidance: guidance.trim(),
        maxChars: configuredMax,
      }
    }),
  })
}

export function requiredAnswerValues(questionValue, content) {
  const parsed = envelope(content, 'required-answers')
  if (parsed && Array.isArray(parsed.answers))
    return Object.fromEntries(
      parsed.answers
        .filter(
          (answer) => answer && typeof answer.id === 'string' && typeof answer.content === 'string',
        )
        .map((answer) => [answer.id, answer.content]),
    )
  if (
    !isRequiredQuestionSet(questionValue) ||
    requiredQuestions(questionValue).some((question) => question.id === 'legacy')
  )
    return { legacy: String(content || '') }
  return {}
}

export function serializeRequiredAnswers(questionValue, values) {
  const questions = requiredQuestions(questionValue)
  if (!isRequiredQuestionSet(questionValue)) return String(values.legacy || '')
  const answers = questions.map((question) => ({
    id: question.id,
    content: String(values[question.id] || ''),
  }))
  if (answers.every((answer) => !answer.content.trim())) return ''
  return JSON.stringify({ kind: 'required-answers', version: 1, answers })
}

export function requiredAnswerError(questionValue, content) {
  const questions = requiredQuestions(questionValue)
  if (!questions.length) return ''
  if (isRequiredQuestionSet(questionValue)) {
    if (new TextEncoder().encode(String(content ?? '')).byteLength > MAX_REQUIRED_ANSWERS_BYTES)
      return '必答题答案总大小不能超过约1.5MB，请缩短部分答案内容后再提交'
    const parsed = envelope(content, 'required-answers')
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.answers))
      return '请逐题填写老师设置的必答题目'
    const ids = new Set()
    for (const answer of parsed.answers) {
      if (
        !answer ||
        typeof answer.id !== 'string' ||
        ids.has(answer.id) ||
        !questions.some((question) => question.id === answer.id) ||
        typeof answer.content !== 'string'
      )
        return '答案与当前必答题目不一致，请刷新页面后重试'
      ids.add(answer.id)
    }
  }
  const values = requiredAnswerValues(questionValue, content)
  for (const [index, question] of questions.entries()) {
    const answer = String(values[question.id] ?? '')
    if (!answer.trim()) return `请回答第${index + 1}道必答题目：${question.title}`
    const maxChars = question.maxChars ?? DEFAULT_REQUIRED_ANSWER_MAX_CHARS
    if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > DEFAULT_REQUIRED_ANSWER_MAX_CHARS)
      return '必答题最多字符数设置无效，请联系老师修改'
    if (answer.length > maxChars) return `第${index + 1}道必答题答案不能超过${maxChars}字`
  }
  return ''
}

export function formatRequiredAnswerText(questionValue, content) {
  const questions = requiredQuestions(questionValue)
  if (!questions.length) return String(content || '')
  const values = requiredAnswerValues(questionValue, content)
  return questions
    .map((question, index) =>
      [
        `必答题目${index + 1}：${question.title}`,
        question.guidance ? `答题规范：\n${question.guidance}` : '',
        `学生答案：\n${values[question.id] || ''}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    )
    .join('\n\n--------------------\n\n')
}
