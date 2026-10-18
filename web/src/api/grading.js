import api from './request.js'
import { validateSingleGradingResult } from './contracts.js'

export function gradingItem(row) {
  return {
    id: row.id,
    kind: row.kind || (String(row.api_base || '').startsWith('/group-') ? 'group' : 'individual'),
    expected_status: row.status,
    expected_submit_count: row.submit_count,
  }
}

export async function gradeSubmission(assignmentId, row, payload) {
  const { data } = await api.post(`/assignments/${assignmentId}/batch-grade`, {
    ...payload,
    items: [gradingItem(row)],
  })
  return validateSingleGradingResult(data)
}

export async function returnSubmission(assignmentId, row, payload) {
  const { data } = await api.post(`/assignments/${assignmentId}/batch-return`, {
    ...payload,
    items: [gradingItem(row)],
  })
  return validateSingleGradingResult(data)
}
