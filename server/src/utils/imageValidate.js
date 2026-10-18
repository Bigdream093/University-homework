import fs from 'node:fs/promises'
import sharp from 'sharp'
import { IMAGE_MAX_PIXELS } from './fileFilter.js'
import { httpError } from './httpError.js'

sharp.concurrency(2)

// Read metadata with sharp rather than a fixed-size header (large EXIF is valid).
export async function validatePreviewImage(sourcePath) {
  let meta
  try {
    meta = await sharp(sourcePath, {
      limitInputPixels: IMAGE_MAX_PIXELS,
    }).metadata()
  } catch (error) {
    throw httpError(
      400,
      /pixel/i.test(String(error.message))
        ? '预览图像素过大，请压缩后再上传'
        : '预览图必须是真实的 JPG/PNG 文件',
    )
  }
  if (!['jpeg', 'png'].includes(meta.format))
    throw httpError(400, '预览图必须是真实的 JPG/PNG 文件')
  if (
    !Number.isSafeInteger(meta.width) ||
    !Number.isSafeInteger(meta.height) ||
    meta.width * meta.height > IMAGE_MAX_PIXELS
  )
    throw httpError(400, '预览图像素过大，请压缩后再上传')
  return {
    mime: meta.format === 'jpeg' ? 'image/jpeg' : 'image/png',
    width: meta.width,
    height: meta.height,
  }
}

// Thumbnail failure keeps the original usable, and must not leave a partial file.
// Callers own destination naming, storage keys and lifecycle registration.
export async function buildThumbnail(sourcePath, destinationPath) {
  try {
    await sharp(sourcePath, { limitInputPixels: IMAGE_MAX_PIXELS })
      .rotate()
      .resize({ width: 480, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toFile(destinationPath)
    return destinationPath
  } catch {
    await fs.rm(destinationPath, { force: true }).catch(() => {})
    return null
  }
}
