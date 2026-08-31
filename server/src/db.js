import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { migrate } from './migrations.js';

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new Database(path.join(config.dataDir, 'homework.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'student', status TEXT NOT NULL DEFAULT 'active',
  must_change_password INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now','+08:00'))
);
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, code TEXT, description TEXT,
  teacher_id INTEGER NOT NULL REFERENCES users(id), invite_code TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now','+08:00'))
);
CREATE TABLE IF NOT EXISTS course_students (
  id INTEGER PRIMARY KEY AUTOINCREMENT, course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id), sort_order INTEGER,
  joined_at TEXT NOT NULL DEFAULT (datetime('now','+08:00')),
  UNIQUE(course_id, student_id)
);
CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT, type TEXT NOT NULL DEFAULT 'document', deadline TEXT,
  total_score REAL DEFAULT 100, allow_resubmit_count INTEGER DEFAULT 1,
  submission_mode TEXT NOT NULL DEFAULT 'overwrite',
  status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL DEFAULT (datetime('now','+08:00')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','+08:00'))
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
  created_at TEXT NOT NULL DEFAULT (datetime('now','+08:00')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','+08:00'))
);
CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT, course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  teacher_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  file_url TEXT, file_name TEXT, file_size INTEGER, file_type TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','+08:00'))
);
CREATE INDEX IF NOT EXISTS idx_notices_course ON notices(course_id);
CREATE INDEX IF NOT EXISTS idx_materials_course ON materials(course_id);
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY, applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS material_downloads (
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id),
  download_count INTEGER NOT NULL DEFAULT 0,
  first_downloaded_at TEXT NOT NULL,
  last_downloaded_at TEXT NOT NULL,
  PRIMARY KEY(material_id, student_id)
);
CREATE TABLE IF NOT EXISTS notice_reads (
  notice_id INTEGER NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id),
  first_read_at TEXT NOT NULL,
  last_read_at TEXT NOT NULL,
  last_seen_revision INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(notice_id, student_id)
);
CREATE TABLE IF NOT EXISTS extension_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id INTEGER REFERENCES users(id),
  assignment_group_id INTEGER REFERENCES assignment_groups(id) ON DELETE CASCADE,
  requester_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL, requested_deadline TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', decision_reason TEXT,
  approved_deadline TEXT, decided_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL, decided_at TEXT,
  CHECK ((student_id IS NOT NULL) != (assignment_group_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS submission_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_no TEXT UNIQUE NOT NULL,
  submission_history_id INTEGER REFERENCES submission_history(id) ON DELETE CASCADE,
  group_submission_history_id INTEGER REFERENCES group_submission_history(id) ON DELETE CASCADE,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id INTEGER REFERENCES users(id),
  assignment_group_id INTEGER REFERENCES assignment_groups(id) ON DELETE CASCADE,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK ((submission_history_id IS NOT NULL) != (group_submission_history_id IS NOT NULL)),
  CHECK ((student_id IS NOT NULL) != (assignment_group_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS course_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL, content TEXT NOT NULL,
  must_private INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'open',
  hidden INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS question_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES course_questions(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id), content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS question_publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES course_questions(id) ON DELETE CASCADE,
  teacher_id INTEGER NOT NULL REFERENCES users(id), summary TEXT NOT NULL, reply TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published', created_at TEXT NOT NULL, withdrawn_at TEXT
);
CREATE TABLE IF NOT EXISTS course_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT, course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  name TEXT NOT NULL, leader_id INTEGER REFERENCES users(id), created_at TEXT NOT NULL,
  UNIQUE(course_id, name)
);
CREATE TABLE IF NOT EXISTS course_group_members (
  course_group_id INTEGER NOT NULL REFERENCES course_groups(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id), PRIMARY KEY(course_group_id, student_id)
);
CREATE TABLE IF NOT EXISTS assignment_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT, assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  name TEXT NOT NULL, submitter_id INTEGER REFERENCES users(id), created_at TEXT NOT NULL,
  UNIQUE(assignment_id, name)
);
CREATE TABLE IF NOT EXISTS assignment_group_members (
  assignment_group_id INTEGER NOT NULL REFERENCES assignment_groups(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id), PRIMARY KEY(assignment_group_id, student_id)
);
CREATE TABLE IF NOT EXISTS group_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, assignment_group_id INTEGER NOT NULL UNIQUE REFERENCES assignment_groups(id) ON DELETE CASCADE,
  content TEXT, file_url TEXT, file_name TEXT, file_size INTEGER, file_type TEXT,
  submit_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'submitted', score REAL, comment TEXT,
  returned_reason TEXT, is_late INTEGER NOT NULL DEFAULT 0, submitted_at TEXT, submitted_by INTEGER REFERENCES users(id), graded_at TEXT
);
CREATE TABLE IF NOT EXISTS group_submission_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, group_submission_id INTEGER NOT NULL REFERENCES group_submissions(id) ON DELETE CASCADE,
  file_url TEXT, file_name TEXT, file_size INTEGER, file_type TEXT, content TEXT,
  file_state TEXT NOT NULL DEFAULT 'available', is_late INTEGER NOT NULL DEFAULT 0,
  submitted_at TEXT NOT NULL, submitted_by INTEGER REFERENCES users(id)
);
`);

function ensureColumn(table, column, definition) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

const assignmentColumns = db.prepare('PRAGMA table_info(assignments)').all();
if (!assignmentColumns.some(column => column.name === 'submission_mode')) {
  db.exec(`ALTER TABLE assignments ADD COLUMN submission_mode TEXT NOT NULL DEFAULT 'overwrite'`);
}
if (!assignmentColumns.some(column => column.name === 'max_file_mb')) {
  db.exec(`ALTER TABLE assignments ADD COLUMN max_file_mb INTEGER`);
}
ensureColumn('assignments', 'work_mode', "TEXT NOT NULL DEFAULT 'individual'");
ensureColumn('courses', 'status', "TEXT NOT NULL DEFAULT 'active'");
ensureColumn('courses', 'archived_at', 'TEXT');
ensureColumn('courses', 'copied_from_id', 'INTEGER');
ensureColumn('notices', 'scheduled_at', 'TEXT');
ensureColumn('notices', 'published_at', 'TEXT');
ensureColumn('notices', 'withdrawn_at', 'TEXT');
ensureColumn('notices', 'withdrawn_reason', 'TEXT');
ensureColumn('notices', 'content_revision', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('submission_history', 'file_state', "TEXT NOT NULL DEFAULT 'available'");
ensureColumn('submission_history', 'replaced_at', 'TEXT');

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

migrate(db);

const seedUser = db.prepare(`INSERT OR IGNORE INTO users (username,password_hash,name,role,must_change_password,created_at) VALUES (?,?,?,?,?,datetime('now','+08:00'))`);
seedUser.run('teacher', bcrypt.hashSync('123456', 10), '任课教师', 'teacher', 1);

export function transaction(fn) { return db.transaction(fn); }
export function randomInvite() {
  let code;
  do code = Math.random().toString(36).slice(2, 8).toUpperCase();
  while (db.prepare('SELECT 1 FROM courses WHERE invite_code=?').get(code));
  return code;
}
