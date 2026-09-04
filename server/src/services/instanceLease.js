import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const DEFAULT_STALE_MS = 90_000

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function readOwner(lockFile) {
  try {
    return JSON.parse(fs.readFileSync(lockFile, 'utf8'))
  } catch {
    return null
  }
}

export function acquireInstanceLease(
  dataDir,
  { staleMs = DEFAULT_STALE_MS, heartbeatMs = 30_000 } = {},
) {
  fs.mkdirSync(dataDir, { recursive: true })
  const lockFile = path.join(dataDir, '.homework-instance.lock'),
    hostname = os.hostname(),
    token = randomUUID()
  const owner = { token, pid: process.pid, hostname, started_at: new Date().toISOString() }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.writeFileSync(lockFile, JSON.stringify(owner), { encoding: 'utf8', flag: 'wx' })
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const existing = readOwner(lockFile)
      let modifiedAt = NaN
      try {
        modifiedAt = fs.statSync(lockFile).mtimeMs
      } catch {}
      const sameHostAlive = existing?.hostname === hostname && processIsAlive(Number(existing?.pid))
      const recentlyAlive = Number.isFinite(modifiedAt) && Date.now() - modifiedAt < staleMs
      if (sameHostAlive || recentlyAlive) {
        const detail = existing?.hostname
          ? `（${existing.hostname}，进程 ${existing.pid || '未知'}）`
          : ''
        throw new Error(
          `检测到另一个作业管理服务实例仍在运行${detail}，为保护上传数据，本实例拒绝启动`,
        )
      }
      try {
        fs.unlinkSync(lockFile)
      } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT') throw unlinkError
      }
      if (attempt === 2) throw new Error('无法取得作业管理服务单实例锁')
    }
  }
  let released = false
  const heartbeat = () => {
    if (released) return
    const current = readOwner(lockFile)
    if (current?.token !== token) return
    const at = new Date()
    fs.utimesSync(lockFile, at, at)
  }
  const timer = setInterval(() => {
    try {
      heartbeat()
    } catch (error) {
      console.error('单实例锁续期失败', error.message)
    }
  }, heartbeatMs)
  timer.unref()
  const release = () => {
    if (released) return
    released = true
    clearInterval(timer)
    if (readOwner(lockFile)?.token === token) {
      try {
        fs.unlinkSync(lockFile)
      } catch (error) {
        if (error.code !== 'ENOENT') console.error('单实例锁释放失败', error.message)
      }
    }
  }
  return { lockFile, release }
}
