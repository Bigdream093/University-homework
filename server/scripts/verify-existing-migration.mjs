import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import Database from 'better-sqlite3'
const sourceDatabasePath = path.resolve(process.argv[2] || 'server/data/homework.sqlite')
if (!fs.existsSync(sourceDatabasePath)) throw new Error('指定的原数据库不存在')
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mohen-local-migration-copy-'))
const originalDatabase = new Database(sourceDatabasePath, { readonly: true, fileMustExist: true })
const tables = [
  'users',
  'courses',
  'course_students',
  'assignments',
  'submissions',
  'submission_history',
  'notices',
  'materials',
]
const tableCounts = (database) =>
  Object.fromEntries(
    tables.map((table) => [
      table,
      database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
        ? database.prepare('SELECT count(*) count FROM ' + table).get().count
        : 0,
    ]),
  )
const countsBeforeMigration = tableCounts(originalDatabase)
await originalDatabase.backup(path.join(temporaryDirectory, 'homework.sqlite'))
originalDatabase.close()
const migrationCommand = "const {db}=await import('./src/db.js');db.close();"
for (let attempt = 0; attempt < 2; attempt++) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', migrationCommand], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, NODE_ENV: 'test', TZ: 'UTC', DATA_DIR: temporaryDirectory },
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(result.stderr)
}
const upgradedDatabase = new Database(path.join(temporaryDirectory, 'homework.sqlite'), {
    readonly: true,
  }),
  countsAfterMigration = tableCounts(upgradedDatabase),
  foreignKeyErrors = upgradedDatabase.pragma('foreign_key_check')
upgradedDatabase.close()
if (
  JSON.stringify(countsBeforeMigration) !== JSON.stringify(countsAfterMigration) ||
  foreignKeyErrors.length
)
  throw new Error('副本校验失败，请保留临时副本进行检查')
console.log(
  JSON.stringify({
    source_modified: false,
    counts_preserved: true,
    foreign_key_errors: foreignKeyErrors.length,
    successful_boots: 2,
    table_counts: countsAfterMigration,
  }),
)
const resolvedTemporaryDirectory = path.resolve(temporaryDirectory)
if (
  path.dirname(resolvedTemporaryDirectory) === path.resolve(os.tmpdir()) &&
  path.basename(resolvedTemporaryDirectory).startsWith('mohen-local-migration-copy-')
)
  fs.rmSync(resolvedTemporaryDirectory, { recursive: true, force: true })
