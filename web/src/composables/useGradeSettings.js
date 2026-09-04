import { computed, reactive, ref, watch } from 'vue'

export function useGradeSettings(assignments) {
  const savedConfig = ref({
    daily_ratio: 40,
    final_ratio: 60,
    grade_absent_mode: 'zero',
    final_assignment_id: null,
  })
  const draft = reactive({
    daily_ratio: 40,
    final_ratio: 60,
    grade_absent_mode: 'zero',
    final_assignment_id: null,
    weights: {},
  })
  function syncSaved(config) {
    const finalAssignment = assignments.value.find(
      (assignment) => Number(assignment.is_final) === 1,
    )
    savedConfig.value = {
      daily_ratio: Number(config.daily_ratio ?? 40),
      final_ratio: Number(config.final_ratio ?? 60),
      grade_absent_mode: config.grade_absent_mode === 'skip_ungraded' ? 'skip_ungraded' : 'zero',
      final_assignment_id: finalAssignment ? finalAssignment.id : null,
    }
    const weights = {}
    for (const assignment of assignments.value)
      weights[assignment.id] = Number(assignment.grade_weight ?? 0)
    savedConfig.value.weights = { ...weights }
    Object.assign(draft, {
      daily_ratio: savedConfig.value.daily_ratio,
      final_ratio: savedConfig.value.final_ratio,
      grade_absent_mode: savedConfig.value.grade_absent_mode,
      final_assignment_id: savedConfig.value.final_assignment_id,
      weights,
    })
  }

  // —— 设置草稿与脏检查 ——

  watch(
    () => draft.daily_ratio,
    (value) => {
      draft.final_ratio = Math.round((100 - Number(value || 0)) * 10) / 10
    },
  )

  function snapshotOf(source) {
    return JSON.stringify([
      Number(source.daily_ratio),
      Number(source.final_ratio),
      source.grade_absent_mode,
      source.final_assignment_id,
      assignments.value.map((assignment) => Number(source.weights?.[assignment.id] ?? 0)),
    ])
  }
  const dirty = computed(() => snapshotOf(draft) !== snapshotOf(savedConfig.value))

  const finalCandidates = computed(() =>
    assignments.value.filter((assignment) => assignment.status !== 'draft'),
  )
  const weightRows = computed(() =>
    assignments.value.filter((assignment) => assignment.id !== Number(draft.final_assignment_id)),
  )
  // 平时各项占总成绩百分比之和（草稿与期末作业不参与）；服务端要求它必须等于平时占比才能保存。
  const weightSum = computed(() => {
    let sum = 0
    for (const assignment of assignments.value) {
      if (assignment.id === Number(draft.final_assignment_id) || assignment.status === 'draft')
        continue
      const weight = Number(draft.weights?.[assignment.id] ?? 0)
      if (Number.isFinite(weight) && weight > 0) sum += weight
    }
    return Math.round(sum * 10) / 10
  })
  const dailyTarget = computed(() => Math.round(Number(draft.daily_ratio || 0) * 10) / 10)
  const weightsMatch = computed(() => weightSum.value === dailyTarget.value)
  const finalAssignment = computed(
    () =>
      assignments.value.find((assignment) => assignment.id === Number(draft.final_assignment_id)) ||
      null,
  )

  // 平均分配：把平时占比均分到各已发布平时作业（误差落在最后一项），草稿作业清 0。
  function distributeEvenly() {
    const rows = weightRows.value.filter((assignment) => assignment.status !== 'draft')
    const each = rows.length ? Math.round((dailyTarget.value / rows.length) * 10) / 10 : 0
    let assigned = 0
    for (const assignment of weightRows.value) {
      if (assignment.status === 'draft') {
        draft.weights[assignment.id] = 0
        continue
      }
      const isLast = assignment.id === rows[rows.length - 1].id
      const value = isLast
        ? Math.max(0, Math.round((dailyTarget.value - assigned) * 10) / 10)
        : each
      draft.weights[assignment.id] = value
      assigned = Math.round((assigned + value) * 10) / 10
    }
  }

  return {
    draft,
    dirty,
    syncSaved,
    finalCandidates,
    weightRows,
    weightSum,
    dailyTarget,
    weightsMatch,
    finalAssignment,
    distributeEvenly,
  }
}
