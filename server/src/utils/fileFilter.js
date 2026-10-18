import path from 'node:path'
import { httpError } from './httpError.js'
import { PREVIEW_EXTENSIONS } from '@university-homework/domain/limits'
import { normalizeExtensions } from '@university-homework/domain/fileExtensions'
import { normalizeSubmissionFileName } from '@university-homework/domain/submissionFilename'
export { PREVIEW_MAX_BYTES, IMAGE_MAX_PIXELS } from '@university-homework/domain/limits'

// 全局提交白名单：作业级后缀名限制只能在这份名单之内进一步收窄。
const allowedExtensions = new Set([
  // 文档
  'doc',
  'docx',
  'pdf',
  'txt',
  'xlsx',
  'ppt',
  'pptx',
  'csv',
  'md',
  'rtf',
  'wps',
  'et',
  'dps',
  'odt',
  'ods',
  'odp',
  // 图片
  'jpg',
  'jpeg',
  'png',
  'gif',
  'bmp',
  'webp',
  'tif',
  'tiff',
  'svg',
  'eps',
  'heic',
  'heif',
  'psb',
  // 音频
  'mp3',
  'wav',
  'm4a',
  'aac',
  'flac',
  'wma',
  // 视频
  'mp4',
  'mov',
  'avi',
  'mkv',
  'webm',
  'wmv',
  'flv',
  'mpg',
  'mpeg',
  'm4v',
  '3gp',
  'ts',
  // CAD / 设计与 3D 工程
  'dwg',
  'dxf',
  'skp',
  'psd',
  'ai',
  'cdr',
  '3dm',
  'rvt',
  'mxd',
  'obj',
  'fbx',
  'stl',
  'step',
  'stp',
  'iges',
  'igs',
  'rfa',
  'blend',
  'c4d',
  'max',
  'prproj',
  'aep',
  'drp',
  'dwf',
  // 压缩包
  'zip',
  'rar',
  '7z',
  'apk',
  // 数据 / 编程
  'ipynb',
  'py',
  'r',
  'sql',
  'json',
  'xml',
  'mat',
  'sav',
  'dta',
])
const materialInstallerExtensions = new Set(['exe', 'msi', 'dmg', 'pkg'])
// 预览图：仅允许真实的 JPEG/PNG；单张 20M；像素上限防异常图片耗尽内存。
// 真实性校验统一由 sharp 解码完成（previewService / middleware/upload），此处不再做文件头嗅探。
export const previewExtensions = new Set(PREVIEW_EXTENSIONS)

export { allowedExtensions }

export function fileExtension(name) {
  return path
    .extname(name || '')
    .slice(1)
    .toLowerCase()
}

export function allowedUploadName(name, { material = false, extensions = null } = {}) {
  const ext = fileExtension(name)
  return Boolean(
    ext &&
    (material
      ? allowedExtensions.has(ext) || materialInstallerExtensions.has(ext)
      : allowedExtensions.has(ext) && (!extensions || extensions.includes(ext))),
  )
}

export function fileFilter(req, file, cb) {
  const ext = fileExtension(file.originalname)
  const isMaterialInstaller = req.uploadLabel === '课程资料' && materialInstallerExtensions.has(ext)
  if (file.fieldname === 'previews') {
    const allowed = Boolean(ext && previewExtensions.has(ext))
    return cb(allowed ? null : httpError(400, '预览图必须是 .jpg/.jpeg/.png 文件'), allowed)
  }
  const withinAssignment = !req.allowedExtensions || req.allowedExtensions.includes(ext)
  if (ext && allowedExtensions.has(ext) && !withinAssignment) {
    return cb(
      httpError(
        400,
        `本作业只接受后缀名：${req.allowedExtensions
          .map((extension) => '.' + extension)
          .join('、')}`,
      ),
      false,
    )
  }
  const allowed = Boolean(ext && (allowedExtensions.has(ext) || isMaterialInstaller))
  cb(allowed ? null : httpError(400, `不支持的文件类型：.${ext || '未知'}`), allowed)
}

// 作业级后缀名输入 → 规范化存储值；返回 string[] 或 null（不限制）。
// 严格校验：逗号/分号/空白分隔，去点转小写去重，纯字母数字 1-12 位，最多 20 个，且必须在全局白名单内。
export function parseAllowedExtensions(input, globalAllowed = true) {
  if (input === undefined || input === null || String(input).trim() === '') return null
  const { list, error } = normalizeExtensions(input)
  if (error) failExtensions(error)
  if (!list.length) failExtensions(input)
  for (const ext of list) {
    if (globalAllowed && !allowedExtensions.has(ext))
      failExtensions(ext, `.${ext} 不在系统支持的文件类型范围内`)
  }
  return list
}
function failExtensions(token, reason) {
  throw httpError(400, reason || `文件后缀名格式无效：${token}`)
}

export function safeName(name) {
  return path.basename(name).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
}

// 旧版本曾把“准时/迟交”写进文件名；下载与打包展示时统一清除该遗留后缀。
export function cleanLegacyTimelinessSuffix(value) {
  return safeName(normalizeSubmissionFileName(value || '作业文件'))
}

// 浏览器/测试工具可能按 latin1 编码 multipart 文件名，导致中文乱码；探测并还原为 UTF-8
export function decodeFilename(name) {
  if (!name) return name
  const decoded = Buffer.from(name, 'latin1').toString('utf8')
  return decoded.includes('\uFFFD') ? name : decoded
}
