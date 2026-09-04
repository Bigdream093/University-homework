import api from '../api/request.js'

export function useSummaryPreviews(students, assignments) {
  const ticketCache = new Map()
  // <img> 不携带登录头：批量换取短期票据，单次上限 200 张，超量分批。
  async function redeemTickets(ids) {
    const need = [...new Set(ids)].filter((id) => !ticketCache.has(id))
    for (let index = 0; index < need.length; index += 200) {
      const { data } = await api.post('/previews/view-ticket', {
        ids: need.slice(index, index + 200),
      })
      for (const [id, ticket] of Object.entries(data.tickets || {}))
        ticketCache.set(Number(id), ticket || null)
    }
  }
  async function redeemFirstPreviews() {
    const ids = []
    for (const student of students.value)
      for (const assignment of assignments.value) {
        const cell = student.cells?.[assignment.id]
        if (cell?.previews?.length) ids.push(cell.previews[0].id)
      }
    if (!ids.length) return
    try {
      await redeemTickets(ids)
      applyTickets()
    } catch {
      /* 票据失败时缩略图不可见，分数与文件链接不受影响 */
    }
  }
  function applyTickets() {
    for (const student of students.value)
      for (const assignment of assignments.value) {
        for (const preview of student.cells?.[assignment.id]?.previews || []) {
          const ticket = ticketCache.get(preview.id)
          if (ticket) {
            preview.thumbnail = ticket.thumbnail
            preview.preview = ticket.file
          }
        }
      }
  }

  return {
    redeemTickets,
    redeemFirstPreviews,
    applyTickets,
    clearTickets: () => ticketCache.clear(),
  }
}
