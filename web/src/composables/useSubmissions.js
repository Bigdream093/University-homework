import { nextTick, onScopeDispose, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import api, { messageOf } from '../api/request.js'
import { applyPreviewTicket } from '../utils/previewImages.js'
import { legacySubmissionPage, validateSubmissionPage } from '../utils/submissionList.js'

const filters = new Set(['unsubmitted', 'submitted', 'returned', 'graded'])

export function useSubmissions(route) {
  const lateRoute = route.query?.filter === 'late',
    requestedLateOnly = lateRoute || route.query?.late === '1' || route.query?.late === 'true',
    initialFilter = lateRoute
      ? 'submitted'
      : filters.has(route.query?.filter)
        ? route.query.filter
        : requestedLateOnly
          ? 'submitted'
          : 'unsubmitted'
  const assignment = ref({}),
    allRows = ref([]),
    filter = ref(initialFilter),
    lateOnly = ref(requestedLateOnly && ['submitted', 'graded'].includes(initialFilter)),
    keyword = ref(String(route.query?.keyword || '')),
    page = ref(1),
    pageSize = ref(50),
    total = ref(0),
    loadError = ref(''),
    counts = ref({
      all: 0,
      unsubmitted: 0,
      submitted: 0,
      late: 0,
      returned: 0,
      graded: 0,
      missingPreview: 0,
    }),
    stats = ref({ all: 0, submitted: 0, unsubmitted: 0, graded: 0 })
  let loadSequence = 0,
    searchTimer,
    searchPending = false,
    syncingPage = false,
    disposed = false,
    legacyAssignmentId,
    legacyRowsCache = []
  const rows = allRows

  async function redeemPreviewTickets(
    sequence,
    previews = allRows.value.flatMap((row) => row.previews || []),
  ) {
    if (!previews.length) return
    previews.forEach((preview) => {
      preview.ticketPending = true
      preview.ticketUnavailable = false
    })
    const ids = [...new Set(previews.map((preview) => Number(preview.id)).filter(Boolean))]
    if (!ids.length) {
      previews.forEach((preview) => {
        preview.ticketUnavailable = true
        preview.ticketPending = false
      })
      return
    }
    const batches = Array.from({ length: Math.ceil(ids.length / 200) }, (_, index) =>
      ids.slice(index * 200, (index + 1) * 200),
    )
    await Promise.all(
      batches.map(async (batch) => {
        if (sequence !== loadSequence) return
        const included = new Set(batch)
        try {
          const { data } = await api.post('/previews/view-ticket', { ids: batch })
          if (sequence !== loadSequence) return
          for (const preview of previews) {
            if (!included.has(Number(preview.id))) continue
            const ticket = data.tickets?.[preview.id]
            applyPreviewTicket(preview, ticket)
            preview.ticketUnavailable = !ticket
            preview.ticketPending = false
          }
        } catch {
          /* 一批凭证失败只影响本批图片，其他批次可继续显示。 */
          if (sequence !== loadSequence) return
          for (const preview of previews) {
            if (!included.has(Number(preview.id))) continue
            preview.ticketUnavailable = true
            preview.ticketPending = false
          }
        }
      }),
    )
  }

  async function loadRows() {
    if (disposed) return
    const sequence = ++loadSequence,
      assignmentId = route.params.id,
      params = {
        page: page.value,
        page_size: pageSize.value,
        status: filter.value,
        late: lateOnly.value ? 1 : undefined,
        keyword: keyword.value.trim() || undefined,
      }
    try {
      const endpoint = `/assignments/${assignmentId}/submissions`
      let { data } = await api.get(endpoint, {
        params: legacyAssignmentId === String(assignmentId) ? undefined : params,
      })
      if (sequence !== loadSequence || String(route.params.id) !== String(assignmentId)) return
      if (Array.isArray(data)) {
        // 旧接口会先按 status/keyword 筛选，必须重新取完整名单才能统计和分页。
        if (legacyAssignmentId !== String(assignmentId)) {
          ;({ data } = await api.get(endpoint))
          if (sequence !== loadSequence || String(route.params.id) !== String(assignmentId)) return
        }
        if (Array.isArray(data)) {
          legacyAssignmentId = String(assignmentId)
          legacyRowsCache = data
          data = legacySubmissionPage(data, assignment.value, {
            status: filter.value,
            lateOnly: lateOnly.value,
            keyword: keyword.value,
            page: page.value,
            pageSize: pageSize.value,
          })
        }
      }
      const result = validateSubmissionPage(data)
      allRows.value = result.rows
      total.value = result.total
      syncingPage = true
      page.value = Number(result.page || page.value)
      pageSize.value = Number(result.page_size || pageSize.value)
      syncingPage = false
      counts.value = result.counts
      stats.value = result.stats
      loadError.value = ''
      await redeemPreviewTickets(sequence)
    } catch (error) {
      if (sequence === loadSequence) {
        loadError.value = messageOf(error)
        ElMessage.error(loadError.value)
      }
    }
  }

  async function load() {
    if (disposed) return
    const assignmentId = route.params.id
    try {
      const { data } = await api.get(`/assignments/${assignmentId}`)
      if (disposed || String(route.params.id) !== String(assignmentId)) return
      assignment.value = data
      await loadRows()
    } catch (error) {
      if (disposed || String(route.params.id) !== String(assignmentId)) return
      loadError.value = messageOf(error)
      ElMessage.error(loadError.value)
    }
  }

  function refreshPreviewTickets(row) {
    const previews = row?.previews || []
    return redeemPreviewTickets(loadSequence, previews)
  }

  async function findNextPending(currentRow) {
    const assignmentId = String(route.params.id)
    let candidates = []
    if (legacyAssignmentId === assignmentId) {
      candidates = legacyRowsCache.filter(
        (row) => row.status === 'submitted' && !row.is_test_student,
      )
    } else {
      let currentPage = 1,
        pageCount = 1
      while (currentPage <= pageCount) {
        const { data } = await api.get(`/assignments/${assignmentId}/submissions`, {
          params: { status: 'submitted', page: currentPage, page_size: 200 },
        })
        if (Array.isArray(data)) {
          legacyAssignmentId = assignmentId
          legacyRowsCache = data
          candidates = data.filter((row) => row.status === 'submitted' && !row.is_test_student)
          break
        }
        const result = validateSubmissionPage(data)
        candidates.push(...result.rows.filter((row) => !row.is_test_student))
        pageCount = Math.max(1, Math.ceil(result.total / Math.max(1, result.page_size || 200)))
        currentPage += 1
      }
    }
    if (String(route.params.id) !== assignmentId) return null
    const currentSubmittedAt = String(currentRow?.submitted_at || '')
    candidates.sort((left, right) =>
      String(left.submitted_at || '').localeCompare(String(right.submitted_at || '')),
    )
    const next =
      candidates.find((row) => {
        const submittedAt = String(row.submitted_at || '')
        return currentSubmittedAt && submittedAt > currentSubmittedAt
      }) ||
      candidates[0] ||
      null
    return next
  }

  watch(
    [filter, lateOnly, keyword, page, pageSize],
    ([status, late, search, , size], [oldStatus, oldLate, oldSearch, , oldSize]) => {
      if (syncingPage || disposed) return
      searchPending ||= search !== oldSearch
      if (['unsubmitted', 'returned'].includes(status) && late) {
        lateOnly.value = false
        return
      }
      if (
        page.value !== 1 &&
        (status !== oldStatus || late !== oldLate || search !== oldSearch || size !== oldSize)
      ) {
        page.value = 1
        return
      }
      clearTimeout(searchTimer)
      const sequence = ++loadSequence
      const refresh = () => {
        if (disposed || sequence !== loadSequence) return
        searchPending = false
        loadRows()
      }
      if (searchPending) searchTimer = window.setTimeout(refresh, 250)
      else nextTick(refresh)
    },
    { flush: 'sync' },
  )
  onScopeDispose(() => {
    disposed = true
    loadSequence += 1
    clearTimeout(searchTimer)
  })

  return {
    assignment,
    allRows,
    filter,
    lateOnly,
    keyword,
    loadError,
    counts,
    rows,
    stats,
    page,
    pageSize,
    total,
    load,
    loadRows,
    refreshPreviewTickets,
    findNextPending,
  }
}
