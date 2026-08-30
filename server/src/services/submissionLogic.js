import path from 'node:path';
import { db, transaction } from '../db.js';
import { nowText, isLate } from '../utils/time.js';
import { safeName } from '../utils/fileFilter.js';
import { removeUploadFile } from '../utils/uploadPath.js';

function compactSubmissionTime(submittedAt) {
  const [date = '', time = ''] = String(submittedAt || '').split(' ');
  const [, month = '', day = ''] = date.split('-');
  const [hour = '', minute = ''] = time.split(':');
  return `${month}-${day}-${hour}:${minute}`;
}

function normalizedFileName(student, originalName, submittedAt, late) {
  const extension = path.extname(originalName).toLowerCase();
  const studentName = safeName(String(student.name || '学生').trim());
  const username = safeName(String(student.username || student.id).trim());
  const submissionTime = compactSubmissionTime(submittedAt);
  const lateLabel = late ? '迟交' : '准时';
  return `${studentName}_${username}_${submissionTime}_${lateLabel}${extension}`;
}

export function saveSubmission({ assignment, studentId, file, content }) {
  const current = db.prepare('SELECT * FROM submissions WHERE assignment_id=? AND student_id=?').get(assignment.id, studentId);
  const student = db.prepare("SELECT id,username,name FROM users WHERE id=? AND role='student'").get(studentId);
  if (!student) throw Object.assign(new Error('学生账号不存在'), { status: 404 });
  if (assignment.status !== 'published') throw Object.assign(new Error('作业当前不可提交'), { status: 400 });
  const allowed = assignment.allow_resubmit_count;
  if (current && allowed !== -1 && current.submit_count >= allowed + 1) throw Object.assign(new Error('已达到允许提交次数'), { status: 400 });
  if (!file && !String(content || '').trim()) throw Object.assign(new Error('请上传文件或填写在线作答内容'), { status: 400 });
  const maxFileMb = assignment.max_file_mb ?? 200;
  if (file && file.size > maxFileMb * 1024 * 1024) {
    throw Object.assign(new Error(`该作业限制单文件不超过 ${maxFileMb >= 1024 ? '1G' : `${maxFileMb}M`}`), { status: 400 });
  }
  const submittedAt = nowText();
  const late = isLate(assignment.deadline, submittedAt);
  const ext = file ? path.extname(file.originalname).slice(1).toLowerCase() : null;
  const values = {
    file_url: file?.path || current?.file_url || null,
    file_name: file ? normalizedFileName(student, file.originalname, submittedAt, late) : current?.file_name || null,
    file_size: file?.size || current?.file_size || null,
    file_type: ext || current?.file_type || null,
    content: content ?? current?.content ?? null
  };
  const appendMode = assignment.submission_mode === 'append';
  const run = transaction(() => {
    let id = current?.id;
    if (current) {
      if (file && !appendMode) db.prepare('UPDATE submission_history SET file_url=NULL WHERE submission_id=?').run(id);
      db.prepare(`UPDATE submissions SET content=?,file_url=?,file_name=?,file_size=?,file_type=?,submit_count=submit_count+1,status='submitted',score=NULL,comment=NULL,returned_reason=NULL,is_late=?,submitted_at=?,graded_at=NULL WHERE id=?`)
        .run(values.content, values.file_url, values.file_name, values.file_size, values.file_type, late, submittedAt, id);
    } else {
      const info = db.prepare(`INSERT INTO submissions(assignment_id,student_id,content,file_url,file_name,file_size,file_type,submit_count,status,is_late,submitted_at) VALUES(?,?,?,?,?,?,?,1,'submitted',?,?)`)
        .run(assignment.id, studentId, values.content, values.file_url, values.file_name, values.file_size, values.file_type, late, submittedAt);
      id = info.lastInsertRowid;
    }
    db.prepare(`INSERT INTO submission_history(submission_id,file_url,file_name,file_size,file_type,content,is_late,submitted_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(id, values.file_url, values.file_name, values.file_size, values.file_type, values.content, late, submittedAt);
    return db.prepare('SELECT * FROM submissions WHERE id=?').get(id);
  });
  const saved = run();
  if (file && !appendMode && current?.file_url && current.file_url !== file.path) removeUploadFile(current.file_url);
  return saved;
}
