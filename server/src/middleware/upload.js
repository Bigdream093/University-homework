import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import multer from 'multer'
import { config } from '../config.js'
import { fileFilter, decodeFilename, PREVIEW_MAX_BYTES } from '../utils/fileFilter.js'
import { queueCleanup } from '../services/storage.js'
import { toStorageKey } from '../utils/uploadPath.js'
import { storedFilename } from '../utils/storedFilename.js'
import { validatePreviewImage, buildThumbnail } from '../utils/imageValidate.js'
import { httpError } from '../utils/httpError.js'

// 上传目录边界：resolve 后必须仍位于上传根目录内，拒绝任何越界路径。
function withinUploadDir(...segments) {
  const root = path.resolve(config.uploadDir)
  const target = path.resolve(root, ...segments)
  if (target !== root && !target.startsWith(root + path.sep)) throw httpError(400, '非法文件路径')
  return target
}
function removeStoredFile(_req, file, cb) {
  const target = file.path
  delete file.destination
  delete file.filename
  delete file.path
  if (!target) return cb(null)
  fs.unlink(target, (error) => cb(error?.code === 'ENOENT' ? null : error))
}

// 作业提交专用：源文件 file（1 个，受作业大小上限约束）+ 预览图 previews（最多 10 张，单张 20M，
// 必须是真实 JPEG/PNG 且像素不超上限）。魔数与尺寸校验在流式落盘后立即执行。
export function uploadSubmissionFiles(req, res, next) {
  const limit = req.uploadLimit ?? config.uploadMaxMb * 1024 * 1024
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
      const stagedPath = withinUploadDir('.staging', storedFilename(file.originalname))
      createdPaths.add(stagedPath)
      const hash = createHash('sha256')
      let bytes = 0
      const output = fs.createWriteStream(stagedPath)
      const counting = new Transform({
        transform(chunk, _encoding, done) {
          bytes += chunk.length
          hash.update(chunk)
          if (bytes > (isPreview ? PREVIEW_MAX_BYTES : limit))
            return done(
              httpError(
                400,
                isPreview
                  ? '预览图单张不能超过 20M'
                  : '文件限制单文件不超过 ' + limit / 1024 / 1024 + 'M',
              ),
            )
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
            record.image = await validatePreviewImage(stagedPath)
            const thumbnailPath = withinUploadDir('previews', storedFilename('t.jpg'))
            if (await buildThumbnail(stagedPath, thumbnailPath)) {
              createdPaths.add(thumbnailPath)
              record.thumbnailPath = thumbnailPath
              record.thumbnailKey = toStorageKey(thumbnailPath)
            }
          }
          okFiles.push(record)
          cb(null, record)
        })
        .catch(async (error) => {
          // pipeline 已关闭流；失败文件不能等待后台清理后才消失。
          try {
            await fs.promises.rm(stagedPath, { force: true })
            createdPaths.delete(stagedPath)
          } catch {
            // 保留在 createdPaths 中，由请求结束时登记后台重试。
          }
          cb(error)
        })
    },
    _removeFile: removeStoredFile,
  }
  const cleanupAll = () => {
    if (createdPaths.size) queueCleanup([...createdPaths], '上传中断清理')
  }
  req.once('aborted', cleanupAll)
  multer({
    storage,
    fileFilter,
    limits: {
      fileSize: Math.max(limit, PREVIEW_MAX_BYTES) + 1,
      fields: 12,
      fieldSize: 2 * 1024 * 1024,
      files: 11,
    },
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
      const filename = storedFilename(file.originalname)
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
    _removeFile: removeStoredFile,
  }
  req.once('aborted', () => {
    if (stagedPath) queueCleanup([stagedPath], '上传连接中断')
  })
  const limit = req.uploadLimit ?? config.uploadMaxMb * 1024 * 1024
  multer({
    storage,
    fileFilter,
    limits: {
      fileSize: limit + 1,
      fields: 12,
      fieldSize: 2 * 1024 * 1024,
      files: 1,
    },
  }).single('file')(req, res, (error) => {
    if (error && stagedPath) queueCleanup([stagedPath], '上传未完成')
    if (error?.code === 'LIMIT_FILE_SIZE') {
      error.status = 400
      error.message = (req.uploadLabel || '文件') + '限制单文件不超过 ' + limit / 1024 / 1024 + 'M'
    }
    next(error)
  })
}
