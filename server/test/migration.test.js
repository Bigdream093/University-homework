import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'
test('legacy database migration preserves rows, timestamps and files; second boot is stable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mohen-migration-')),
    file = path.join(dir, 'homework.sqlite'),
    uploads = path.join(dir, 'uploads')
  fs.mkdirSync(uploads)
  const attachment = path.join(uploads, 'legacy.txt')
  fs.writeFileSync(attachment, 'historic submission')
  const legacy = new Database(file)
  legacy.exec(`
 CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'student',status TEXT NOT NULL DEFAULT 'active',must_change_password INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
 CREATE TABLE courses(id INTEGER PRIMARY KEY,name TEXT NOT NULL,code TEXT,description TEXT,teacher_id INTEGER NOT NULL REFERENCES users(id),invite_code TEXT UNIQUE,created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
 CREATE TABLE course_students(id INTEGER PRIMARY KEY,course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,student_id INTEGER NOT NULL REFERENCES users(id),joined_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),UNIQUE(course_id,student_id));
 CREATE TABLE assignments(id INTEGER PRIMARY KEY,course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,title TEXT NOT NULL,description TEXT,type TEXT NOT NULL DEFAULT 'document',deadline TEXT,total_score REAL DEFAULT 100,allow_resubmit_count INTEGER DEFAULT 1,status TEXT NOT NULL DEFAULT 'draft',created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
 CREATE TABLE submissions(id INTEGER PRIMARY KEY,assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,student_id INTEGER NOT NULL REFERENCES users(id),content TEXT,file_url TEXT,file_name TEXT,file_size INTEGER,file_type TEXT,submit_count INTEGER DEFAULT 0,status TEXT NOT NULL DEFAULT 'submitted',score REAL,comment TEXT,returned_reason TEXT,is_late INTEGER DEFAULT 0,submitted_at TEXT,graded_at TEXT,UNIQUE(assignment_id,student_id));
 CREATE TABLE submission_history(id INTEGER PRIMARY KEY,submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,file_url TEXT,file_name TEXT,file_size INTEGER,file_type TEXT,content TEXT,is_late INTEGER DEFAULT 0,submitted_at TEXT NOT NULL);
 INSERT INTO users(id,username,password_hash,name,role,created_at) VALUES(100,'legacy-teacher','not-a-login','历史教师','teacher','2020-01-01 12:00:00'),(101,'legacy-student','not-a-login','历史学生','student','2020-01-01 12:00:00');
 INSERT INTO courses(id,name,teacher_id,invite_code,created_at) VALUES(100,'旧课程',100,'OLD001','2020-01-01 12:00:00');
 INSERT INTO course_students(id,course_id,student_id) VALUES(100,100,101);
 INSERT INTO assignments(id,course_id,title,status,created_at,updated_at) VALUES(100,100,'旧作业','published','2020-01-01 12:00:00','2020-01-01 12:00:00');
 `)
  legacy
    .prepare(
      "INSERT INTO submissions(id,assignment_id,student_id,file_url,file_name,submit_count,submitted_at) VALUES(100,100,101,?,'旧文件.txt',2,'2020-01-02 12:00:00')",
    )
    .run(attachment)
  legacy
    .prepare(
      "INSERT INTO submission_history(id,submission_id,file_url,file_name,submitted_at) VALUES(100,100,?,'旧文件.txt','2020-01-02 12:00:00')",
    )
    .run(attachment)
  legacy.exec(
    "INSERT INTO submission_history(id,submission_id,file_url,file_name,submitted_at) VALUES(101,100,NULL,'已丢失引用.txt','2020-01-01 12:00:00')",
  )
  legacy.close()
  const code =
    "const {db}=await import('./src/db.js');console.log(JSON.stringify({course:db.prepare('SELECT id,created_at,status FROM courses WHERE id=100').get(),a:db.prepare('SELECT work_mode,max_file_mb FROM assignments WHERE id=100').get(),history:db.prepare('SELECT id,file_url,file_state,submitted_at FROM submission_history ORDER BY id').all(),migration:db.prepare('SELECT * FROM schema_migrations').all(),foreign:db.pragma('foreign_key_check')}));db.close();"
  const run = () =>
    JSON.parse(
      execFileSync(process.execPath, ['--input-type=module', '-e', code], {
        cwd: path.resolve(import.meta.dirname, '..'),
        env: { ...process.env, NODE_ENV: 'test', TZ: 'UTC', DATA_DIR: dir, UPLOAD_DIR: uploads },
        encoding: 'utf8',
      }).trim(),
    )
  try {
    const first = run(),
      second = run()
    assert.deepEqual(second, first)
    assert.equal(first.course.created_at, '2020-01-01 12:00:00')
    assert.equal(first.course.status, 'active')
    assert.equal(first.a.work_mode, 'individual')
    assert.equal(first.a.max_file_mb, 200)
    assert.equal(first.history.length, 2)
    assert.equal(first.history[1].file_state, 'legacy_unknown')
    assert.deepEqual(first.foreign, [])
    assert.equal(fs.readFileSync(attachment, 'utf8'), 'historic submission')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
test('front-end and back-end agree at deadline second boundaries', async () => {
  const { deadlineState } = await import('../../web/src/utils/deadline.js')
  const time = Date.parse('2026-08-31T12:00:00+08:00'),
    deadline = '2026-08-31 12:00:00'
  assert.notEqual(deadlineState(deadline, time).kind, 'late')
  assert.notEqual(deadlineState(deadline, time + 999).kind, 'late')
  assert.equal(deadlineState(deadline, time + 1000).kind, 'late')
})

test('production refuses a missing timezone before creating or migrating the database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mohen-timezone-')),
    target = path.join(dir, 'data')
  const env = { ...process.env, NODE_ENV: 'production', TZ: 'UTC', DATA_DIR: target }
  try {
    assert.throws(() =>
      execFileSync(process.execPath, ['--input-type=module', '-e', "await import('./src/db.js')"], {
        cwd: path.resolve(import.meta.dirname, '..'),
        env,
        stdio: 'pipe',
      }),
    )
    assert.equal(fs.existsSync(target), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('production refuses missing, short and example JWT secrets', () => {
  const cwd = path.resolve(import.meta.dirname, '..'),
    code = "await import('./src/config.js')"
  const run = (extra) =>
    execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd,
      env: { ...process.env, NODE_ENV: 'production', TZ: 'Asia/Shanghai', ...extra },
      stdio: 'pipe',
    })
  for (const JWT_SECRET of ['', 'too-short', 'replace-with-a-long-random-string'])
    assert.throws(() => run({ JWT_SECRET }))
  assert.doesNotThrow(() => run({ JWT_SECRET: 'a-secure-production-secret-with-32-bytes' }))
})
