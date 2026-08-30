import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mohen-submission-policy-'));
process.env.DATA_DIR = dataDir;
process.env.UPLOAD_DIR = path.join(dataDir, 'uploads');
fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true });

const { db } = await import('../src/db.js');
const { saveSubmission } = await import('../src/services/submissionLogic.js');

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function createAssignment(deadline) {
  const teacher = db.prepare("SELECT id FROM users WHERE username='teacher'").get();
  const studentId = Number(db.prepare(`INSERT INTO users(username,password_hash,name,role)
    VALUES(?,?,?,'student')`).run(`student-${Date.now()}-${Math.random()}`, bcrypt.hashSync('123456', 4), '张三').lastInsertRowid);
  const courseId = Number(db.prepare("INSERT INTO courses(name,teacher_id,invite_code) VALUES('提交测试',?,?)")
    .run(teacher.id, Math.random().toString(36).slice(2, 8)).lastInsertRowid);
  db.prepare('INSERT INTO course_students(course_id,student_id,sort_order) VALUES(?,?,1)').run(courseId, studentId);
  const assignmentId = Number(db.prepare(`INSERT INTO assignments(course_id,title,type,deadline,status)
    VALUES(?,'文件作业','document',?,'published')`).run(courseId, deadline).lastInsertRowid);
  return { studentId, assignment: db.prepare('SELECT * FROM assignments WHERE id=?').get(assignmentId) };
}

test('uploaded display filename includes name, username, submission time and late status', () => {
  const { studentId, assignment } = createAssignment('2099-01-01 00:00:00');
  const username = db.prepare('SELECT username FROM users WHERE id=?').get(studentId).username;
  const result = saveSubmission({
    assignment,
    studentId,
    file: { path: 'internal-safe-path', originalname: '我的最终版本.ZIP', size: 123 },
    content: ''
  });
  assert.match(result.file_name, new RegExp(`^张三_${username}_\\d{2}-\\d{2}-\\d{2}:\\d{2}_准时\\.zip$`));
  assert.equal(result.is_late, 0);
});

test('submission remains accepted after deadline and is marked late', () => {
  const { studentId, assignment } = createAssignment('2020-01-01 00:00:00');
  const result = saveSubmission({ assignment, studentId, file: null, content: '迟交内容' });
  assert.equal(result.status, 'submitted');
  assert.equal(result.is_late, 1);
});

test('a new uploaded file replaces and removes the previous physical file', () => {
  const { studentId, assignment } = createAssignment('2099-01-01 00:00:00');
  const previousPath = path.join(process.env.UPLOAD_DIR, 'previous-file.zip');
  const latestPath = path.join(process.env.UPLOAD_DIR, 'latest-file.zip');
  fs.writeFileSync(previousPath, 'old');
  fs.writeFileSync(latestPath, 'new');

  const first = saveSubmission({
    assignment,
    studentId,
    file: { path: previousPath, originalname: '第一次.zip', size: 3 },
    content: ''
  });
  const second = saveSubmission({
    assignment,
    studentId,
    file: { path: latestPath, originalname: '第二次.zip', size: 3 },
    content: ''
  });

  assert.equal(first.id, second.id);
  assert.equal(second.submit_count, 2);
  assert.equal(second.file_url, latestPath);
  assert.equal(fs.existsSync(previousPath), false);
  assert.equal(fs.existsSync(latestPath), true);
  const history = db.prepare('SELECT file_url FROM submission_history WHERE submission_id=? ORDER BY id').all(second.id);
  assert.deepEqual(history.map(row => row.file_url), [null, latestPath]);
});
