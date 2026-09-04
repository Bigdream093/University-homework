import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import api, { messageOf } from '../api/request.js'

export function useSubmissions(route) {
  const assignment = ref({}),
    allRows = ref([]),
    filter = ref('all'),
    keyword = ref('')
  let loadSequence = 0
  const requirePreview = computed(() => Number(assignment.value.require_preview_image) === 1)
  const counts = computed(() => ({
    all: allRows.value.length,
    unsubmitted: allRows.value.filter((row) => !row.id).length,
    submitted: allRows.value.filter((row) => row.id && row.status === 'submitted').length,
    late: allRows.value.filter((row) => row.id && row.is_late === 1).length,
    returned: allRows.value.filter((row) => row.status === 'returned').length,
    graded: allRows.value.filter((row) => row.status === 'graded').length,
    missingPreview: allRows.value.filter((row) => row.id && !(row.preview_count > 0)).length,
  }))

  const rows = computed(() => {
    const search = keyword.value.trim().toLowerCase()
    return allRows.value.filter((row) => {
      const matchesSearch =
        !search ||
        row.username.toLowerCase().includes(search) ||
        row.name.toLowerCase().includes(search) ||
        row.members?.some((member) =>
          (member.name + ' ' + member.username).toLowerCase().includes(search),
        )
      if (!matchesSearch) return false
      if (filter.value === 'unsubmitted') return !row.id
      if (filter.value === 'submitted') return row.id && row.status === 'submitted'
      if (filter.value === 'late') return row.is_late === 1
      if (filter.value === 'returned') return row.status === 'returned'
      if (filter.value === 'graded') return row.status === 'graded'
      if (filter.value === 'missingPreview') return row.id && !(row.preview_count > 0)
      return true
    })
  })

  const stats = computed(() => ({
    all: allRows.value.length,
    submitted: allRows.value.filter((row) => row.id).length,
    unsubmitted: allRows.value.filter((row) => !row.id).length,
    graded: allRows.value.filter((row) => row.status === 'graded').length,
  }))

  async function load() {
    const sequence = ++loadSequence
    const assignmentId = route.params.id
    try {
      const [assignmentResponse, submissionResponse] = await Promise.all([
        api.get(`/assignments/${assignmentId}`),
        api.get(`/assignments/${assignmentId}/submissions`),
      ])
      if (sequence !== loadSequence) return
      assignment.value = assignmentResponse.data
      allRows.value = submissionResponse.data
      await redeemPreviewTickets()
    } catch (error) {
      if (sequence === loadSequence) ElMessage.error(messageOf(error))
    }
  }

  // <img> 不携带登录头：批量换取短期票据 URL 供缩略图/大图加载。
  async function redeemPreviewTickets() {
    const all = allRows.value.flatMap((row) => row.previews || [])
    if (!all.length) return
    try {
      const { data } = await api.post('/previews/view-ticket', {
        ids: all.map((preview) => preview.id),
      })
      for (const row of allRows.value) {
        for (const preview of row.previews || []) {
          const ticket = data.tickets[preview.id]
          if (ticket) {
            preview.thumbnail = ticket.thumbnail
            preview.preview = ticket.file
          }
        }
      }
    } catch {
      /* 票据失败时列表仍可见，点开单图走带登录头的接口 */
    }
  }

  return { assignment, allRows, filter, keyword, requirePreview, counts, rows, stats, load }
}
