import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const uploadRoot = path.resolve(config.uploadDir);

/** 只解析上传目录内的本地路径，拒绝 URL 和目录穿越。 */
export function resolveUploadPath(storedPath, { mustExist = false } = {}) {
  if (typeof storedPath !== 'string' || !storedPath || storedPath.includes('://')) return null;
  const resolved = path.resolve(storedPath);
  const relative = path.relative(uploadRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return mustExist && !fs.existsSync(resolved) ? null : resolved;
}

export function removeUploadFile(storedPath) {
  const resolved = resolveUploadPath(storedPath);
  if (!resolved) return false;
  try {
    fs.rmSync(resolved, { force: true });
    return true;
  } catch (error) {
    console.warn(`上传文件清理失败：${error.message}`);
    return false;
  }
}
