import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import request from 'supertest';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mohen-api-'));
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.DATA_DIR = dataDir;
process.env.UPLOAD_DIR = path.join(dataDir, 'uploads');
fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true });
const { app } = await import('../src/index.js');
const { db } = await import('../src/db.js');
db.prepare(`INSERT INTO users(username,password_hash,name,role) VALUES(?,?,?,'student')`)
  .run('20260001', bcrypt.hashSync('123456', 4), '演示学生');

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('health endpoint is available', async () => {
  const response = await request(app).get('/api/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
});

test('teacher can log in and access courses', async () => {
  const login = await request(app).post('/api/auth/login').send({ username: 'teacher', password: '123456' });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, 'teacher');
  const courses = await request(app).get('/api/courses').set('Authorization', `Bearer ${login.body.token}`);
  assert.equal(courses.status, 200);
  assert.ok(Array.isArray(courses.body));
});

test('student cannot access teacher course management', async () => {
  const login = await request(app).post('/api/auth/login').send({ username: '20260001', password: '123456' });
  const response = await request(app).get('/api/courses').set('Authorization', `Bearer ${login.body.token}`);
  assert.equal(response.status, 403);
});

test('invalid token is rejected', async () => {
  const response = await request(app).get('/api/my/courses').set('Authorization', 'Bearer invalid');
  assert.equal(response.status, 401);
});

test('complete workflow: course, assignment, submit, grade and privacy boundary', async () => {
  const teacherLogin = await request(app).post('/api/auth/login').send({ username: 'teacher', password: '123456' });
  const studentLogin = await request(app).post('/api/auth/login').send({ username: '20260001', password: '123456' });
  const teacherToken = teacherLogin.body.token, studentToken = studentLogin.body.token;

  const course = await request(app).post('/api/courses').set('Authorization', `Bearer ${teacherToken}`)
    .send({ name: `自动测试课程-${Date.now()}`, code: 'TEST', description: '自动化完整流程' });
  assert.equal(course.status, 201);

  const addStudent = await request(app).post(`/api/courses/${course.body.id}/students`).set('Authorization', `Bearer ${teacherToken}`)
    .send({ username: '20260001', name: '演示学生' });
  assert.ok([200, 201].includes(addStudent.status));

  const assignment = await request(app).post(`/api/courses/${course.body.id}/assignments`).set('Authorization', `Bearer ${teacherToken}`)
    .send({ title: '在线测试作业', type: 'online', total_score: 100, allow_resubmit_count: 1, status: 'published' });
  assert.equal(assignment.status, 201);

  const submit = await request(app).post(`/api/assignments/${assignment.body.id}/submit`).set('Authorization', `Bearer ${studentToken}`)
    .send({ content: '这是学生的在线作答。' });
  assert.equal(submit.status, 201);

  const list = await request(app).get(`/api/assignments/${assignment.body.id}/submissions`).set('Authorization', `Bearer ${teacherToken}`);
  const record = list.body.find(row => row.username === '20260001');
  assert.ok(record?.id);

  const grade = await request(app).post(`/api/submissions/${record.id}/grade`).set('Authorization', `Bearer ${teacherToken}`)
    .send({ score: 92, comment: '完成良好' });
  assert.equal(grade.status, 200);

  const studentView = await request(app).get(`/api/assignments/${assignment.body.id}/my-submission`).set('Authorization', `Bearer ${studentToken}`);
  assert.equal(studentView.body.status, 'graded');
  assert.equal(Object.hasOwn(studentView.body, 'score'), false);
  assert.equal(Object.hasOwn(studentView.body, 'comment'), false);

  const exported = await request(app).get(`/api/assignments/${assignment.body.id}/export`).set('Authorization', `Bearer ${teacherToken}`);
  assert.equal(exported.status, 200);
  assert.match(exported.headers['content-type'], /spreadsheetml/);

  await request(app).delete(`/api/courses/${course.body.id}`).set('Authorization', `Bearer ${teacherToken}`);
});
