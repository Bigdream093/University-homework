import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import cors from 'cors'
import { config } from './config.js'
import './db.js'
import authRoutes from './routes/auth.js'
import courseRoutes from './routes/courses.js'
import assignmentRoutes from './routes/assignments.js'
import submissionRoutes from './routes/submissions.js'
import gradingRoutes from './routes/grading.js'
import exportRoutes from './routes/export.js'
import summaryRoutes from './routes/summary.js'
import packageRoutes from './routes/package.js'
import noticeRoutes from './routes/notices.js'
import materialRoutes from './routes/materials.js'
import questionRoutes from './routes/questions.js'
import groupRoutes from './routes/groups.js'
import helpRoutes from './routes/help.js'
import courseCopyRoutes from './routes/courseCopy.js'
import extensionRoutes from './routes/extensions.js'
import previewImageRoutes from './routes/previewImages.js'
import downloadRoutes from './routes/downloads.js'
import uploadSessionRoutes from './routes/uploadSessions.js'
import { recoverOperations } from './services/operations.js'
import {
  migrateStorageKeys,
  processCleanupBatch,
  quarantineOrphans,
  purgeExpiredQuarantine,
  pruneOperationalRecords,
} from './services/storage.js'
import { publishDueNotices } from './services/noticeService.js'
import { acquireInstanceLease } from './services/instanceLease.js'
import { purgeUploadSessions, recoverUploadSessions } from './services/uploadSessionService.js'
import { errorHandler } from './middleware/error.js'

import { cspHeaders, reportCspViolation } from './middleware/csp.js'

export const app = express()
app.disable('x-powered-by')
if (config.trustProxyHops > 0) app.set('trust proxy', config.trustProxyHops)
app.use(cspHeaders())
app.use(cors())
app.post('/api/security/csp-report', express.json({ type: 'application/csp-report', limit: '8kb' }), reportCspViolation)
app.use(express.json({ limit: '2mb' }))
const tzOk = process.env.TZ === 'Asia/Shanghai'
if (!tzOk && process.env.NODE_ENV !== 'test') console.warn('建议设置 TZ=Asia/Shanghai')
app.get('/api/health', (_req, res) =>
  res.json({ ok: true, version: '1.6.5', timezone: 'Asia/Shanghai', tz_configured: tzOk }),
)
app.use('/api/auth', authRoutes)
app.use(
  '/api',
  courseRoutes,
  assignmentRoutes,
  submissionRoutes,
  gradingRoutes,
  exportRoutes,
  summaryRoutes,
  packageRoutes,
  noticeRoutes,
  materialRoutes,
  questionRoutes,
  groupRoutes,
  helpRoutes,
  extensionRoutes,
  courseCopyRoutes,
  previewImageRoutes,
  downloadRoutes,
  uploadSessionRoutes,
)
app.use('/api', (_req, res) => res.status(404).json({ message: '接口不存在' }))

if (fs.existsSync(config.webDist)) {
  app.use(express.static(config.webDist))
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(config.webDist, 'index.html')))
}
app.use(errorHandler)

export function configureHttpServer(server) {
  server.requestTimeout = config.uploadRequestTimeoutMs
  return server
}

if (process.env.NODE_ENV !== 'test') {
  const instanceLease = acquireInstanceLease(config.dataDir)
  process.once('exit', instanceLease.release)
  recoverOperations()
  recoverUploadSessions()
  migrateStorageKeys()
  processCleanupBatch()
  purgeExpiredQuarantine()
  pruneOperationalRecords()
  quarantineOrphans()
  // 附件清理按批处理执行：请求链路只入队，物理删除由本定时器完成。
  setInterval(() => {
    try {
      publishDueNotices()
      purgeUploadSessions()
      processCleanupBatch()
    } catch (error) {
      console.error('后台维护失败', error.message)
    }
  }, 30_000).unref()
  // 孤儿文件全盘扫描开销较大，每小时执行一次；发现的问题文件先进隔离区，保留 30 天。
  setInterval(() => {
    try {
      purgeExpiredQuarantine()
      quarantineOrphans()
      pruneOperationalRecords()
    } catch (error) {
      console.error('存储隔离维护失败', error.message)
    }
  }, 3_600_000).unref()
  publishDueNotices()
  const server = configureHttpServer(
    app.listen(config.port, () =>
      console.log(`作业管理App已启动：http://localhost:${config.port}`),
    ),
  )
  const shutdown = () =>
    server.close(() => {
      instanceLease.release()
      process.exit(0)
    })
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  server.once('error', instanceLease.release)
}
