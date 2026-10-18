export function round1(value) {
  return Math.round(value * 10) / 10
}
export function parseGradeScore(value, totalScore) {
  if (value === null || value === undefined || String(value).trim() === '') return null
  const score = Number(value)
  return Number.isFinite(score) && score >= 0 && score <= Number(totalScore) ? score : null
}
