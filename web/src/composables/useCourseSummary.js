import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import api, { messageOf } from '../api/request.js'
import { validateCourseSummary } from '../api/contracts.js'
import { downloadBlob } from '../utils/files.js'
import { computeRawScores } from '@university-homework/domain/gradeScores'
import { useGradeSettings } from './useGradeSettings.js'
import { useSummaryPreviews } from './useSummaryPreviews.js'

export function useCourseSummary(props) {
  const loading = ref(false),
    assignments = ref([]),
    students = ref([])
  const keyword = ref(''),
    showDraftColumns = ref(false),
    saving = ref(false),
    exporting = ref(false)
  const settings = useGradeSettings(assignments)
  const { draft, dirty, syncSaved, weightsMatch, weightSum, dailyTarget } = settings
  let loadSequence = 0
  const loadError = ref('')
  const { redeemTickets, applyTickets, clearTickets } = useSummaryPreviews(students, assignments)
  async function load() {
    const sequence = ++loadSequence,
      courseId = props.courseId
    if (!courseId) return
    loading.value = true
    loadError.value = ''
    try {
      const { data } = await api.get(`/courses/${courseId}/summary`)
      if (sequence !== loadSequence || String(props.courseId) !== String(courseId)) return
      validateCourseSummary(data)
      const draftSnapshot = dirty.value
        ? {
            daily_ratio: draft.daily_ratio,
            final_ratio: draft.final_ratio,
            grade_absent_mode: draft.grade_absent_mode,
            final_assignment_id: draft.final_assignment_id,
            weights: { ...draft.weights },
          }
        : null
      clearTickets()
      assignments.value = data.assignments || []
      students.value = data.students || []
      syncSaved(data.config || {})
      const previewIds = students.value.flatMap((student) =>
        Object.values(student.cells || {}).flatMap((cell) =>
          cell?.previews?.[0]?.id ? [cell.previews[0].id] : [],
        ),
      )
      if (previewIds.length) {
        const applyCurrentTickets = () => {
          if (sequence === loadSequence && String(props.courseId) === String(courseId))
            applyTickets()
        }
        redeemTickets(previewIds).then(applyCurrentTickets).catch(applyCurrentTickets)
      }
      if (draftSnapshot) {
        draftSnapshot.weights = Object.fromEntries(
          assignments.value.map((assignment) => [
            assignment.id,
            draftSnapshot.weights[assignment.id] ?? Number(assignment.grade_weight ?? 0),
          ]),
        )
        Object.assign(draft, draftSnapshot)
      }
    } catch (error) {
      if (sequence === loadSequence) {
        loadError.value = messageOf(error)
        ElMessage.error(loadError.value)
      }
    } finally {
      if (sequence === loadSequence) loading.value = false
    }
  }

  async function saveConfig({ silent = false } = {}) {
    if (loadError.value || loading.value) return false
    if (!weightsMatch.value) {
      ElMessage.warning(
        `平时各项占比之和（${weightSum.value}%）必须等于平时占比（${dailyTarget.value}%）`,
      )
      return false
    }
    saving.value = true
    try {
      const { data } = await api.put(`/courses/${props.courseId}/grade-config`, {
        daily_ratio: Number(draft.daily_ratio),
        final_ratio: Number(draft.final_ratio),
        grade_absent_mode: draft.grade_absent_mode,
        final_assignment_id: draft.final_assignment_id || null,
        weights: assignments.value.map((assignment) => ({
          assignment_id: assignment.id,
          grade_weight: Number(draft.weights?.[assignment.id] ?? 1),
        })),
      })
      for (const assignment of assignments.value) {
        assignment.grade_weight = Number(draft.weights?.[assignment.id] ?? 0)
        assignment.is_final = Number(assignment.id) === Number(draft.final_assignment_id) ? 1 : 0
      }
      syncSaved(data.config || draft)
      if (!silent) ElMessage.success('成绩设置已保存')
      return true
    } catch (error) {
      ElMessage.error(messageOf(error))
      return false
    } finally {
      saving.value = false
    }
  }

  async function exportExcel() {
    if (loadError.value || loading.value) return
    if (dirty.value && !props.readonly) {
      const ok = await saveConfig({ silent: true })
      if (!ok) return
      ElMessage.success('未保存的成绩设置已随导出一并保存')
    }
    exporting.value = true
    try {
      const response = await api.get(`/courses/${props.courseId}/summary/export`, {
        responseType: 'blob',
        timeout: 0,
      })
      downloadBlob(response.data, `${props.courseName || '课程'}-成绩汇总.xlsx`)
    } catch (error) {
      ElMessage.error(messageOf(error))
    } finally {
      exporting.value = false
    }
  }

  const visibleAssignments = computed(() =>
    showDraftColumns.value
      ? assignments.value
      : assignments.value.filter((assignment) => assignment.status !== 'draft'),
  )
  const scoredStudents = computed(() =>
    students.value.map((student) => ({ ...student, live: computeScores(student.cells || {}) })),
  )
  const tableRows = computed(() => {
    const search = keyword.value.trim().toLowerCase()
    return scoredStudents.value.filter(
      (student) =>
        !search ||
        String(student.username).toLowerCase().includes(search) ||
        String(student.name).toLowerCase().includes(search),
    )
  })

  const previewAssignments = computed(() =>
    assignments.value.map((assignment) => ({
      ...assignment,
      is_final: assignment.id === Number(draft.final_assignment_id) ? 1 : 0,
      grade_weight: Number(draft.weights?.[assignment.id] ?? assignment.grade_weight ?? 0),
    })),
  )
  function computeScores(cells) {
    return computeRawScores(cells, previewAssignments.value, draft)
  }
  watch(() => props.courseId, load, { immediate: true })
  return {
    ...settings,
    loading,
    loadError,
    assignments,
    students,
    keyword,
    showDraftColumns,
    saving,
    exporting,
    visibleAssignments,
    tableRows,
    load,
    saveConfig,
    exportExcel,
    redeemTickets,
    applyTickets,
  }
}
