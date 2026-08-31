import path from 'node:path';

const allowedExtensions = new Set([
  'doc','docx','pdf','txt','xlsx','ppt','pptx','jpg','jpeg','png','gif','bmp','webp','tif','tiff',
  'dwg','dxf','skp','psd','ai','cdr','3dm','rvt','mxd','apk','zip','rar','7z','mp4','mov','avi','mkv'
]);

export function fileFilter(_req, file, cb) {
  const ext = path.extname(file.originalname).slice(1).toLowerCase();
  const allowed = Boolean(ext && allowedExtensions.has(ext));
  cb(allowed ? null : Object.assign(new Error(`不支持的文件类型：.${ext || '未知'}`),{status:400}), allowed);
}

export function safeName(name) {
  return path.basename(name).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
}

// 浏览器/测试工具可能按 latin1 编码 multipart 文件名，导致中文乱码；探测并还原为 UTF-8
export function decodeFilename(name) {
  if (!name) return name;
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? name : decoded;
}
