import { Router } from 'express'
import jwt from 'jsonwebtoken'
import { config } from '../config.js'
import { db } from '../db.js'
import { auth } from '../middleware/auth.js'
import { courseAccess, fail, idValue } from '../services/access.js'
import { serveMaterialFile } from '../services/materialFileService.js'
import { downloadAssignmentPackage, downloadSubmissionPackage } from '../services/packageService.js'
import { serveSubmissionFile, serveSubmissionReceipt } from '../services/submissionFileService.js'
import { submissionAccess } from '../services/submissionQueries.js'

const router = Router()
const kinds = new Set([
  'material',
  'submission-file',
  'submission-receipt',
  'submission-package',
  'assignment-package',
])

function descriptor(body = {}) {
  const kind = String(body.kind || '')
  if (!kinds.has(kind)) fail(400, '下载类型无效')
  return {
    kind,
    id: idValue(body.id),
    group: Boolean(body.group),
    historyId:
      body.historyId === undefined || body.historyId === null ? null : idValue(body.historyId),
    receiptNumber: String(body.receiptNumber || ''),
  }
}

function assertAccess(item, user) {
  if (item.kind === 'material') {
    const material = db.prepare('SELECT course_id FROM materials WHERE id=?').get(item.id)
    if (!material) fail(404, '资料不存在')
    courseAccess(material.course_id, user)
    return
  }
  if (user.role !== 'teacher') fail(403, '仅教师可下载')
  if (item.kind.startsWith('submission-')) {
    const context = submissionAccess(item.id, user, item.group)
    if (item.kind === 'submission-file' && item.historyId !== null) {
      const found = db
        .prepare(
          `SELECT 1 FROM ${context.history} WHERE id=? AND ${context.foreign}=? AND file_state IN ('available','online')`,
        )
        .get(item.historyId, context.row.id)
      if (!found) fail(404, '原文件已替换或不可用')
    }
    if (item.kind === 'submission-receipt' && !/^[A-Za-z0-9_-]{1,120}$/.test(item.receiptNumber))
      fail(400, '回执编号无效')
    return
  }
  const assignment = db
    .prepare(
      'SELECT 1 FROM assignments a JOIN courses c ON c.id=a.course_id WHERE a.id=? AND c.teacher_id=?',
    )
    .get(item.id, user.id)
  if (!assignment) fail(404, '作业不存在')
}

router.post('/downloads/ticket', auth, (req, res) => {
  const item = descriptor(req.body)
  assertAccess(item, req.user)
  const ticket = jwt.sign(
    { purpose: 'file-download', userId: req.user.id, item },
    config.jwtSecret,
    { expiresIn: '5m' },
  )
  res.json({ url: `/api/download-files/${ticket}` })
})

router.get('/download-files/:ticket', async (req, res, next) => {
  try {
    const payload = jwt.verify(req.params.ticket, config.jwtSecret)
    if (payload.purpose !== 'file-download') fail(401, '下载凭证无效')
    const user = db
      .prepare('SELECT id,username,name,role,status,must_change_password FROM users WHERE id=?')
      .get(payload.userId)
    if (!user || user.status !== 'active') fail(401, '账号不存在或已停用')
    const item = descriptor(payload.item)
    assertAccess(item, user)
    if (item.kind === 'material') return serveMaterialFile(item.id, user, res, req, next)
    if (item.kind === 'submission-file')
      return serveSubmissionFile({
        submissionId: item.id,
        historyId: item.historyId,
        group: item.group,
        user,
        res,
        next,
      })
    if (item.kind === 'submission-receipt')
      return serveSubmissionReceipt({
        submissionId: item.id,
        receiptNumber: item.receiptNumber,
        group: item.group,
        user,
        res,
      })
    if (item.kind === 'submission-package')
      return await downloadSubmissionPackage(item.id, user, item.group, res)
    return await downloadAssignmentPackage(item.id, user.id, res)
  } catch (error) {
    if (error.status) next(error)
    else if (['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(error.name))
      next(Object.assign(new Error('下载凭证已失效，请重新下载'), { status: 401 }))
    else next(error)
  }
})

export default router
