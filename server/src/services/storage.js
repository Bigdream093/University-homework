import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { db } from '../db.js'
import { config } from '../config.js'
import { nowText } from '../utils/time.js'
import {
  keyAbsoluteForm,
  normalizeStorageKey,
  resolveUploadPath,
  toStorageKey,
} from '../utils/uploadPath.js'

// 引用保护规则：任何"存活引用"的单一真源。
// 全盘孤儿扫描（referencedFiles）与按任务精确检查（isFileReferenced）都由这份表生成，防止两套规则漂移。
// 兼容期内库中旧值是绝对路径、新值是相对键，因此精确检查同时匹配两种形态。
const REFERENCE_RULES = [
  { table: 'editor_images', column: 'file_url' },
  { table: 'materials', column: 'file_url' },
  { table: 'submissions', column: 'file_url' },
  { table: 'group_submissions', column: 'file_url' },
  { table: 'submission_history', column: 'file_url', where: "file_state='available'" },
  { table: 'group_submission_history', column: 'file_url', where: "file_state='available'" },
  { table: 'submission_preview_images', column: 'file_url', where: "file_state='available'" },
  { table: 'submission_preview_images', column: 'thumbnail_url', where: "file_state='available'" },
  { table: 'operation_requests', column: 'file_path', where: "state='processing'" },
]
const ACTIVE_UPLOAD_SESSION_RULE =
  "SELECT 1 FROM upload_session_files f JOIN upload_sessions s ON s.id=f.session_id WHERE (f.temporary_path=? OR f.temporary_path=?) AND s.state IN ('uploading','completing') AND s.expires_at>datetime('now','+08:00') LIMIT 1"

function ruleSql(rule, { limit = '' } = {}) {
  return `SELECT 1 FROM ${rule.table} WHERE ${rule.column}=?${rule.where ? ` AND ${rule.where}` : ''}${limit}`
}

export function queueCleanup(paths, reason = '文件已替换') {
  const insert = db.prepare(
    "INSERT INTO file_cleanup_jobs(path,reason,created_at) VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET reason=excluded.reason,state='pending',completed_at=NULL,last_error=NULL",
  )
  for (const file of new Set(paths.filter(Boolean))) {
    const key = normalizeStorageKey(file)
    if (key && resolveUploadPath(key)) insert.run(key, reason, nowText())
  }
}

/** 单条路径的精确引用检查：只做有索引的点查，供后台清理批处理使用。 */
export function isFileReferenced(storedPath) {
  const key = normalizeStorageKey(storedPath)
  if (!key) return false
  const absolute = keyAbsoluteForm(key)
  for (const rule of REFERENCE_RULES) {
    if (db.prepare(ruleSql(rule, { limit: ' LIMIT 1' })).get(key)) return true
    if (db.prepare(ruleSql(rule, { limit: ' LIMIT 1' })).get(absolute)) return true
  }
  // 进行中的分片上传会话仍持有临时文件。
  if (db.prepare(ACTIVE_UPLOAD_SESSION_RULE).get(key, absolute)) return true
  return false
}

/** 全量引用集合（存储键域）：供每小时孤儿隔离扫描比较，语义与 isFileReferenced 完全一致。 */
export function referencedFiles() {
  const refs = new Set()
  const add = (value) => {
    const key = normalizeStorageKey(value)
    if (key && resolveUploadPath(key)) refs.add(key)
  }
  for (const rule of REFERENCE_RULES) {
    const where = rule.where
      ? ` WHERE ${rule.where} AND ${rule.column} IS NOT NULL`
      : ` WHERE ${rule.column} IS NOT NULL`
    for (const row of db.prepare(`SELECT ${rule.column} value FROM ${rule.table}${where}`).all())
      add(row.value)
  }
  for (const row of db
    .prepare(
      "SELECT f.temporary_path value FROM upload_session_files f JOIN upload_sessions s ON s.id=f.session_id WHERE s.state IN ('uploading','completing') AND s.expires_at>datetime('now','+08:00')",
    )
    .all())
    add(row.value)
  return refs
}

/**
 * 后台清理批处理：每批最多 limit 条待处理任务，逐条做精确引用检查后删除。
 * 请求链路只负责入队；这里由 30 秒后台维护器与启动恢复驱动。
 * 仍被引用的任务保留 pending（last_error='referenced'，排序垫底避免饿死后续任务）；
 * 物理删除失败记 attempts/last_error 留待重试；路径已不在上传根内的任务直接完结。
 */
export function processCleanupBatch(limit = 100) {
  if (db.inTransaction) return { scanned: 0, removed: 0, deferred: 0 }
  const jobs = db
    .prepare(
      "SELECT * FROM file_cleanup_jobs WHERE state='pending' ORDER BY (last_error='referenced'),id LIMIT ?",
    )
    .all(limit)
  const markRemoved = db.prepare(
    "UPDATE file_cleanup_jobs SET state='removed',completed_at=?,last_error=NULL WHERE id=?",
  )
  let removed = 0,
    deferred = 0
  for (const job of jobs) {
    const key = normalizeStorageKey(job.path)
    const resolved = key && resolveUploadPath(key)
    if (!resolved) {
      markRemoved.run(nowText(), job.id)
      continue
    }
    if (isFileReferenced(key)) {
      db.prepare(
        "UPDATE file_cleanup_jobs SET last_error='referenced' WHERE id=? AND last_error IS NULL",
      ).run(job.id)
      deferred += 1
      continue
    }
    try {
      fs.rmSync(resolved, { force: true })
      markRemoved.run(nowText(), job.id)
      removed += 1
    } catch (error) {
      db.prepare('UPDATE file_cleanup_jobs SET attempts=attempts+1,last_error=? WHERE id=?').run(
        String(error.code || error.message),
        job.id,
      )
      console.warn('附件清理等待重试', error.code)
    }
  }
  return { scanned: jobs.length, removed, deferred }
}

// 启动时自动迁移：把库内遗留的绝对路径统一转换为相对存储键。幂等，事务内执行；
// 每次启动都会运行（幂等且开销为一次有界扫描），因此常规升级无需任何手动迁移步骤。
// 仅"数据库连同旧上传根一起搬来、旧根与新根不同"的场景无法自动推断，才需要 storage-path-migrate.mjs --from-root。
const STORAGE_KEY_TARGETS = [
  { table: 'materials', column: 'file_url' },
  { table: 'submissions', column: 'file_url' },
  { table: 'group_submissions', column: 'file_url' },
  { table: 'submission_history', column: 'file_url' },
  { table: 'group_submission_history', column: 'file_url' },
  { table: 'submission_preview_images', column: 'file_url' },
  { table: 'submission_preview_images', column: 'thumbnail_url' },
  { table: 'operation_requests', column: 'file_path' },
  { table: 'file_cleanup_jobs', column: 'path', unique: true },
  { table: 'storage_quarantine', column: 'original_path' },
  { table: 'storage_quarantine', column: 'quarantine_path', unique: true },
]

export function migrateStorageKeys() {
  if (db.inTransaction) return { converted: 0, merged: 0, skipped: 0 }
  const updates = [],
    merged = []
  let skipped = 0
  for (const { table, column, unique } of STORAGE_KEY_TARGETS) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
      continue
    const rows = db
      .prepare(
        `SELECT id, ${column} value FROM ${table} WHERE ${column} IS NOT NULL AND ${column} <> ''`,
      )
      .all()
    const occupied = new Set()
    for (const row of rows) {
      if (!path.isAbsolute(String(row.value))) {
        const key = normalizeStorageKey(row.value)
        if (key) occupied.add(key)
      }
    }
    for (const row of rows) {
      const raw = String(row.value)
      if (!path.isAbsolute(raw)) continue // 已是相对存储键
      const key = normalizeStorageKey(raw)
      if (!key) {
        skipped += 1
        continue
      } // URL/越界等非法值：保留原值并计数，交由日志排查
      if (occupied.has(key)) {
        // 同一物理文件出现两条记录：UNIQUE 字段并入既有键行，其余字段允许同键并存。
        if (unique) merged.push({ table, id: row.id })
        else updates.push({ table, column, id: row.id, key })
        continue
      }
      occupied.add(key)
      updates.push({ table, column, id: row.id, key })
    }
  }
  db.transaction(() => {
    for (const item of updates)
      db.prepare(`UPDATE ${item.table} SET ${item.column}=? WHERE id=?`).run(item.key, item.id)
    for (const item of merged) db.prepare(`DELETE FROM ${item.table} WHERE id=?`).run(item.id)
  })()
  if (updates.length || merged.length || skipped)
    console.log(
      `存储键自动迁移：转换 ${updates.length} 行，合并 ${merged.length} 行，跳过非法值 ${skipped} 行。`,
    )
  return { converted: updates.length, merged: merged.length, skipped }
}

export function promoteUpload(file, folder) {
  if (!file) return null
  const directory = resolveUploadPath(path.join(config.uploadDir, folder))
  if (!directory) throw new Error('非法上传目录')
  fs.mkdirSync(directory, { recursive: true })
  const destination = path.join(
    directory,
    randomUUID() + path.extname(file.originalname).toLowerCase(),
  )
  fs.renameSync(file.path, destination)
  file.path = destination
  file.storageKey = toStorageKey(destination)
  return file
}

export function quarantineOrphans(minAgeMs = 24 * 60 * 60 * 1000) {
  const root = path.resolve(config.uploadDir),
    refs = referencedFiles(),
    candidates = []
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name === '.quarantine') continue
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(entryPath)
      else if (entry.isFile()) {
        const key = toStorageKey(entryPath)
        if (key && !refs.has(key) && Date.now() - fs.statSync(entryPath).mtimeMs >= minAgeMs)
          candidates.push(entryPath)
      }
    }
  }
  fs.mkdirSync(root, { recursive: true })
  walk(root)
  const dest = path.join(root, '.quarantine')
  fs.mkdirSync(dest, { recursive: true })
  for (const source of candidates) {
    const target = path.join(dest, randomUUID() + path.extname(source))
    fs.renameSync(source, target)
    db.prepare(
      'INSERT INTO storage_quarantine(original_path,quarantine_path,quarantined_at) VALUES(?,?,?)',
    ).run(toStorageKey(source), toStorageKey(target), nowText())
  }
  return { quarantined: candidates.length, retention_days: 30 }
}

export function purgeExpiredQuarantine(retentionDays = 30) {
  const rows = db
    .prepare(
      "SELECT * FROM storage_quarantine WHERE deleted_at IS NULL AND quarantined_at<=datetime('now','+08:00',?)",
    )
    .all(`-${retentionDays} days`)
  let removed = 0
  for (const row of rows) {
    const resolved = resolveUploadPath(row.quarantine_path)
    try {
      if (resolved) fs.rmSync(resolved, { force: true })
      db.prepare('UPDATE storage_quarantine SET deleted_at=? WHERE id=?').run(nowText(), row.id)
      removed += 1
    } catch (error) {
      console.warn('隔离文件到期清理等待重试', error.code)
    }
  }
  return { removed, retention_days: retentionDays }
}

export function pruneOperationalRecords({
  operationDays = 30,
  cleanupDays = 30,
  quarantineAuditDays = 90,
} = {}) {
  const operation = db
    .prepare(
      "DELETE FROM operation_requests WHERE state IN ('succeeded','failed') AND updated_at<=datetime('now','+08:00',?)",
    )
    .run(`-${operationDays} days`).changes
  const cleanup = db
    .prepare(
      "DELETE FROM file_cleanup_jobs WHERE state='removed' AND completed_at<=datetime('now','+08:00',?)",
    )
    .run(`-${cleanupDays} days`).changes
  const quarantine = db
    .prepare(
      "DELETE FROM storage_quarantine WHERE deleted_at IS NOT NULL AND deleted_at<=datetime('now','+08:00',?)",
    )
    .run(`-${quarantineAuditDays} days`).changes
  return { operation, cleanup, quarantine }
}
