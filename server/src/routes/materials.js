import path from 'node:path'
import { Router } from 'express'
import jwt from 'jsonwebtoken'
import { db } from '../db.js'
import { auth } from '../middleware/auth.js'
import { teacherOnly } from '../middleware/teacher.js'
import { uploadSingle } from '../middleware/upload.js'
import { safeName } from '../utils/fileFilter.js'
import { courseAccess, fail, textValue, idValue } from '../services/access.js'
import { deleteMaterial, materialView } from '../services/materialService.js'
import { executeOperation, operationStatus } from '../services/operations.js'
import { queueCleanup } from '../services/storage.js'
import {
  serveMaterialFile,
  recordCompletedResumableDownload,
} from '../services/materialFileService.js'
import { nowText } from '../utils/time.js'
import { config } from '../config.js'
const router = Router()
function limitMaterialUpload(req, _res, next) {
  req.uploadLimit = config.materialUploadMaxMb * 1024 * 1024
  req.uploadLabel = '课程资料'
  next()
}
function material(id, user, write = false) {
  const materialRecord = db.prepare('SELECT * FROM materials WHERE id=?').get(id)
  if (!materialRecord) fail(404, '资料不存在')
  courseAccess(materialRecord.course_id, user, { write })
  return materialRecord
}
router.get('/courses/:id/materials', auth, (req, res) => {
  const course = courseAccess(req.params.id, req.user)
  res.json(
    db
      .prepare('SELECT id FROM materials WHERE course_id=? ORDER BY id DESC')
      .all(course.id)
      .map(({ id }) => materialView(id)),
  )
})
router.post(
  '/courses/:id/materials',
  auth,
  teacherOnly,
  (req, res, next) => {
    courseAccess(req.params.id, req.user, { write: true })
    next()
  },
  limitMaterialUpload,
  uploadSingle,
  async (req, res) => {
    try {
      const course = courseAccess(req.params.id, req.user, { write: true })
      const data = await executeOperation(req, 'material-create', course.id, () => {
        // 权限已在路由预检与 executeOperation 内两次确认，事务动作内不再重复检查。
        if (!req.file) fail(400, '请选择资料文件')
        const file = req.file
        const id = db
          .prepare(
            'INSERT INTO materials(course_id,teacher_id,title,description,file_url,file_name,file_size,file_type,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
          )
          .run(
            course.id,
            req.user.id,
            textValue(req.body.title, '资料标题', 200),
            textValue(req.body.description, '资料说明', 20000, false),
            file.storageKey,
            safeName(file.originalname),
            file.size,
            path.extname(file.originalname).slice(1).toLowerCase(),
            nowText(),
          ).lastInsertRowid
        return materialView(id)
      })
      res.status(data.replayed ? 200 : 201).json(data)
    } catch (error) {
      if (req.file) queueCleanup([req.file.path], '失败上传')
      throw error
    }
  },
)
router.put(
  '/materials/:id',
  auth,
  teacherOnly,
  (req, res, next) => {
    material(req.params.id, req.user, true)
    next()
  },
  limitMaterialUpload,
  uploadSingle,
  async (req, res) => {
    try {
      const materialRecord = material(req.params.id, req.user, true),
        data = await executeOperation(req, 'material-update', materialRecord.id, () => {
          const current = material(materialRecord.id, req.user, true),
            file = req.file
          db.prepare(
            'UPDATE materials SET title=?,description=?,file_url=?,file_name=?,file_size=?,file_type=? WHERE id=?',
          ).run(
            textValue(req.body.title ?? current.title, '资料标题', 200),
            textValue(req.body.description ?? current.description, '说明', 20000, false),
            file?.storageKey || current.file_url,
            file ? safeName(file.originalname) : current.file_name,
            file?.size ?? current.file_size,
            file ? path.extname(file.originalname).slice(1).toLowerCase() : current.file_type,
            current.id,
          )
          if (file) queueCleanup([current.file_url], '资料替换')
          return materialView(current.id)
        })
      res.json(data)
    } catch (error) {
      if (req.file) queueCleanup([req.file.path], '失败上传')
      throw error
    }
  },
)
router.get('/courses/:id/material-upload-status/:key', auth, teacherOnly, (req, res) => {
  const course = courseAccess(req.params.id, req.user)
  res.json(operationStatus(req.user.id, 'material-create', course.id, req.params.key))
})
router.get('/materials/:id/upload-status/:key', auth, teacherOnly, (req, res) => {
  const materialRecord = material(req.params.id, req.user)
  res.json(operationStatus(req.user.id, 'material-update', materialRecord.id, req.params.key))
})
router.delete('/materials/:id', auth, teacherOnly, (req, res) => {
  deleteMaterial(idValue(req.params.id), req.user)
  res.json({ message: '资料已删除' })
})
router.get('/materials/:id/downloads', auth, teacherOnly, (req, res) => {
  const materialRecord = material(req.params.id, req.user)
  res.json(
    db
      .prepare(
        'SELECT u.username,u.name,d.download_count,d.first_downloaded_at,d.last_downloaded_at FROM material_downloads d JOIN users u ON u.id=d.student_id WHERE material_id=? ORDER BY d.last_downloaded_at DESC',
      )
      .all(materialRecord.id),
  )
})
router.post('/materials/:id/download-ticket', auth, (req, res) => {
  const materialRecord = material(req.params.id, req.user)
  const ticket = jwt.sign(
    { purpose: 'material-download', materialId: materialRecord.id, userId: req.user.id },
    config.jwtSecret,
    { expiresIn: '5m' },
  )
  res.json({ url: `/api/material-files/${ticket}` })
})
router.get('/material-files/:ticket', (req, res, next) => {
  try {
    const payload = jwt.verify(req.params.ticket, config.jwtSecret)
    if (payload.purpose !== 'material-download') fail(401, '下载凭证无效')
    const user = db
      .prepare('SELECT id,username,name,role,status,must_change_password FROM users WHERE id=?')
      .get(payload.userId)
    if (!user || user.status !== 'active') fail(401, '账号不存在或已停用')
    serveMaterialFile(Number(payload.materialId), user, res, req, next)
  } catch (error) {
    if (error.status) next(error)
    else next(Object.assign(new Error('下载凭证已失效，请重新下载'), { status: 401 }))
  }
})
router.get('/materials/:id/file', auth, (req, res, next) =>
  serveMaterialFile(Number(req.params.id), req.user, res, req, next),
)
// 桌面端断点下载在文件成功落盘后调用，按凭证编号去重只计一次。
router.post('/materials/:id/download-completed', auth, (req, res) => {
  const materialRecord = material(req.params.id, req.user)
  if (req.user.role !== 'student') fail(403, '只登记学生下载')
  const counted = !!recordCompletedResumableDownload(
    materialRecord.id,
    req.user.id,
    String(req.body?.download_id || ''),
  )
  res.json({ message: counted ? '下载已记录' : '该下载已登记过', counted })
})
export default router
