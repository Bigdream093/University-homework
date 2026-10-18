import { Router } from 'express'
import jwt from 'jsonwebtoken'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import sharp from 'sharp'
import { db } from '../db.js'
import { auth } from '../middleware/auth.js'
import { fail, idValue } from '../services/access.js'
import { submissionAccess } from '../services/submissionQueries.js'
import { resolveUploadPath, toStorageKey } from '../utils/uploadPath.js'
import { config } from '../config.js'

// 提交预览图的访问接口：学生仅本人/本组、教师仅本课程，越权一律 404。
const router = Router()
const thumbnailJobs = new Map()
function recordTiming(res, name, started) {
  res.append('Server-Timing', `${name};dur=${(performance.now() - started).toFixed(1)}`)
}
function previewRows(ids, user) {
  if (!ids.length) return new Map()
  const marks = ids.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT p.*,
        COALESCE(h.id,gh.id) access_history_id,
        COALESCE(s.id,gs.id) access_submission_id,
        COALESCE(s.assignment_id,g.assignment_id) access_assignment_id,
        s.student_id access_student_id,
        a.status access_assignment_status,
        c.id access_course_id,c.teacher_id access_course_teacher_id,
        cs.student_id access_course_student_id,
        gm.student_id access_group_member_id
       FROM submission_preview_images p
       LEFT JOIN submission_history h ON h.id=p.submission_history_id
       LEFT JOIN submissions s ON s.id=h.submission_id
       LEFT JOIN group_submission_history gh ON gh.id=p.group_submission_history_id
       LEFT JOIN group_submissions gs ON gs.id=gh.group_submission_id
       LEFT JOIN assignment_groups g ON g.id=gs.assignment_group_id
       LEFT JOIN assignments a ON a.id=COALESCE(s.assignment_id,g.assignment_id)
       LEFT JOIN courses c ON c.id=a.course_id
       LEFT JOIN course_students cs ON cs.course_id=c.id AND cs.student_id=?
       LEFT JOIN assignment_group_members gm ON gm.assignment_group_id=g.id AND gm.student_id=?
       WHERE p.id IN (${marks})`,
    )
    .all(user.id, user.id, ...ids)
  return new Map(rows.map((row) => [row.id, row]))
}
function assertPreviewAccess(row, user) {
  if (
    !row.access_history_id ||
    !row.access_submission_id ||
    !row.access_assignment_id ||
    !row.access_course_id
  )
    fail(404, '提交历史不存在')
  if (user.role === 'teacher') {
    if (Number(row.access_course_teacher_id) !== Number(user.id)) fail(403, '无权访问该课程')
  } else if (!row.access_course_student_id) {
    fail(403, '无权访问该课程')
  }
  if (user.role === 'student') {
    if (!['published', 'closed'].includes(row.access_assignment_status)) fail(404, '作业尚未发布')
    if (row.group_submission_history_id !== null) {
      if (!row.access_group_member_id) fail(403, '本次作业未安排你参与')
    } else if (Number(row.access_student_id) !== Number(user.id)) {
      fail(403, '无权访问提交记录')
    }
  }
  if (row.file_state !== 'available' || !row.file_url) fail(404, '预览图已替换或不可用')
  return row
}
function locateHistory(historyId, user, group) {
  const table = group ? 'group_submission_history' : 'submission_history'
  const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(historyId)
  if (!row) fail(404, '提交历史不存在')
  const ctx = submissionAccess(row[group ? 'group_submission_id' : 'submission_id'], user, group)
  return { group, historyRow: row, ...ctx }
}
function findPreview(id, user, res) {
  const started = performance.now()
  const row = previewRows([id], user).get(id)
  recordTiming(res, 'preview_access', started)
  if (!row) fail(404, '预览图不存在')
  return assertPreviewAccess(row, user)
}
async function storedThumbnail(row) {
  const existing = row.thumbnail_url && resolveUploadPath(row.thumbnail_url, { mustExist: true })
  if (existing) return existing
  const pending = thumbnailJobs.get(row.id)
  if (pending) return pending
  const original = resolveUploadPath(row.file_url, { mustExist: true })
  if (!original) fail(404, '预览图文件不存在')
  const job = (async () => {
    const directory = path.join(config.uploadDir, 'previews')
    await fs.promises.mkdir(directory, { recursive: true })
    const thumbnailPath = path.join(directory, `${randomUUID()}.jpg`)
    try {
      await sharp(original)
        .rotate()
        .resize({ width: 480, withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toFile(thumbnailPath)
    } catch (error) {
      await fs.promises.rm(thumbnailPath, { force: true }).catch(() => {})
      throw error
    }
    const key = toStorageKey(thumbnailPath)
    const updated = db
      .prepare(
        `UPDATE submission_preview_images SET thumbnail_url=?
         WHERE id=? AND file_state='available' AND file_url=?`,
      )
      .run(key, row.id, row.file_url)
    if (!updated.changes) {
      await fs.promises.rm(thumbnailPath, { force: true }).catch(() => {})
      fail(404, '预览图已替换或不可用')
    }
    return thumbnailPath
  })()
  thumbnailJobs.set(row.id, job)
  try {
    return await job
  } finally {
    if (thumbnailJobs.get(row.id) === job) thumbnailJobs.delete(row.id)
  }
}

async function deliverPreview(row, res, thumbnail, download = false) {
  res.setHeader('Cache-Control', 'private, no-store')
  if (thumbnail) {
    const started = performance.now()
    let thumb
    try {
      thumb = await storedThumbnail(row)
    } catch (error) {
      if (error.status) throw error
      // Keep older readable images available if thumbnail conversion fails.
    } finally {
      recordTiming(res, 'preview_thumbnail', started)
    }
    if (thumb) {
      res.setHeader('X-Preview-Variant', 'thumbnail')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.type('image/jpeg')
      return res.sendFile(thumb)
    }
  }
  const file = resolveUploadPath(row.file_url, { mustExist: true })
  if (!file) fail(404, '预览图文件不存在')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Preview-Variant', thumbnail ? 'original-fallback' : 'original')
  if (thumbnail) {
    res.type(row.mime_type || 'image/png')
    return res.sendFile(file)
  }
  if (download) return res.download(file, row.original_name)
  res.type(row.mime_type || (/\.jpe?g$/i.test(row.original_name) ? 'image/jpeg' : 'image/png'))
  res.setHeader('Content-Disposition', 'inline')
  return res.sendFile(file)
}
router.get('/submission-history/:id/previews', auth, (req, res) => {
  const { historyRow } = locateHistory(idValue(req.params.id), req.user, false)
  const rows = db
    .prepare(
      "SELECT id,original_name,file_size,mime_type,width,height,sort_order,thumbnail_url FROM submission_preview_images WHERE submission_history_id=? AND file_state='available' ORDER BY sort_order,id",
    )
    .all(historyRow.id)
  res.json(
    rows.map((preview) => ({
      ...preview,
      thumbnail_url: preview.thumbnail_url
        ? `/api/submission-previews/${preview.id}/thumbnail`
        : null,
      file_url: `/api/submission-previews/${preview.id}/file`,
    })),
  )
})
router.get('/group-submission-history/:id/previews', auth, (req, res) => {
  const { historyRow } = locateHistory(idValue(req.params.id), req.user, true)
  const rows = db
    .prepare(
      "SELECT id,original_name,file_size,mime_type,width,height,sort_order,thumbnail_url FROM submission_preview_images WHERE group_submission_history_id=? AND file_state='available' ORDER BY sort_order,id",
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
  async (req, res, next) => {
    try {
      const row = findPreview(idValue(req.params.id), req.user, res)
      await deliverPreview(row, res, true)
    } catch (error) {
      next(error)
    }
  },
)
router.get(
  ['/submission-previews/:id/file', '/group-submission-previews/:id/file'],
  auth,
  async (req, res, next) => {
    try {
      const row = findPreview(idValue(req.params.id), req.user, res)
      await deliverPreview(row, res, false, req.query.download === '1')
    } catch (error) {
      next(error)
    }
  },
)
// <img> 无法携带 Authorization 头：批量签发短期票据，缩略图/大图经票据 URL 加载。
router.post('/previews/view-ticket', auth, (req, res) => {
  const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(idValue))].slice(
    0,
    200,
  )
  if (!ids.length) fail(400, '请提供预览图编号')
  const tickets = {},
    errors = {}
  const accessStarted = performance.now()
  const rows = previewRows(ids, req.user)
  recordTiming(res, 'preview_access', accessStarted)
  const signingStarted = performance.now()
  for (const id of ids) {
    try {
      const row = rows.get(id)
      if (!row) continue
      assertPreviewAccess(row, req.user)
      const ticket = jwt.sign(
        {
          purpose: 'preview-view',
          previewId: id,
          userId: req.user.id,
          authVersion: Number(req.user.auth_version || 0),
        },
        config.jwtSecret,
        { expiresIn: '10m' },
      )
      tickets[id] = {
        thumbnail: `/api/preview-files/${ticket}?mode=thumbnail`,
        file: `/api/preview-files/${ticket}`,
      }
    } catch (error) {
      // 一张历史图片失效时跳过它，避免同批其他正常图片也拿不到查看凭证。
      if (error.status !== 404) throw error
      errors[id] = '图片不存在、已被替换或没有查看权限'
    }
  }
  recordTiming(res, 'preview_tickets', signingStarted)
  res.json({ tickets, errors })
})
router.get('/preview-files/:ticket', async (req, res, next) => {
  try {
    let payload
    try {
      payload = jwt.verify(req.params.ticket, config.jwtSecret)
    } catch {
      fail(401, '预览凭证已失效，请刷新页面')
    }
    if (payload.purpose !== 'preview-view') fail(401, '预览凭证无效')
    const user = db
      .prepare(
        'SELECT id,username,name,role,status,must_change_password,auth_version FROM users WHERE id=?',
      )
      .get(payload.userId)
    if (!user || user.status !== 'active') fail(401, '账号不存在或已停用')
    if (Number(payload.authVersion || 0) !== Number(user.auth_version || 0))
      fail(401, '预览凭证已失效，请刷新页面')
    // 票据只解决 <img> 无法携带 Authorization 的问题，不替代实时权限检查。
    // 学生退出课程、账号停用或教师不再拥有课程后，旧票据立即失效。
    const row = findPreview(idValue(payload.previewId), user, res)
    await deliverPreview(row, res, req.query.mode === 'thumbnail', req.query.download === '1')
  } catch (error) {
    next(error)
  }
})
export default router
