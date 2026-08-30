import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new Database(path.join(config.dataDir, 'homework.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'student', status TEXT NOT NULL DEFAULT 'active',
  must_change_password INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, code TEXT, description TEXT,
  teacher_id INTEGER NOT NULL REFERENCES users(id), invite_code TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS course_students (
  id INTEGER PRIMARY KEY AUTOINCREMENT, course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id), sort_order INTEGER,
  joined_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(course_id, student_id)
);
CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT, type TEXT NOT NULL DEFAULT 'document', deadline TEXT,
  total_score REAL DEFAULT 100, allow_resubmit_count INTEGER DEFAULT 1,
  submission_mode TEXT NOT NULL DEFAULT 'overwrite',
  status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id), content TEXT, file_url TEXT, file_name TEXT,
  file_size INTEGER, file_type TEXT, submit_count INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'submitted', score REAL, comment TEXT, returned_reason TEXT,
  is_late INTEGER DEFAULT 0, submitted_at TEXT, graded_at TEXT,
  UNIQUE(assignment_id, student_id)
);
CREATE TABLE IF NOT EXISTS submission_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  file_url TEXT, file_name TEXT, file_size INTEGER, file_type TEXT, content TEXT,
  is_late INTEGER DEFAULT 0, submitted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assignments_course ON assignments(course_id);
CREATE INDEX IF NOT EXISTS idx_submissions_assignment ON submissions(assignment_id);
CREATE INDEX IF NOT EXISTS idx_course_students_course ON course_students(course_id);
CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT, course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  teacher_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT, course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  teacher_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  file_url TEXT, file_name TEXT, file_size INTEGER, file_type TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_notices_course ON notices(course_id);
CREATE INDEX IF NOT EXISTS idx_materials_course ON materials(course_id);
`);

const assignmentColumns = db.prepare('PRAGMA table_info(assignments)').all();
if (!assignmentColumns.some(column => column.name === 'submission_mode')) {
  db.exec(`ALTER TABLE assignments ADD COLUMN submission_mode TEXT NOT NULL DEFAULT 'overwrite'`);
}
if (!assignmentColumns.some(column => column.name === 'max_file_mb')) {
  db.exec(`ALTER TABLE assignments ADD COLUMN max_file_mb INTEGER`);
}

const courseStudentColumns = db.prepare('PRAGMA table_info(course_students)').all();
if (!courseStudentColumns.some(column => column.name === 'sort_order')) {
  db.exec('ALTER TABLE course_students ADD COLUMN sort_order INTEGER');
}
db.exec(`UPDATE course_students
  SET sort_order = (
    SELECT COUNT(*) FROM course_students earlier
    WHERE earlier.course_id = course_students.course_id AND earlier.id <= course_students.id
  )
  WHERE sort_order IS NULL`);

const seedUser = db.prepare(`INSERT OR IGNORE INTO users (username,password_hash,name,role,must_change_password) VALUES (?,?,?,?,?)`);
seedUser.run('teacher', bcrypt.hashSync('123456', 10), '任课教师', 'teacher', 1);

export function transaction(fn) { return db.transaction(fn); }
export function randomInvite() {
  let code;
  do code = Math.random().toString(36).slice(2, 8).toUpperCase();
  while (db.prepare('SELECT 1 FROM courses WHERE invite_code=?').get(code));
  return code;
}
