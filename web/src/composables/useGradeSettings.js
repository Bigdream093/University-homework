import { computed, reactive, ref, watch } from 'vue'
import { round1 } from '@university-homework/domain/numbers'
import { dailyWeightSum } from '@university-homework/domain/gradeScores'

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
    Object.assign(draft, savedConfig.value, { weights })
  }

  // —— 设置草稿与脏检查 ——

  watch(
    () => draft.daily_ratio,
    (value) => {
      draft.final_ratio = round1(100 - Number(value || 0))
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
  const weightSum = computed(() =>
    dailyWeightSum(assignments.value, draft.final_assignment_id, draft.weights),
  )
  const dailyTarget = computed(() => round1(Number(draft.daily_ratio || 0)))
  const weightsMatch = computed(() => weightSum.value === dailyTarget.value)
  const finalAssignment = computed(
    () =>
      assignments.value.find((assignment) => assignment.id === Number(draft.final_assignment_id)) ||
      null,
  )

  // 平均分配：按0.1个百分点分配余数，保证合计精确；草稿作业清 0。
  function distributeEvenly() {
    const rows = weightRows.value.filter((assignment) => assignment.status !== 'draft')
    const targetTenths = Math.round(dailyTarget.value * 10)
    const baseTenths = rows.length ? Math.floor(targetTenths / rows.length) : 0
    let remainder = rows.length ? targetTenths % rows.length : 0
    for (const assignment of weightRows.value) {
      if (assignment.status === 'draft') {
        draft.weights[assignment.id] = 0
        continue
      }
      const valueTenths = baseTenths + (remainder > 0 ? 1 : 0)
      if (remainder > 0) remainder -= 1
      draft.weights[assignment.id] = valueTenths / 10
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
