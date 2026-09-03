import { db } from '../db.js'
import { resolveUploadPath } from '../utils/uploadPath.js'
import { nowText } from '../utils/time.js'
import { courseAccess, fail } from './access.js'
export function serveMaterialFile(id, user, res, req = res.req, next = () => {}) {
  const material = db.prepare('SELECT * FROM materials WHERE id=?').get(id)
  if (!material) fail(404, '资料不存在')
  courseAccess(material.course_id, user)
  const file = resolveUploadPath(material.file_url, { mustExist: true })
  if (!file) fail(404, '资料文件不存在')
  // 桌面端断点下载携带 X-Download-Request-Id：统计改由 download-completed 接口登记，这里不再计数。
  const requestId = req?.get?.('X-Download-Request-Id')
  res.download(file, material.file_name, (error) => {
    if (error) {
      if (!res.headersSent) next(error)
      return
    }
    if (
      requestId ||
      user.role !== 'student' ||
      req?.method === 'HEAD' ||
      res.statusCode !== 200 ||
      res.getHeader('content-range')
    )
      return
    // A course/material may be deleted while the response is streaming.
    if (!db.prepare('SELECT 1 FROM materials WHERE id=?').get(material.id)) return
    recordMaterialDownload(material.id, user.id)
  })
}
export function recordMaterialDownload(materialId, studentId) {
  const at = nowText()
  try {
    db.prepare(
      'INSERT INTO material_downloads(material_id,student_id,download_count,first_downloaded_at,last_downloaded_at) VALUES(?,?,1,?,?) ON CONFLICT(material_id,student_id) DO UPDATE SET download_count=download_count+1,last_downloaded_at=excluded.last_downloaded_at',
    ).run(materialId, studentId, at, at)
  } catch (error) {
    console.error('下载统计写入失败', error.message)
  }
}
// 桌面端断点下载完成后登记：按凭证编号唯一去重，只计一次完整下载。
export function recordCompletedResumableDownload(materialId, studentId, downloadId) {
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(downloadId)) fail(400, '下载请求编号无效')
  const inserted = db
    .prepare(
      'INSERT OR IGNORE INTO material_download_events(request_id,material_id,student_id,created_at) VALUES(?,?,?,?)',
    )
    .run(downloadId, materialId, studentId, nowText()).changes
  if (inserted) recordMaterialDownload(materialId, studentId)
  return inserted
}
