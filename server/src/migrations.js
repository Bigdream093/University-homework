import { nowText } from "./utils/time.js";

export function migrate(db) {
  const column = (table, name, type) => {
    if (
      !db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some((columnInfo) => columnInfo.name === name)
    )
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  };
  db.transaction(() => {
    if (
      db
        .prepare("SELECT 1 FROM schema_migrations WHERE version=?")
        .get("2026-09-workflows")
    )
      return;
    column(
      "assignments",
      "group_submit_policy",
      "TEXT NOT NULL DEFAULT 'designated'",
    );
    column("assignments", "groups_locked", "INTEGER NOT NULL DEFAULT 0");
    column(
      "course_group_members",
      "course_id",
      "INTEGER REFERENCES courses(id) ON DELETE CASCADE",
    );
    db.exec(
      "UPDATE course_group_members SET course_id=(SELECT course_id FROM course_groups WHERE id=course_group_id)",
    );
    column(
      "assignment_group_members",
      "assignment_id",
      "INTEGER REFERENCES assignments(id) ON DELETE CASCADE",
    );
    column(
      "assignment_group_members",
      "username_snapshot",
      "TEXT NOT NULL DEFAULT ''",
    );
    column(
      "assignment_group_members",
      "name_snapshot",
      "TEXT NOT NULL DEFAULT ''",
    );
    db.exec(`UPDATE assignment_group_members SET assignment_id=(SELECT assignment_id FROM assignment_groups WHERE id=assignment_group_id),
      username_snapshot=(SELECT username FROM users WHERE id=student_id),name_snapshot=(SELECT name FROM users WHERE id=student_id)`);
    column("group_submission_history", "replaced_at", "TEXT");
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
    db.prepare(
      "INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)",
    ).run("2026-09-workflows", nowText());
  })();
  db.transaction(() => {
    if (
      db
        .prepare("SELECT 1 FROM schema_migrations WHERE version=?")
        .get("2026-09-validation")
    )
      return;
    db.exec(
      "UPDATE assignments SET max_file_mb=200 WHERE max_file_mb IS NULL; UPDATE assignments SET groups_locked=1 WHERE status IN ('published','closed');",
    );
    db.prepare(
      "INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)",
    ).run("2026-09-validation", nowText());
  })();
  db.transaction(() => {
    if (
      db
        .prepare("SELECT 1 FROM schema_migrations WHERE version=?")
        .get("2026-09-question-publication-policy")
    )
      return;
    // Student questions and replies stay private, but students no longer veto a teacher-authored public summary.
    db.exec("UPDATE course_questions SET must_private=0 WHERE must_private<>0");
    db.prepare(
      "INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)",
    ).run("2026-09-question-publication-policy", nowText());
  })();
  db.transaction(() => {
    if (
      db
        .prepare("SELECT 1 FROM schema_migrations WHERE version=?")
        .get("2026-09-content-order")
    )
      return;
    column("assignments", "sort_order", "INTEGER");
    column("notices", "sort_order", "INTEGER");
    column("course_questions", "sort_order", "INTEGER");
    db.exec(`
      UPDATE assignments SET sort_order=-id WHERE sort_order IS NULL;
      UPDATE notices SET sort_order=-id WHERE sort_order IS NULL;
      UPDATE course_questions SET sort_order=-id WHERE sort_order IS NULL;
      CREATE INDEX IF NOT EXISTS idx_assignments_manual_order ON assignments(course_id,sort_order,id);
      CREATE INDEX IF NOT EXISTS idx_notices_manual_order ON notices(course_id,pinned,sort_order,id);
      CREATE INDEX IF NOT EXISTS idx_questions_manual_order ON course_questions(course_id,pinned,sort_order,id);
    `);
    db.prepare(
      "INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)",
    ).run("2026-09-content-order", nowText());
  })();
  db.transaction(() => {
    if (
      db
        .prepare("SELECT 1 FROM schema_migrations WHERE version=?")
        .get("2026-09-chunked-upload")
    )
      return;
    // 旧表从未投入业务使用；重建可安全解除 assignment_id 非空限制，并保持新结构清晰。
    db.exec(`
      DROP TABLE IF EXISTS upload_session_files;
      DROP TABLE IF EXISTS upload_sessions;
      CREATE TABLE upload_sessions (
        id TEXT PRIMARY KEY,actor_id INTEGER NOT NULL REFERENCES users(id),kind TEXT NOT NULL CHECK(kind IN ('submission','material')),
        assignment_id INTEGER REFERENCES assignments(id) ON DELETE CASCADE,course_id INTEGER REFERENCES courses(id) ON DELETE CASCADE,
        material_id INTEGER REFERENCES materials(id) ON DELETE CASCADE,mode TEXT,metadata_json TEXT,base_version INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','completing','succeeded','failed','cancelled')),
        result_json TEXT,last_error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,expires_at TEXT NOT NULL,completed_at TEXT,
        CHECK((kind='submission' AND assignment_id IS NOT NULL AND course_id IS NULL AND material_id IS NULL) OR (kind='material' AND assignment_id IS NULL AND course_id IS NOT NULL))
      );
      CREATE TABLE upload_session_files (
        id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,file_role TEXT NOT NULL,
        sort_order INTEGER NOT NULL,original_name TEXT NOT NULL,declared_size INTEGER NOT NULL,uploaded_bytes INTEGER NOT NULL DEFAULT 0,
        mime_type TEXT,expected_sha256 TEXT,calculated_sha256 TEXT,last_chunk_offset INTEGER,last_chunk_length INTEGER,
        last_chunk_sha256 TEXT,temporary_path TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'uploading'
      );
      CREATE INDEX idx_upload_sessions_actor ON upload_sessions(actor_id,state,expires_at);
      CREATE INDEX idx_upload_session_files_session ON upload_session_files(session_id,sort_order);
      CREATE INDEX IF NOT EXISTS idx_materials_file ON materials(file_url) WHERE file_url IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_submissions_file ON submissions(file_url) WHERE file_url IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_group_submissions_file ON group_submissions(file_url) WHERE file_url IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_submission_history_file ON submission_history(file_url) WHERE file_url IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_group_submission_history_file ON group_submission_history(file_url) WHERE file_url IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_preview_file ON submission_preview_images(file_url) WHERE file_url IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_preview_thumbnail ON submission_preview_images(thumbnail_url) WHERE thumbnail_url IS NOT NULL;
    `);
    db.prepare(
      "INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)",
    ).run("2026-09-chunked-upload", nowText());
  })();
  db.transaction(() => {
    if (
      db
        .prepare("SELECT 1 FROM schema_migrations WHERE version=?")
        .get("2026-09-storage-keys")
    )
      return;
    // 存储键化改造：清理任务支持重试计数与最近错误；路径列索引由 2026-09-chunked-upload 版本建立。
    column("file_cleanup_jobs", "attempts", "INTEGER NOT NULL DEFAULT 0");
    column("file_cleanup_jobs", "last_error", "TEXT");
    db.prepare(
      "INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)",
    ).run("2026-09-storage-keys", nowText());
  })();
  db.transaction(() => {
    if (
      db
        .prepare("SELECT 1 FROM schema_migrations WHERE version=?")
        .get("2026-09-grade-summary")
    )
      return;
    // 成绩汇总：作业权重与期末标记挂在作业上，占比与未评计入方式挂在课程上；每门课最多一个期末作业。
    column("assignments", "grade_weight", "REAL NOT NULL DEFAULT 1");
    column("assignments", "is_final", "INTEGER NOT NULL DEFAULT 0");
    column("courses", "daily_ratio", "REAL NOT NULL DEFAULT 40");
    column("courses", "final_ratio", "REAL NOT NULL DEFAULT 60");
    column("courses", "grade_absent_mode", "TEXT NOT NULL DEFAULT 'zero'");
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_course_final_assignment ON assignments(course_id) WHERE is_final=1;",
    );
    db.prepare(
      "INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)",
    ).run("2026-09-grade-summary", nowText());
  })();
  db.transaction(() => {
    if (
      db
        .prepare("SELECT 1 FROM schema_migrations WHERE version=?")
        .get("2026-09-weight-percent")
    )
      return;
    // 权重语义升级：grade_weight 由相对权重改为占总成绩百分比（0-100）。
    // 存量权重按 原平时占比 × w_i ÷ Σw 折算，合计保持等于原平时占比（舍入误差在权重最大项找齐），
    // 总成绩口径不变；期末与草稿作业占比置 0，新作业默认 0（不计入，直到老师显式设置）。
    const round1 = (value) => Math.round(value * 10) / 10;
    const listAssignments = db.prepare(
      "SELECT id,grade_weight FROM assignments WHERE course_id=? AND is_final=0 AND status<>'draft'",
    );
    const updateWeight = db.prepare(
      "UPDATE assignments SET grade_weight=? WHERE id=?",
    );
    const clearNonCounted = db.prepare(
      "UPDATE assignments SET grade_weight=0 WHERE course_id=? AND (is_final=1 OR status='draft')",
    );
    for (const course of db
      .prepare("SELECT id,daily_ratio FROM courses")
      .all()) {
      const rows = listAssignments.all(course.id);
      const daily = Math.max(0, Number(course.daily_ratio) || 0);
      const sum = rows.reduce(
        (total, assignment) =>
          total + Math.max(0, Number(assignment.grade_weight) || 0),
        0,
      );
      if (rows.length && sum > 0 && daily > 0) {
        const converted = rows.map((assignment) => {
          const weight = Math.max(0, Number(assignment.grade_weight) || 0);
          return {
            id: assignment.id,
            weight,
            pct: round1((daily * weight) / sum),
          };
        });
        const drift = round1(
          daily -
            converted.reduce((total, assignment) => total + assignment.pct, 0),
        );
        if (drift !== 0) {
          const largest = converted.reduce((left, right) =>
            right.weight > left.weight ? right : left,
          );
          largest.pct = Math.max(0, round1(largest.pct + drift));
        }
        for (const assignment of converted)
          updateWeight.run(assignment.pct, assignment.id);
      } else {
        for (const assignment of rows) updateWeight.run(0, assignment.id);
      }
      clearNonCounted.run(course.id);
    }
    db.prepare(
      "INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)",
    ).run("2026-09-weight-percent", nowText());
  })();
  db.transaction(() => {
    if (
      db
        .prepare("SELECT 1 FROM schema_migrations WHERE version=?")
        .get("2026-09-markdown")
    )
      return;
    column(
      "assignments",
      "description_format",
      "TEXT NOT NULL DEFAULT 'plain'",
    );
    for (const table of [
      "notices",
      "notice_revisions",
      "course_questions",
      "question_replies",
      "question_publications",
    ])
      column(table, "content_format", "TEXT NOT NULL DEFAULT 'plain'");
    db.exec(`CREATE TABLE IF NOT EXISTS editor_images (
      id TEXT PRIMARY KEY,
      course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      uploader_id INTEGER NOT NULL REFERENCES users(id),
      file_url TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now','+08:00'))
    )`);
    db.prepare(
      "INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)",
    ).run("2026-09-markdown", nowText());
  })();
}
