const round1 = (value) => Math.round(value * 10) / 10

// 折算百分制；满分无效或成绩缺失返回 null（该作业整体跳过，避免除零）。
function normalize(score, totalScore) {
  const total = Number(totalScore),
    numericScore = Number(score)
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(numericScore)) return null
  return (numericScore / total) * 100
}

// 三栏成绩计算（前端在设置未保存时按同一公式实时预览，服务端是保存与导出的唯一口径）。
// 占比口径：grade_weight 直接存该作业占总成绩的百分比（0-100），平时各项之和必须等于课程平时占比
// （saveGradeConfig 强校验），因此 Σ(折算分×占比)÷100 即平时部分对总成绩的贡献，与按占比配置直观一致。
// 计入方式：zero=未交/未评均按0计入；skip_ungraded=未评（已交待批改、已退回）跳过，其占比按比例
// 分摊给已计入项，未交/未安排仍按0计入。草稿作业从未发布，学生不可能提交，一律不参与计算。
export function computeRawScores(cells, assignments, config) {
  let weighted = 0,
    weightSum = 0
  for (const assignment of assignments) {
    if (Number(assignment.is_final) === 1 || assignment.status === 'draft') continue
    const weight = Number(assignment.grade_weight)
    if (!Number.isFinite(weight) || weight <= 0) continue
    const total = Number(assignment.total_score)
    if (!Number.isFinite(total) || total <= 0) continue
    const cell = cells[assignment.id]
    const graded =
      cell && !cell.not_assigned && cell.status === 'graded' && Number.isFinite(Number(cell.score))
    if (graded) {
      weighted += normalize(cell.score, total) * weight
      weightSum += weight
    } else if (!cell || cell.not_assigned || config.grade_absent_mode === 'zero') {
      weighted += 0
      weightSum += weight
    }
  }
  const dailyRaw = weightSum > 0 ? weighted / weightSum : null
  const finalAssignment = assignments.find(
    (assignment) => Number(assignment.is_final) === 1 && assignment.status !== 'draft',
  )
  let finalRaw = null
  if (finalAssignment) {
    const cell = cells[finalAssignment.id]
    if (
      cell &&
      !cell.not_assigned &&
      cell.status === 'graded' &&
      Number.isFinite(Number(cell.score))
    ) {
      finalRaw = normalize(cell.score, finalAssignment.total_score)
    }
  }
  const totalRaw =
    dailyRaw !== null && finalRaw !== null
      ? (dailyRaw * config.daily_ratio) / 100 + (finalRaw * config.final_ratio) / 100
      : dailyRaw !== null
        ? dailyRaw
        : finalRaw
  return { daily: dailyRaw, final: finalRaw, total: totalRaw }
}

export function computeScores(cells, assignments, config) {
  const raw = computeRawScores(cells, assignments, config)
  return {
    daily_score: raw.daily === null ? null : round1(raw.daily),
    final_score: raw.final === null ? null : round1(raw.final),
    total_score: raw.total === null ? null : round1(raw.total),
  }
}
