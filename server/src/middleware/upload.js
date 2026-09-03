import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import multer from 'multer'
import { config } from '../config.js'
import {
  fileFilter,
  decodeFilename,
  IMAGE_MAX_PIXELS,
  PREVIEW_MAX_BYTES,
} from '../utils/fileFilter.js'
import { queueCleanup } from '../services/storage.js'
import { toStorageKey } from '../utils/uploadPath.js'

const require = createRequire(import.meta.url)
let sharp
try {
  sharp = require('sharp')
} catch {
  throw new Error('预览图校验与缩略图依赖 sharp，请先在 server 目录执行 npm install')
}

// 上传目录边界：resolve 后必须仍位于上传根目录内，拒绝任何越界路径。
function withinUploadDir(...segments) {
  const root = path.resolve(config.uploadDir)
  const target = path.resolve(root, ...segments)
  if (target !== root && !target.startsWith(root + path.sep))
    throw Object.assign(new Error('非法文件路径'), { status: 400 })
  return target
}
// 落盘文件名只允许 UUID+点字母数字扩展名，杜绝路径片段。
function safeStoredName(originalname) {
  const rawExt = path.extname(originalname).toLowerCase()
  const ext = /^[.][a-z0-9]{1,12}$/.test(rawExt) ? rawExt : ''
  return randomUUID() + ext
}

// 作业提交专用：源文件 file（1 个，受作业大小上限约束）+ 预览图 previews（最多 10 张，单张 20M，
// 必须是真实 JPEG/PNG 且像素不超上限）。魔数与尺寸校验在流式落盘后立即执行。
export function uploadSubmissionFiles(req, res, next) {
  const directory = withinUploadDir('.staging')
  fs.mkdirSync(directory, { recursive: true })
  const createdPaths = new Set(),
    okFiles = []
  const previewDir = withinUploadDir('previews')
  fs.mkdirSync(previewDir, { recursive: true })
  const storage = {
    _handleFile(_req, file, cb) {
      file.originalname = decodeFilename(file.originalname)
      const isPreview = file.fieldname === 'previews'
      const stagedPath = withinUploadDir('.staging', safeStoredName(file.originalname))
      createdPaths.add(stagedPath)
      const hash = createHash('sha256')
      let bytes = 0
      const output = fs.createWriteStream(stagedPath)
      const counting = new Transform({
        transform(chunk, _encoding, done) {
          bytes += chunk.length
          hash.update(chunk)
          if (isPreview && bytes > PREVIEW_MAX_BYTES)
            return done(Object.assign(new Error('预览图单张不能超过 20M'), { status: 400 }))
          done(null, chunk)
        },
      })
      pipeline(file.stream, counting, output)
        .then(async () => {
          const record = {
            fieldname: file.fieldname,
            originalname: file.originalname,
            destination: directory,
            filename: path.basename(stagedPath),
            path: stagedPath,
            storageKey: toStorageKey(stagedPath),
            size: output.bytesWritten,
            sha256: hash.digest('hex'),
            mimetype: file.mimetype,
          }
          if (isPreview) {
            // 预览图必须经 sharp 完整解码：真实格式、尺寸与像素上限都在此把关，仅看文件头会漏判大 EXIF 伪造/误判真实照片。
            let meta = null
            try {
              meta = await sharp(stagedPath, { limitInputPixels: IMAGE_MAX_PIXELS }).metadata()
            } catch (error) {
              return cb(
                Object.assign(
                  new Error(
                    /pixel/i.test(String(error.message))
                      ? '预览图像素过大，请压缩后再上传'
                      : '预览图必须是真实的 JPG/PNG 文件',
                  ),
                  { status: 400 },
                ),
              )
            }
            if (!['jpeg', 'png'].includes(meta.format))
              return cb(
                Object.assign(new Error('预览图必须是真实的 JPG/PNG 文件'), { status: 400 }),
              )
            if (
              !Number.isSafeInteger(meta.width) ||
              !Number.isSafeInteger(meta.height) ||
              meta.width * meta.height > IMAGE_MAX_PIXELS
            )
              return cb(Object.assign(new Error('预览图像素过大，请压缩后再上传'), { status: 400 }))
            record.image = {
              mime: meta.format === 'jpeg' ? 'image/jpeg' : 'image/png',
              width: meta.width,
              height: meta.height,
            }
            try {
              const thumbnailPath = withinUploadDir('previews', safeStoredName('t.jpg'))
              await sharp(stagedPath)
                .rotate()
                .resize({ width: 480, withoutEnlargement: true })
                .jpeg({ quality: 80 })
                .toFile(thumbnailPath)
              createdPaths.add(thumbnailPath)
              record.thumbnailPath = thumbnailPath
              record.thumbnailKey = toStorageKey(thumbnailPath)
            } catch {
              /* 缩略图失败不阻断提交，教师端回退加载原图 */
            }
          }
          okFiles.push(record)
          cb(null, record)
        })
        .catch(cb)
    },
    _removeFile(_req, file, cb) {
      const target = file.path
      delete file.destination
      delete file.filename
      delete file.path
      if (!target) return cb(null)
      fs.unlink(target, (error) => cb(error?.code === 'ENOENT' ? null : error))
    },
  }
  const cleanupAll = () => {
    if (createdPaths.size) queueCleanup([...createdPaths], '上传中断清理')
  }
  req.once('aborted', cleanupAll)
  const limit = req.uploadLimit ?? config.uploadMaxMb * 1024 * 1024
  multer({
    storage,
    fileFilter,
    limits: { fileSize: limit + 1, fields: 12, fieldSize: 2 * 1024 * 1024, files: 11 },
  }).fields([
    { name: 'file', maxCount: 1 },
    { name: 'previews', maxCount: 10 },
  ])(req, res, (error) => {
    if (error) {
      for (const file of okFiles) {
        createdPaths.delete(file.path)
        if (file.thumbnailPath) createdPaths.delete(file.thumbnailPath)
      }
      if (createdPaths.size) queueCleanup([...createdPaths], '上传未完成')
    }
    if (error?.code === 'LIMIT_FILE_SIZE') {
      error.status = 400
      error.message = '文件限制单文件不超过 ' + limit / 1024 / 1024 + 'M'
    }
    req.stagedSource = okFiles.find((file) => file.fieldname === 'file') || null
    req.stagedPreviews = okFiles.filter((file) => file.fieldname === 'previews')
    // 兼容 operations.js 的单文件语义（指纹、转正、失败清理）。
    req.file = req.stagedSource || undefined
    next(error)
  })
}

export function uploadSingle(req, res, next) {
  const directory = path.join(config.uploadDir, '.staging')
  fs.mkdirSync(directory, { recursive: true })
  let stagedPath
  const storage = {
    _handleFile(_req, file, cb) {
      file.originalname = decodeFilename(file.originalname)
      const filename = randomUUID() + path.extname(file.originalname).toLowerCase()
      stagedPath = path.join(directory, filename)
      const hash = createHash('sha256'),
        output = fs.createWriteStream(stagedPath)
      const hashing = new Transform({
        transform(chunk, _encoding, done) {
          hash.update(chunk)
          done(null, chunk)
        },
      })
      pipeline(file.stream, hashing, output)
        .then(() =>
          cb(null, {
            destination: directory,
            filename: path.basename(stagedPath),
            path: stagedPath,
            storageKey: toStorageKey(stagedPath),
            size: output.bytesWritten,
            sha256: hash.digest('hex'),
          }),
        )
        .catch(cb)
    },
    _removeFile(_req, file, cb) {
      const target = file.path
      delete file.destination
      delete file.filename
      delete file.path
      if (!target) return cb(null)
      fs.unlink(target, (error) => cb(error?.code === 'ENOENT' ? null : error))
    },
  }
  req.once('aborted', () => {
    if (stagedPath) queueCleanup([stagedPath], '上传连接中断')
  })
  const limit = req.uploadLimit ?? config.uploadMaxMb * 1024 * 1024
  multer({
    storage,
    fileFilter,
    limits: { fileSize: limit + 1, fields: 12, fieldSize: 2 * 1024 * 1024, files: 1 },
  }).single('file')(req, res, (error) => {
    if (error && stagedPath) queueCleanup([stagedPath], '上传未完成')
    if (error?.code === 'LIMIT_FILE_SIZE') {
      error.status = 400
      error.message = (req.uploadLabel || '文件') + '限制单文件不超过 ' + limit / 1024 / 1024 + 'M'
    }
    next(error)
  })
}
