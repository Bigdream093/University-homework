export function errorHandler(err, _req, res, _next) {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  if (status >= 500) console.error(err);
  if(res.headersSent)return res.end();
  res.status(status).json({ message: status>=500 ? '服务器处理失败，请联系管理员检查日志' : err.message || '请求处理失败' });
}

export function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
