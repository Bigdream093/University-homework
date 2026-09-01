import { nowText } from './utils/time.js';

export function migrate(db) {
  const column = (table, name, type) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  };
  db.transaction(() => {
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get('2026-09-workflows')) return;
    column('assignments', 'group_submit_policy', "TEXT NOT NULL DEFAULT 'designated'");
    column('assignments', 'groups_locked', 'INTEGER NOT NULL DEFAULT 0');
    column('course_group_members', 'course_id', 'INTEGER REFERENCES courses(id) ON DELETE CASCADE');
    db.exec('UPDATE course_group_members SET course_id=(SELECT course_id FROM course_groups WHERE id=course_group_id)');
    column('assignment_group_members', 'assignment_id', 'INTEGER REFERENCES assignments(id) ON DELETE CASCADE');
    column('assignment_group_members', 'username_snapshot', "TEXT NOT NULL DEFAULT ''");
    column('assignment_group_members', 'name_snapshot', "TEXT NOT NULL DEFAULT ''");
    db.exec(`UPDATE assignment_group_members SET assignment_id=(SELECT assignment_id FROM assignment_groups WHERE id=assignment_group_id),
      username_snapshot=(SELECT username FROM users WHERE id=student_id),name_snapshot=(SELECT name FROM users WHERE id=student_id)`);
    column('group_submission_history', 'replaced_at', 'TEXT');
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_course_group_student ON course_group_members(course_id,student_id);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_assignment_group_student ON assignment_group_members(assignment_id,student_id);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_student_extension ON extension_requests(assignment_id,student_id) WHERE status='pending' AND student_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_group_extension ON extension_requests(assignment_id,assignment_group_id) WHERE status='pending' AND assignment_group_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_receipt_individual ON submission_receipts(submission_history_id) WHERE submission_history_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_receipt_group ON submission_receipts(group_submission_history_id) WHERE group_submission_history_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS operation_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER NOT NULL REFERENCES users(id),
        kind TEXT NOT NULL, target_id INTEGER NOT NULL, request_id TEXT NOT NULL,
        fingerprint TEXT, state TEXT NOT NULL CHECK(state IN ('processing','succeeded','failed')),
        result_json TEXT, file_path TEXT, error TEXT, owner TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(actor_id,kind,target_id,request_id)
      );
      CREATE TABLE IF NOT EXISTS file_cleanup_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,path TEXT UNIQUE NOT NULL,reason TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL,completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS storage_quarantine (
        id INTEGER PRIMARY KEY AUTOINCREMENT,original_path TEXT NOT NULL,quarantine_path TEXT NOT NULL UNIQUE,
        quarantined_at TEXT NOT NULL,deleted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS question_visibility_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,question_id INTEGER NOT NULL REFERENCES course_questions(id) ON DELETE CASCADE,
        actor_id INTEGER NOT NULL REFERENCES users(id),event TEXT NOT NULL,created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notice_revisions (
        notice_id INTEGER NOT NULL REFERENCES notices(id) ON DELETE CASCADE,revision INTEGER NOT NULL,
        title TEXT NOT NULL,content TEXT NOT NULL,changed_at TEXT NOT NULL,PRIMARY KEY(notice_id,revision)
      );
      UPDATE submission_history SET file_state=CASE WHEN file_name IS NOT NULL THEN 'legacy_unknown' WHEN COALESCE(content,'')<>'' THEN 'online' ELSE 'legacy_unknown' END WHERE file_url IS NULL;
      UPDATE notices SET published_at=created_at WHERE published_at IS NULL AND status IN ('published','withdrawn');
      INSERT OR IGNORE INTO notice_revisions SELECT id,content_revision,title,content,updated_at FROM notices;
    `);
    db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)').run('2026-09-workflows', nowText());
  })();
  db.transaction(()=>{
    if(db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get('2026-09-validation'))return;
    db.exec("UPDATE assignments SET max_file_mb=200 WHERE max_file_mb IS NULL; UPDATE assignments SET groups_locked=1 WHERE status IN ('published','closed');");
    db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)').run('2026-09-validation',nowText());
  })();
  db.transaction(()=>{
    if(db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get('2026-09-question-publication-policy'))return;
    // Student questions and replies stay private, but students no longer veto a teacher-authored public summary.
    db.exec('UPDATE course_questions SET must_private=0 WHERE must_private<>0');
    db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)').run('2026-09-question-publication-policy',nowText());
  })();
}
