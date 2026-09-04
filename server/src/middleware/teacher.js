export function teacherOnly(req, res, next) {
  if (req.user?.role !== 'teacher') return res.status(403).json({ message: '仅教师可执行此操作' })
  next()
}

export function studentOnly(req, res, next) {
  if (req.user?.role !== 'student') return res.status(403).json({ message: '仅学生可执行此操作' })
  next()
}
