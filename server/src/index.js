import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import './db.js';
import authRoutes from './routes/auth.js';
import courseRoutes from './routes/courses.js';
import assignmentRoutes from './routes/assignments.js';
import submissionRoutes from './routes/submissions.js';
import gradingRoutes from './routes/grading.js';
import exportRoutes from './routes/export.js';
import packageRoutes from './routes/package.js';
import noticeRoutes from './routes/notices.js';
import materialRoutes from './routes/materials.js';
import { errorHandler } from './middleware/error.js';

export const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use('/api', courseRoutes, assignmentRoutes, submissionRoutes, gradingRoutes, exportRoutes, packageRoutes, noticeRoutes, materialRoutes);
app.use('/api', (_req, res) => res.status(404).json({ message: '接口不存在' }));

if (fs.existsSync(config.webDist)) {
  app.use(express.static(config.webDist));
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(config.webDist, 'index.html')));
}
app.use(errorHandler);

if (process.env.NODE_ENV !== 'test') app.listen(config.port, () => console.log(`作业管理App已启动：http://localhost:${config.port}`));
