import { moveContent } from '../services/contentOrder.js'
import { Router } from 'express'
import { db } from '../db.js'
import { auth } from '../middleware/auth.js'
import { teacherOnly } from '../middleware/teacher.js'
import { uploadSingle } from '../middleware/upload.js'
import { courseAccess, fail, idValue } from '../services/access.js'
import { deleteMaterial, saveMaterial } from '../services/materialService.js'
import { executeOperation, operationStatus } from '../services/operations.js'
import { queueCleanup } from '../services/storage.js'
import {
  serveMaterialFile,
  recordCompletedResumableDownload,
} from '../services/materialFileService.js'
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
      .prepare(
        'SELECT m.id,m.title,m.description,m.file_name,m.file_size,m.file_type,m.created_at,COALESCE((SELECT SUM(download_count) FROM material_downloads d WHERE d.material_id=m.id),0) download_count FROM materials m WHERE m.course_id=? ORDER BY m.sort_order,m.id',
      )
      .all(course.id),
  )
})
router.post('/materials/:id/move', auth, teacherOnly, (req, res) => {
  const row = material(idValue(req.params.id), req.user, true)
  const moved = moveContent({
    table: 'materials',
    id: row.id,
    scopeColumn: 'course_id',
    scopeId: row.course_id,
    direction: req.body.direction,
  })
  res.json({ moved })
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
      const data = await executeOperation(req, 'material-create', course.id, () =>
        saveMaterial({
          mode: 'create',
          courseId: course.id,
          user: req.user,
          file: req.file,
          metadata: req.body,
        }),
      )
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
        data = await executeOperation(req, 'material-update', materialRecord.id, () =>
          saveMaterial({
            mode: 'update',
            courseId: materialRecord.course_id,
            materialId: materialRecord.id,
            user: req.user,
            file: req.file,
            metadata: req.body,
          }),
        )
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
router.get('/materials/:id/file', auth, (req, res, next) =>
  serveMaterialFile(idValue(req.params.id), req.user, res, req, next),
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
