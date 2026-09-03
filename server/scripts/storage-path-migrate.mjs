// 一次性迁移：把库内的旧绝对路径转换为 UPLOAD_DIR 下的 POSIX 相对存储键。
// 常规升级无需运行本脚本：服务启动时会自动执行同样的转换（services/storage.js 的 migrateStorageKeys）。
// 仅当数据库从旧机器搬来、且旧上传根与新 UPLOAD_DIR 不同（无法自动推断）时，才需要用 --from-root 手动指定：
//
//   node scripts/storage-path-migrate.mjs --from-root <旧根目录>                    # dry-run（默认）
//   node scripts/storage-path-migrate.mjs --from-root <旧根目录> --execute --confirm-backup
// 参数：
//   --db <path>          SQLite 文件路径（默认 DATA_DIR/homework.sqlite）
//   --to-root <path>     新上传根目录（默认 UPLOAD_DIR）
//   --from-root <path>   旧绝对路径的根目录。数据库搬到新机器且旧根不再存在时必须显式提供
//   --execute            实际写入（缺省为 dry-run）；必须与 --confirm-backup 同时提供
// 规则：
//   只转换明确位于 to-root / from-root 之下的绝对路径；目标文件必须真实存在，否则归入 missing 不转换；
//   不在任何已知根之下归入 outside；UNIQUE 字段（file_cleanup_jobs.path、storage_quarantine.quarantine_path）
//   转换后与其他行冲突时按基线合并去重。全程参数绑定，重复执行幂等。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

if (flag('--execute') && !flag('--confirm-backup')) {
  console.error(
    '拒绝执行：--execute 必须与 --confirm-backup 同时提供，并确认已完成停服与 SQLite/uploads 备份。',
  )
  process.exit(1)
}
// workspace 依赖可能提升到仓库根：按候选路径解析 better-sqlite3。
const nodeModulesCandidates = [
  path.join(repoRoot, 'node_modules'),
  path.resolve(repoRoot, '..', 'node_modules'),
]
const modulesRoot = nodeModulesCandidates.find((dir) =>
  fs.existsSync(path.join(dir, 'better-sqlite3')),
)
if (!modulesRoot) {
  console.error('未找到 better-sqlite3 依赖，请在仓库内执行 npm install。')
  process.exit(1)
}
const Database = (
  await import(pathToFileURL(path.join(modulesRoot, 'better-sqlite3/lib/index.js')))
).default
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(repoRoot, 'data')
const dbPath = path.resolve(option('--db') || path.join(dataDir, 'homework.sqlite'))
const toRoot = path.resolve(
  option('--to-root') ||
    (process.env.UPLOAD_DIR
      ? path.resolve(process.env.UPLOAD_DIR)
      : path.join(repoRoot, 'uploads')),
)
const fromRoot = option('--from-root') ? path.resolve(option('--from-root')) : null
if (!fs.existsSync(dbPath)) {
  console.error(`数据库不存在：${dbPath}`)
  process.exit(1)
}
const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = OFF')

const tableExists = (name) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
for (const table of [
  'materials',
  'submissions',
  'group_submissions',
  'submission_history',
  'group_submission_history',
  'submission_preview_images',
  'operation_requests',
  'file_cleanup_jobs',
  'storage_quarantine',
]) {
  if (!tableExists(table)) {
    console.error(`缺少表 ${table}：请先启动一次服务让 schema 迁移完成，再执行本脚本。`)
    process.exit(1)
  }
}
const hasUploadSessionFiles = tableExists('upload_session_files')

// {table, column, unique}：unique 字段转换后冲突时合并去重。
const TARGETS = [
  { table: 'materials', column: 'file_url', unique: false },
  { table: 'submissions', column: 'file_url', unique: false },
  { table: 'group_submissions', column: 'file_url', unique: false },
  { table: 'submission_history', column: 'file_url', unique: false },
  { table: 'group_submission_history', column: 'file_url', unique: false },
  { table: 'submission_preview_images', column: 'file_url', unique: false },
  { table: 'submission_preview_images', column: 'thumbnail_url', unique: false },
  { table: 'operation_requests', column: 'file_path', unique: false },
  { table: 'file_cleanup_jobs', column: 'path', unique: true },
  { table: 'storage_quarantine', column: 'original_path', unique: false },
  { table: 'storage_quarantine', column: 'quarantine_path', unique: true },
  ...(hasUploadSessionFiles
    ? [{ table: 'upload_session_files', column: 'temporary_path', unique: false }]
    : []),
]

function posixRelative(root, target) {
  const relative = path.relative(root, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return relative.split(path.sep).join('/')
}

function classify(value) {
  if (typeof value !== 'string' || !value) return 'empty'
  if (value.includes('://')) return 'outside'
  if (!path.isAbsolute(value)) {
    // 已是相对键：校验规范化后不越界。
    const normalized = path.posix.normalize(value.split('\\').join('/'))
    if (!normalized || normalized === '.' || normalized.startsWith('../')) return 'outside'
    return 'relative'
  }
  const resolved = path.resolve(value)
  const key =
    posixRelative(toRoot, resolved) ?? (fromRoot ? posixRelative(fromRoot, resolved) : null)
  if (!key) return 'outside'
  if (!fs.existsSync(path.join(toRoot, ...key.split('/')))) return 'missing'
  return key
}

const plan = [] // {table, column, id, key}
const mergeDeletes = [] // {table, id}  UNIQUE 字段冲突时被合并删除的行
const report = {
  convertible: [],
  missing: [],
  outside: [],
  conflicts: [],
  merged: 0,
  already_relative: 0,
}
for (const { table, column, unique } of TARGETS) {
  const rows = db
    .prepare(
      `SELECT id, ${column} value FROM ${table} WHERE ${column} IS NOT NULL AND ${column} <> ''`,
    )
    .all()
  const seenKeys = new Map() // key -> id（本表本列内，含既有相对键）
  // 先登记既有相对键占用，再逐行分类。
  for (const row of rows) {
    const kind = classify(row.value)
    if (kind === 'relative')
      seenKeys.set(path.posix.normalize(row.value.split('\\').join('/')), row.id)
  }
  for (const row of rows) {
    const kind = classify(row.value)
    if (kind === 'empty') continue
    if (kind === 'relative') {
      report.already_relative += 1
      continue
    }
    if (kind === 'missing') {
      report.missing.push({ table, id: row.id, value: row.value })
      continue
    }
    if (kind === 'outside') {
      report.outside.push({ table, id: row.id, value: row.value })
      continue
    }
    const key = kind,
      existing = seenKeys.get(key)
    if (existing !== undefined && unique) {
      mergeDeletes.push({ table, id: row.id })
      report.merged += 1
      continue
    }
    if (existing !== undefined) {
      report.conflicts.push({ table, id: row.id, key, with_id: existing })
      continue
    }
    seenKeys.set(key, row.id)
    plan.push({ table, column, id: row.id, key })
    report.convertible.push({ table, id: row.id, key })
  }
}

const summary = {
  db: dbPath,
  to_root: toRoot,
  from_root: fromRoot,
  mode: flag('--execute') ? 'execute' : 'dry-run',
  already_relative: report.already_relative,
  convertible: report.convertible.length,
  missing: report.missing.length,
  outside: report.outside.length,
  conflicts: report.conflicts.length,
  merged_duplicates: report.merged,
}
const sample = (list, name) => {
  if (list.length) console.log(`${name}（前 ${Math.min(20, list.length)} 条）:`)
  for (const item of list.slice(0, 20)) console.log(' ', JSON.stringify(item))
}
console.log(JSON.stringify(summary, null, 2))
sample(report.missing, 'missing（目标文件缺失，保持原值）')
sample(report.outside, 'outside（不在已知根目录下，保持原值；跨机器迁移请提供 --from-root）')
sample(report.conflicts, 'conflicts（转换后与其他行同键，保持原值）')
sample(
  report.missing.length || report.outside.length || report.conflicts.length
    ? report.convertible
    : [],
  'convertible',
)

if (!flag('--execute')) {
  console.log(
    'dry-run 完成。确认清单后执行：node scripts/storage-path-migrate.mjs --execute --confirm-backup [--from-root <旧根目录>]',
  )
} else if (summary.missing || summary.outside || summary.conflicts) {
  console.error('存在 missing/outside/conflicts 记录，拒绝执行迁移；请先修复或人工确认后重跑。')
  process.exit(1)
} else {
  db.transaction(() => {
    for (const item of plan)
      db.prepare(`UPDATE ${item.table} SET ${item.column}=? WHERE id=?`).run(item.key, item.id)
    for (const item of mergeDeletes) db.prepare(`DELETE FROM ${item.table} WHERE id=?`).run(item.id)
  })()
  console.log(
    `迁移完成：更新 ${plan.length} 行，合并重复 ${mergeDeletes.length} 行。请运行存储审计（scripts/storage-audit.mjs）并保留备份至少一个发布周期。`,
  )
}
db.close()
