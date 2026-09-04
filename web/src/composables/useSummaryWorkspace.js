import { ref } from 'vue'

export function useSummaryWorkspace(students, assignments, load, redeemTickets, applyTickets) {
  const workspace = ref(false),
    workspaceRow = ref(null),
    workspaceRows = ref([]),
    workspaceAssignment = ref({})
  function workspaceRowOf(student, cell) {
    return {
      ...cell,
      name: cell.group_name || student.name,
      username: cell.group_name || student.username,
    }
  }
  async function openWorkspace(student, assignment) {
    const cell = student.cells?.[assignment.id]
    if (!cell || cell.not_assigned || !cell.id) return
    try {
      await redeemTickets((cell.previews || []).map((preview) => preview.id))
      applyTickets()
    } catch {
      /* 打开工作区不依赖票据，图片加载失败时仍有文件链接 */
    }
    workspaceRow.value = workspaceRowOf(student, cell)
    workspaceAssignment.value = assignment
    workspaceRows.value = students.value
      .map((student) => student.cells?.[assignment.id])
      .filter((cell) => cell && !cell.not_assigned && cell.id)
      .map((cell) =>
        workspaceRowOf(
          students.value.find((student) => student.cells?.[assignment.id] === cell),
          cell,
        ),
      )
    workspace.value = true
  }
  function findCellByApiBase(apiBase) {
    for (const student of students.value)
      for (const assignment of assignments.value) {
        const cell = student.cells?.[assignment.id]
        if (cell && cell.api_base === apiBase) return { student, assignment, cell }
      }
    return null
  }
  async function onWorkspaceSaved(row, advance) {
    await load()
    const found = findCellByApiBase(row?.api_base)
    if (found) {
      workspaceRow.value = workspaceRowOf(found.student, found.cell)
      workspaceAssignment.value = found.assignment
      if (advance) {
        workspaceRows.value = students.value
          .map((student) => student.cells?.[found.assignment.id])
          .filter((cell) => cell && !cell.not_assigned && cell.id)
          .map((cell) =>
            workspaceRowOf(
              students.value.find((student) => student.cells?.[found.assignment.id] === cell),
              cell,
            ),
          )
      }
    } else {
      workspace.value = false
    }
  }

  return {
    workspace,
    workspaceRow,
    workspaceRows,
    workspaceAssignment,
    openWorkspace,
    onWorkspaceSaved,
  }
}
