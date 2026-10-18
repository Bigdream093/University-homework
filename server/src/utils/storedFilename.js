import path from 'node:path'
import { randomUUID } from 'node:crypto'

// Keep physical upload names independent from user supplied path fragments.
export function storedFilename(originalname, prefix = randomUUID()) {
  if (!/^[a-zA-Z0-9_-]+$/.test(prefix)) throw new TypeError('非法文件名标识')
  const extension = path.extname(String(originalname || '')).toLowerCase()
  return prefix + (/^[.][a-z0-9]{1,12}$/.test(extension) ? extension : '')
}
