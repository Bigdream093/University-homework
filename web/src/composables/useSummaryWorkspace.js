import { ref } from 'vue'
import api from '../api/request.js'
import { normalizePreview } from '../utils/previewImages.js'

export function useSummaryWorkspace(students, assignments, redeemTickets, applyTickets, courseId) {
  const workspace = ref(false),
    workspaceRow = ref(null),
    workspaceRows = ref([]),
    workspaceAssignment = ref({}),
    workspaceIntent = ref('view')
  let openSequence = 0
  function workspaceRowOf(student, cell) {
    return {
      ...cell,
      name: cell.group_name || student.name,
      username: cell.group_name || student.username,
    }
  }
  function rowsForAssignment(assignmentId) {
    const seen = new Set()
    return students.value.flatMap((student) => {
      const cell = student.cells?.[assignmentId]
      if (!cell || cell.not_assigned || !cell.id || (cell.api_base && seen.has(cell.api_base)))
        return []
      if (cell.api_base) seen.add(cell.api_base)
      return [workspaceRowOf(student, cell)]
    })
  }
  async function detailedRow(student, assignment, cell) {
    const previewsReady = preparePreviews(cell)
    let detail = null
    try {
      const id = typeof courseId === 'function' ? courseId() : courseId
      const { data } = await api.get(`/courses/${id}/students/${student.id}/submissions`, {
        params: { assignment_id: assignment.id },
      })
      const rows = Array.isArray(data) ? data : data.rows || []
      detail =
        rows.find(
          (row) =>
            row.api_base === cell.api_base ||
            (row.id === cell.id && row.assignment_id === assignment.id),
        ) || null
    } catch {
      /* 成绩汇总仍可使用基础信息打开，详情接口失败时保留摘要数据。 */
    }
    await previewsReady
    const base = workspaceRowOf(student, cell)
    const ticketedById = new Map(
      (cell.previews || []).map((preview) => [Number(preview.id), preview]),
    )
    const previews = (Array.isArray(detail?.previews) ? detail.previews : cell.previews || []).map(
      (value) => {
        const preview = normalizePreview(value)
        const ticketed = ticketedById.get(Number(preview.id))
        if (ticketed?.thumbnail) preview.thumbnail = ticketed.thumbnail
        if (ticketed?.preview) preview.preview = ticketed.preview
        return preview
      },
    )
    return {
      ...base,
      ...(detail || {}),
      name: base.name,
      username: base.username,
      previews,
    }
  }
  async function openWorkspace(student, assignment, intent = 'view') {
    const cell = student.cells?.[assignment.id]
    if (!cell || cell.not_assigned || !cell.id) return
    const sequence = ++openSequence
    const row = await detailedRow(student, assignment, cell)
    if (sequence !== openSequence) return
    workspaceRow.value = row
    workspaceAssignment.value = assignment
    workspaceRows.value = rowsForAssignment(assignment.id)
    workspaceIntent.value = intent
    workspace.value = true
  }
  async function preparePreviews(cell) {
    try {
      const ids = (cell.previews || []).map((preview) => preview.id)
      if (ids.length) await redeemTickets(ids)
    } catch {
      /* 打开工作区不依赖票据，图片加载失败时仍有文件链接 */
    }
    applyTickets()
  }
  function findCellByApiBase(apiBase) {
    for (const student of students.value)
      for (const assignment of assignments.value) {
        const cell = student.cells?.[assignment.id]
        if (cell && cell.api_base === apiBase) return { student, assignment, cell }
      }
    return null
  }
  function patchSavedRow(row) {
    if (!row?.api_base) return null
    const found = findCellByApiBase(row.api_base)
    if (!found) return null
    const updates = {
      status: row.status,
      score: row.score,
      comment: row.comment || '',
      returned_reason: row.returned_reason || '',
    }
    for (const student of students.value) {
      const cell = student.cells?.[found.assignment.id]
      if (cell?.api_base === row.api_base) Object.assign(cell, updates)
    }
    return found
  }
  async function onWorkspaceSaved(row, advance, nextRow) {
    const saved = patchSavedRow(row)
    if (!saved) return
    if (advance && !nextRow) {
      workspace.value = false
      return
    }
    const next = advance && nextRow ? findCellByApiBase(nextRow.api_base) : null
    if (next) workspaceRow.value = await detailedRow(next.student, next.assignment, next.cell)
    const current = next || saved
    if (!next)
      workspaceRow.value = {
        ...workspaceRow.value,
        ...workspaceRowOf(current.student, current.cell),
        previews: workspaceRow.value?.previews || current.cell.previews || [],
      }
    workspaceAssignment.value = current.assignment
    workspaceIntent.value = next ? 'grade' : 'view'
    if (advance) workspaceRows.value = rowsForAssignment(current.assignment.id)
  }

  return {
    workspace,
    workspaceRow,
    workspaceRows,
    workspaceAssignment,
    workspaceIntent,
    openWorkspace,
    onWorkspaceSaved,
  }
}
