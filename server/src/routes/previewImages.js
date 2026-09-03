import { Router } from 'express'
import jwt from 'jsonwebtoken'
import { db } from '../db.js'
import { auth } from '../middleware/auth.js'
import { fail, idValue } from '../services/access.js'
import { submissionAccess } from '../services/submissionQueries.js'
import { resolveUploadPath } from '../utils/uploadPath.js'
import { config } from '../config.js'

// 提交预览图的访问接口：学生仅本人/本组、教师仅本课程，越权一律 404。
const router = Router()
function locateHistory(historyId, user, group) {
  const table = group ? 'group_submission_history' : 'submission_history'
  const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(historyId)
  if (!row) fail(404, '提交历史不存在')
  const ctx = submissionAccess(row[group ? 'group_submission_id' : 'submission_id'], user, group)
  return { group, historyRow: row, ...ctx }
}
function findPreview(id, user) {
  const row = db.prepare('SELECT * FROM submission_preview_images WHERE id=?').get(id)
  if (!row) fail(404, '预览图不存在')
  const group = row.group_submission_history_id !== null
  locateHistory(group ? row.group_submission_history_id : row.submission_history_id, user, group)
  if (row.file_state !== 'available' || !row.file_url) fail(404, '预览图已替换或不可用')
  return row
}
function deliverPreview(row, res, inline) {
  const file = resolveUploadPath(row.file_url, { mustExist: true })
  if (!file) fail(404, '预览图文件不存在')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  if (inline) {
    res.type(row.mime_type || 'image/png')
    return res.sendFile(file)
  }
  return res.download(file, row.original_name)
}
router.get('/submission-history/:id/previews', auth, (req, res) => {
  const { historyRow } = locateHistory(idValue(req.params.id), req.user, false)
  const rows = db
    .prepare(
      `SELECT id,original_name,file_size,mime_type,width,height,sort_order,thumbnail_url FROM submission_preview_images WHERE submission_history_id=? AND file_state='available' ORDER BY sort_order,id`,
    )
    .all(historyRow.id)
  res.json(
    rows.map((preview) => ({
      ...preview,
      thumbnail_url: preview.thumbnail_url ? `/api/submission-previews/${preview.id}/thumbnail` : null,
      file_url: `/api/submission-previews/${preview.id}/file`,
    })),
  )
})
router.get('/group-submission-history/:id/previews', auth, (req, res) => {
  const { historyRow } = locateHistory(idValue(req.params.id), req.user, true)
  const rows = db
    .prepare(
      `SELECT id,original_name,file_size,mime_type,width,height,sort_order,thumbnail_url FROM submission_preview_images WHERE group_submission_history_id=? AND file_state='available' ORDER BY sort_order,id`,
    )
    .all(historyRow.id)
  res.json(
    rows.map((preview) => ({
      ...preview,
      thumbnail_url: preview.thumbnail_url
        ? `/api/group-submission-previews/${preview.id}/thumbnail`
        : null,
      file_url: `/api/group-submission-previews/${preview.id}/file`,
    })),
  )
})
router.get(
  ['/submission-previews/:id/thumbnail', '/group-submission-previews/:id/thumbnail'],
  auth,
  (req, res) => {
    const row = findPreview(idValue(req.params.id), req.user)
    const thumb = row.thumbnail_url && resolveUploadPath(row.thumbnail_url, { mustExist: true })
    if (!thumb) return deliverPreview(row, res, true)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.type('image/jpeg')
    res.sendFile(thumb)
  },
)
router.get(
  ['/submission-previews/:id/file', '/group-submission-previews/:id/file'],
  auth,
  (req, res) => {
    const row = findPreview(idValue(req.params.id), req.user)
    deliverPreview(row, res, false)
  },
)
// <img> 无法携带 Authorization 头：批量签发短期票据，缩略图/大图经票据 URL 加载。
router.post('/previews/view-ticket', auth, (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(idValue).slice(0, 200)
  if (!ids.length) fail(400, '请提供预览图编号')
  const tickets = {}
  for (const id of ids) {
    const row = db.prepare('SELECT id FROM submission_preview_images WHERE id=?').get(id)
    if (!row) continue
    findPreview(id, req.user)
    const ticket = jwt.sign(
      { purpose: 'preview-view', previewId: id, userId: req.user.id },
      config.jwtSecret,
      { expiresIn: '10m' },
    )
    tickets[id] = {
      thumbnail: `/api/preview-files/${ticket}?mode=thumbnail`,
      file: `/api/preview-files/${ticket}`,
    }
  }
  res.json({ tickets })
})
router.get('/preview-files/:ticket', async (req, res, next) => {
  try {
    const payload = jwt.verify(req.params.ticket, config.jwtSecret)
    if (payload.purpose !== 'preview-view') fail(401, '预览凭证无效')
    const user = db
      .prepare('SELECT id,username,name,role,status,must_change_password FROM users WHERE id=?')
      .get(payload.userId)
    if (!user || user.status !== 'active') fail(401, '账号不存在或已停用')
    // 票据只解决 <img> 无法携带 Authorization 的问题，不替代实时权限检查。
    // 学生退出课程、账号停用或教师不再拥有课程后，旧票据立即失效。
    const row = findPreview(idValue(payload.previewId), user)
    if (req.query.mode === 'thumbnail') {
      const thumb = row.thumbnail_url && resolveUploadPath(row.thumbnail_url, { mustExist: true })
      if (!thumb) return deliverPreview(row, res, true)
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.type('image/jpeg')
      return res.sendFile(thumb)
    }
    deliverPreview(row, res, false)
  } catch (error) {
    if (error.status) next(error)
    else next(Object.assign(new Error('预览凭证已失效，请刷新页面'), { status: 401 }))
  }
})
export default router
