import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { config } from '../config.js'
import { IMAGE_MAX_PIXELS } from '../utils/fileFilter.js'
import { toStorageKey } from '../utils/uploadPath.js'

sharp.concurrency(2)

// 预览图必须经 sharp 完整解码校验真实格式与尺寸，不能只看文件头：
// 仅读 64KB 头会把带超大 EXIF 段的真实手机照片误判为伪造文件。
export async function preparePreview(file) {
  let meta
  try {
    meta = await sharp(file.path, { limitInputPixels: IMAGE_MAX_PIXELS }).metadata()
  } catch (error) {
    if (/pixel/i.test(String(error.message)))
      throw Object.assign(new Error('预览图像素过大，请压缩后再上传'), { status: 400 })
    throw Object.assign(new Error('预览图必须是真实的 JPG/PNG 文件'), { status: 400 })
  }
  if (!['jpeg', 'png'].includes(meta.format))
    throw Object.assign(new Error('预览图必须是真实的 JPG/PNG 文件'), { status: 400 })
  if (
    !Number.isSafeInteger(meta.width) ||
    !Number.isSafeInteger(meta.height) ||
    meta.width * meta.height > IMAGE_MAX_PIXELS
  )
    throw Object.assign(new Error('预览图像素过大，请压缩后再上传'), { status: 400 })
  const image = {
    mime: meta.format === 'jpeg' ? 'image/jpeg' : 'image/png',
    width: meta.width,
    height: meta.height,
  }
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file.path)) hash.update(chunk)
  const directory = path.join(config.uploadDir, 'previews')
  await fs.promises.mkdir(directory, { recursive: true })
  const thumbnailPath = path.join(directory, `${randomUUID()}.jpg`)
  try {
    await sharp(file.path)
      .rotate()
      .resize({ width: 480, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toFile(thumbnailPath)
  } catch {
    await fs.promises.rm(thumbnailPath, { force: true }).catch(() => {})
    return { ...file, image, sha256: hash.digest('hex') }
  }
  return {
    ...file,
    image,
    sha256: hash.digest('hex'),
    thumbnailPath,
    thumbnailKey: toStorageKey(thumbnailPath),
  }
}
