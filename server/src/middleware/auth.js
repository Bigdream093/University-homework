import jwt from 'jsonwebtoken'
import { config } from '../config.js'
import { db } from '../db.js'

export function auth(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!token) return res.status(401).json({ message: '请先登录' })
  try {
    const payload = jwt.verify(token, config.jwtSecret)
    const user = db
      .prepare(
        'SELECT id,username,name,role,status,must_change_password,auth_version FROM users WHERE id=?',
      )
      .get(payload.id)
    if (!user || user.status !== 'active')
      return res.status(401).json({ message: '账号不存在或已停用' })
    if (Number(payload.auth_version || 0) !== Number(user.auth_version || 0))
      return res.status(401).json({ message: '登录状态已失效，请重新登录' })
    req.user = user
    next()
  } catch {
    res.status(401).json({ message: '登录状态已失效' })
  }
}
