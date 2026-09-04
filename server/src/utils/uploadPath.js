import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'

const uploadRoot = path.resolve(config.uploadDir)
const compatWarned = new Set()

const toPosix = (value) => value.split('\\').join('/')

/**
 * 上传根目录内的绝对路径 → POSIX 相对存储键（如 submission/12/uuid.zip）。
 * 不在上传根目录内、URL 或空值返回 null。
 */
export function toStorageKey(storedPath) {
  if (typeof storedPath !== 'string' || !storedPath || storedPath.includes('://')) return null
  const resolved = path.resolve(storedPath)
  const relative = path.relative(uploadRoot, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return toPosix(relative)
}

/**
 * 任意入库路径值 → 规范化的相对存储键，不做磁盘访问。
 * 接受相对键（POSIX 或历史反斜杠写法）与位于上传根内的旧绝对路径；拒绝 URL、越界与绝对键注入。
 */
export function normalizeStorageKey(storedPath) {
  if (typeof storedPath !== 'string' || !storedPath || storedPath.includes('://')) return null
  if (path.isAbsolute(storedPath)) return toStorageKey(storedPath)
  const normalized = path.posix.normalize(toPosix(storedPath).replace(/^\.\//, ''))
  if (
    !normalized ||
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized === '..' ||
    path.posix.isAbsolute(normalized)
  )
    return null
  return normalized
}

/**
 * 库内存储值 → 上传根目录内的绝对路径。
 * 新约定：库内只保存相对存储键；兼容期内允许读取位于当前上传根内的旧绝对路径，命中即告警，
 * 提示尽快执行 scripts/storage-path-migrate.mjs 完成一次性迁移。
 */
export function resolveUploadPath(storedPath, { mustExist = false } = {}) {
  const key = normalizeStorageKey(storedPath)
  if (!key) return null
  if (typeof storedPath === 'string' && path.isAbsolute(storedPath) && !compatWarned.has(key)) {
    compatWarned.add(key)
    console.warn(
      `[storage] 读取到旧绝对路径存储值（自动迁移已覆盖常规升级，此情况通常意味着上传根目录整体变更过）：${storedPath}`,
    )
  }
  const resolved = path.resolve(uploadRoot, ...key.split('/'))
  const relative = path.relative(uploadRoot, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  return mustExist && !fs.existsSync(resolved) ? null : resolved
}

/** 同一存储键在当前平台的绝对路径形态：用于兼容期内匹配库中的旧绝对路径值。 */
export function keyAbsoluteForm(key) {
  const normalized = normalizeStorageKey(key)
  return normalized ? path.resolve(uploadRoot, ...normalized.split('/')) : null
}
