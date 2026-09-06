import { Router } from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import multer from 'multer'
import sharp from 'sharp'
import { db } from '../db.js'
import { config } from '../config.js'
import { auth } from '../middleware/auth.js'
import { courseAccess, fail } from '../services/access.js'
import { canReadEditorImage } from '../services/editorImageAccess.js'
import { resolveUploadPath } from '../utils/uploadPath.js'

const router = Router()
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0 },
})

router.post(
  '/courses/:id/editor-images',
  auth,
  (req, _res, next) => {
    courseAccess(req.params.id, req.user, { write: true })
    next()
  },
  upload.single('file'),
  async (req, res) => {
    if (!req.file) fail(400, '请选择图片')
    let buffer
    try {
      const source = sharp(req.file.buffer, { limitInputPixels: 40_000_000 })
      const metadata = await source.metadata()
      if (!['jpeg', 'png', 'webp'].includes(metadata.format))
        fail(400, '仅支持 JPG、PNG、WebP 图片')
      buffer = await source.rotate().webp({ quality: 90 }).toBuffer()
    } catch (error) {
      if (error.status) throw error
      fail(400, '图片无效或像素过大，请换一张图片')
    }
    const id = randomUUID()
    const key = `editor-images/${id}.webp`
    const file = path.join(config.uploadDir, key)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, buffer, { flag: 'wx' })
    try {
      db.prepare(
        'INSERT INTO editor_images(id,course_id,uploader_id,file_url) VALUES(?,?,?,?)',
      ).run(id, Number(req.params.id), req.user.id, key)
    } catch (error) {
      await fs.unlink(file).catch(() => {})
      throw error
    }
    res.status(201).json({ id, url: `/api/editor-images/${id}` })
  },
)

// Access follows visible Markdown references, including copied courses. Draft images are teacher-only.
router.get('/editor-images/:id', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM editor_images WHERE id=?').get(req.params.id)
  if (!row) fail(404, '图片不存在')
  if (!canReadEditorImage(row, req.user)) fail(404, '图片不存在或无权访问')
  const file = resolveUploadPath(row.file_url, { mustExist: true })
  if (!file) fail(404, '图片文件不存在')
  res.set('Cache-Control', 'private, no-store').type('webp').sendFile(file)
})

export default router
