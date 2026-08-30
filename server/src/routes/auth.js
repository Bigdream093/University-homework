import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db } from '../db.js';
import { config } from '../config.js';
import { auth } from '../middleware/auth.js';

const router = Router();

router.post('/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!user || user.status !== 'active' || !bcrypt.compareSync(String(req.body.password || ''), user.password_hash)) {
    return res.status(401).json({ message: '账号或密码错误' });
  }
  const profile = { id: user.id, username: user.username, name: user.name, role: user.role, must_change_password: user.must_change_password };
  res.json({ token: jwt.sign({ id: user.id, role: user.role }, config.jwtSecret, { expiresIn: '24h' }), user: profile });
});

router.put('/password', auth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(String(req.body.oldPassword || ''), user.password_hash)) return res.status(400).json({ message: '原密码不正确' });
  const password = String(req.body.newPassword || '');
  if (password.length < 6) return res.status(400).json({ message: '新密码至少6位' });
  db.prepare('UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?').run(bcrypt.hashSync(password, 10), user.id);
  res.json({ message: '密码已修改，请重新登录' });
});

export default router;
