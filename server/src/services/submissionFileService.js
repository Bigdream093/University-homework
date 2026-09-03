import { db } from '../db.js'
import { fail, idValue } from './access.js'
import { receipts, submissionAccess } from './submissionQueries.js'
import { resolveUploadPath } from '../utils/uploadPath.js'

export function serveSubmissionFile({
  submissionId,
  historyId,
  group,
  user,
  res,
  next = () => {},
}) {
  const context = submissionAccess(submissionId, user, group)
  let row = context.row
  if (historyId !== undefined && historyId !== null) {
    const id = idValue(historyId)
    row = db
      .prepare(`SELECT * FROM ${context.history} WHERE id=? AND ${context.foreign}=?`)
      .get(id, context.row.id)
    if (!row || !['available', 'online'].includes(row.file_state)) fail(404, '原文件已替换或不可用')
  }
  if (row.file_url) {
    const file = resolveUploadPath(row.file_url, { mustExist: true })
    if (!file) fail(404, '文件不存在')
    return res.download(file, row.file_name, (error) => {
      if (error && !res.headersSent) next(error)
    })
  }
  if (row.content)
    return res.attachment('answer.txt').type('text/plain; charset=utf-8').send(row.content)
  fail(404, '文件不存在')
}

export function serveSubmissionReceipt({ submissionId, receiptNumber, group, user, res }) {
  submissionAccess(submissionId, user, group)
  const receipt = receipts(submissionId, group).find((row) => row.receipt_no === receiptNumber)
  if (!receipt) fail(404, '回执不存在')
  return res
    .attachment(`${receipt.receipt_no}.txt`)
    .type('text/plain; charset=utf-8')
    .send(JSON.stringify(receipt, null, 2))
}
