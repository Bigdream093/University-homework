import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mohen-size-'));
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.DATA_DIR = dataDir;
process.env.UPLOAD_DIR = path.join(dataDir, 'uploads');
fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true });

const { app } = await import('../src/index.js');
const { db } = await import('../src/db.js');

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function teacherLogin() {
  const res = await request(app).post('/api/auth/login').send({ username: 'teacher', password: '123456' });
  assert.equal(res.status, 200);
  return res.body.token;
}

async function makeCourse(token) {
  const res = await request(app).post('/api/courses').set('Authorization', `Bearer ${token}`)
    .send({ name: '大小限制测试', code: 'SIZE' });
  assert.equal(res.status, 201);
  return res.body.id;
}

async function makeAssignment(token, courseId, extra = {}) {
  return request(app).post(`/api/courses/${courseId}/assignments`).set('Authorization', `Bearer ${token}`)
    .send({ title: '大小限制作业', type: 'document', total_score: 100, allow_resubmit_count: -1, submission_mode: 'overwrite', status: 'published', ...extra });
}

test('assignment rejects file-size presets outside the four options', async () => {
  const teacherToken = await teacherLogin();
  const courseId = await makeCourse(teacherToken);
  const bad = await makeAssignment(teacherToken, courseId, { max_file_mb: 300 });
  assert.equal(bad.status, 400, '非四档值被拒绝');
  const ok = await makeAssignment(teacherToken, courseId, { max_file_mb: 200 });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.max_file_mb, 200);
  const gig = await makeAssignment(teacherToken, courseId, { max_file_mb: 1024 });
  assert.equal(gig.status, 201);
  assert.equal(gig.body.max_file_mb, 1024);
});

test('student upload over the assignment limit is rejected with no record and no residue', async () => {
  const teacherToken = await teacherLogin();
  const courseId = await makeCourse(teacherToken);
  await request(app).post(`/api/courses/${courseId}/students`).set('Authorization', `Bearer ${teacherToken}`)
    .send({ username: '20260001', name: '演示学生' });
  const assignment = await makeAssignment(teacherToken, courseId, { max_file_mb: 100 });
  const assignmentId = assignment.body.id;

  const studentLogin = await request(app).post('/api/auth/login').send({ username: '20260001', password: '123456' });
  assert.equal(studentLogin.status, 200);
  const studentToken = studentLogin.body.token;

  const over = await request(app).post(`/api/assignments/${assignmentId}/submit`).set('Authorization', `Bearer ${studentToken}`)
    .attach('file', Buffer.alloc(100 * 1024 * 1024 + 4096, 1), { filename: '超大.zip', contentType: 'application/zip' });
  assert.equal(over.status, 400);
  assert.match(over.body.message, /100M/);

  const under = await request(app).post(`/api/assignments/${assignmentId}/submit`).set('Authorization', `Bearer ${studentToken}`)
    .attach('file', Buffer.from('small file'), { filename: '正常.pdf', contentType: 'application/pdf' });
  assert.equal(under.status, 201, '限制内文件正常提交');

  const list = await request(app).get(`/api/assignments/${assignmentId}/submissions`).set('Authorization', `Bearer ${teacherToken}`);
  const row = list.body.find(r => r.username === '20260001');
  assert.equal(row.submit_count, 1, '超限上传不计入提交次数');
  assert.equal(row.file_name.includes('正常.pdf') || row.file_name.includes('_准时.pdf'), true, '提交的是限制内的文件');
});

test('assignment without max_file_mb keeps the default fallback and accepts normal uploads', async () => {
  const teacherToken = await teacherLogin();
  const courseId = await makeCourse(teacherToken);
  await request(app).post(`/api/courses/${courseId}/students`).set('Authorization', `Bearer ${teacherToken}`)
    .send({ username: '20260001', name: '演示学生' });
  const assignment = await makeAssignment(teacherToken, courseId);
  assert.equal(assignment.body.max_file_mb, 200, '未指定时默认 200M');

  const studentLogin = await request(app).post('/api/auth/login').send({ username: '20260001', password: '123456' });
  const studentToken = studentLogin.body.token;
  const submit = await request(app).post(`/api/assignments/${assignment.body.id}/submit`).set('Authorization', `Bearer ${studentToken}`)
    .attach('file', Buffer.from('ok'), { filename: '小文件.zip', contentType: 'application/zip' });
  assert.equal(submit.status, 201);
});
