import api from '../api/request.js'
import { applyPreviewTicket } from '../utils/previewImages.js'

export function useSummaryPreviews(students, assignments) {
  const ticketCache = new Map()
  const ticketExpiries = new Map()
  let generation = 0
  function applyTickets(ids = null) {
    const included = ids ? new Set(ids.map(Number)) : null
    for (const student of students.value)
      for (const assignment of assignments.value) {
        const cell = student.cells?.[assignment.id]
        for (const preview of cell?.previews || []) {
          if (included ? !included.has(Number(preview.id)) : preview.ticketPending) continue
          preview.group = cell.kind === 'group'
          const ticket = ticketCache.get(Number(preview.id))
          applyPreviewTicket(preview, ticket)
          preview.ticketUnavailable = !ticket
          preview.ticketPending = false
        }
      }
  }
  async function redeemTickets(ids, refresh = false) {
    const current = generation
    const unique = [...new Set(ids.map(Number).filter(Boolean))]
    const included = new Set(unique)
    for (const student of students.value)
      for (const assignment of assignments.value)
        for (const preview of student.cells?.[assignment.id]?.previews || [])
          if (included.has(Number(preview.id))) preview.ticketPending = true
    const need = unique.filter(
      (id) => refresh || !ticketCache.has(id) || ticketExpiries.get(id) <= Date.now(),
    )
    applyTickets(unique.filter((id) => !need.includes(id)))
    const batches = Array.from({ length: Math.ceil(need.length / 200) }, (_, index) =>
      need.slice(index * 200, (index + 1) * 200),
    )
    await Promise.all(
      batches.map(async (batch) => {
        try {
          const { data } = await api.post('/previews/view-ticket', { ids: batch })
          if (current !== generation) return
          for (const id of batch) {
            const ticket = data.tickets?.[id]
            if (ticket) {
              ticketCache.set(id, ticket)
              ticketExpiries.set(id, Date.now() + 9 * 60 * 1000)
            } else {
              ticketCache.delete(id)
              ticketExpiries.delete(id)
            }
          }
          applyTickets(batch)
        } catch {
          if (current !== generation) return
          for (const id of batch) {
            ticketCache.delete(id)
            ticketExpiries.delete(id)
          }
          applyTickets(batch)
        }
      }),
    )
  }
  return {
    redeemTickets,
    applyTickets,
    clearTickets: () => {
      generation += 1
      ticketCache.clear()
      ticketExpiries.clear()
    },
  }
}
