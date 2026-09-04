export function errorHandler(err, _req, res, _next) {
  const multerMessages = {
    LIMIT_PART_COUNT: '上传内容部分过多',
    LIMIT_FILE_SIZE: '上传文件超过大小限制',
    LIMIT_FILE_COUNT: '上传文件数量过多',
    LIMIT_FIELD_KEY: '上传字段名称过长',
    LIMIT_FIELD_VALUE: '上传字段内容过长',
    LIMIT_FIELD_COUNT: '上传字段数量过多',
    LIMIT_UNEXPECTED_FILE: '上传文件字段无效',
  }
  const multerError = typeof err.code === 'string' && err.code.startsWith('LIMIT_')
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : multerError ? 400 : 500)
  if (multerError && !err.status && multerMessages[err.code]) err.message = multerMessages[err.code]
  // 507（磁盘空间不足）已向上游返回可读信息，不再重复记录为服务器错误。
  if (status >= 500 && status !== 507) console.error(err)
  if (res.headersSent) return res.end()
  res
    .status(status)
    .json({
      message:
        status >= 500 && !err.expose
          ? '服务器处理失败，请联系管理员检查日志'
          : err.message || '请求处理失败',
    })
}

export function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
}
