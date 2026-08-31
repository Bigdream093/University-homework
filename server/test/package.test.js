import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mohen-package-'));
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

function getZipBuffer(app, url, token) {
  return request(app).get(url).set('Authorization', `Bearer ${token}`)
    .buffer(true)
    .parse((res, cb) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
}

function zipEntryNames(buffer) {
  const names = [];
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return names;
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const nameLen = buffer.readUInt16LE(offset + 28);
    names.push(buffer.toString('utf8', offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  return names;
}

async function teacherLogin() {
  const res = await request(app).post('/api/auth/login').send({ username: 'teacher', password: '123456' });
  assert.equal(res.status, 200);
  return res.body.token;
}

async function makeCourse(token) {
  const res = await request(app).post('/api/courses').set('Authorization', `Bearer ${token}`)
    .send({ name: `打包测试-${Date.now()}`, code: 'PKG' });
  assert.equal(res.status, 201);
  return res.body.id;
}

async function makeAssignment(token, courseId, mode, type = 'document') {
  const res = await request(app).post(`/api/courses/${courseId}/assignments`).set('Authorization', `Bearer ${token}`)
    .send({ title: mode === 'append' ? '追加模式作业' : '覆盖模式作业', type, total_score: 100, allow_resubmit_count: -1, submission_mode: mode, status: 'published' });
  assert.equal(res.status, 201);
  assert.equal(res.body.submission_mode, mode);
  return res.body.id;
}

test('append mode keeps every uploaded file and the package zip contains all versions', async () => {
  const teacherToken = await teacherLogin();
  const courseId = await makeCourse(teacherToken);
  await request(app).post(`/api/courses/${courseId}/students`).set('Authorization', `Bearer ${teacherToken}`)
    .send({ username: '20260001', name: '演示学生' });
  const assignmentId = await makeAssignment(teacherToken, courseId, 'append');

  const studentLogin = await request(app).post('/api/auth/login').send({ username: '20260001', password: '123456' });
  const studentToken = studentLogin.body.token;
  assert.equal(studentLogin.status, 200);

  const first = await request(app).post(`/api/assignments/${assignmentId}/submit`).set('Authorization', `Bearer ${studentToken}`)
    .attach('file', Buffer.from('first version'), { filename: '草稿一.zip', contentType: 'application/zip' });
  assert.equal(first.status, 201);
  const firstFile = db.prepare('SELECT file_url FROM submissions WHERE id=?').get(first.body.id).file_url;
  assert.ok(fs.existsSync(firstFile));

  const second = await request(app).post(`/api/assignments/${assignmentId}/submit`).set('Authorization', `Bearer ${studentToken}`)
    .attach('file', Buffer.from('second version'), { filename: '补充二.zip', contentType: 'application/zip' });
  assert.equal(second.status, 201);
  const secondFile = db.prepare('SELECT file_url FROM submissions WHERE id=?').get(second.body.id).file_url;
  assert.ok(fs.existsSync(secondFile));
  assert.ok(fs.existsSync(firstFile), '追加模式下旧文件不应被删除');

  const history = db.prepare('SELECT file_url FROM submission_history WHERE submission_id=? ORDER BY id').all(first.body.id);
  assert.equal(history.filter(row => row.file_url).length, 2, '历史中应保留两次文件记录');

  const zipRes = await getZipBuffer(app, `/api/assignments/${assignmentId}/package`, teacherToken);
  assert.equal(zipRes.status, 200);
  assert.match(zipRes.headers['content-type'], /application\/zip/);
  const buffer = zipRes.body;
  assert.equal(buffer.readUInt32LE(0), 0x04034b50, 'zip 应以 PK\x03\x04 开头');
  const names = zipEntryNames(buffer);
  assert.equal(names.length, 2, '压缩包应包含两个文件');
  assert.ok(names.some(name => name.includes('草稿一.zip') || name.includes('_准时.zip')));
  assert.ok(names.some(name => name.includes('_准时.zip')), `压缩包条目含中文规范名: ${names.join(', ')}`);

  const denied = await request(app).get(`/api/assignments/${assignmentId}/package`).set('Authorization', `Bearer ${studentToken}`);
  assert.equal(denied.status, 403, '学生不能调用打包下载');
});

test('overwrite mode still removes the replaced physical file and zip keeps only latest', async () => {
  const teacherToken = await teacherLogin();
  const courseId = await makeCourse(teacherToken);
  await request(app).post(`/api/courses/${courseId}/students`).set('Authorization', `Bearer ${teacherToken}`)
    .send({ username: '20260001', name: '演示学生' });
  const assignmentId = await makeAssignment(teacherToken, courseId, 'overwrite');

  const studentLogin = await request(app).post('/api/auth/login').send({ username: '20260001', password: '123456' });
  const studentToken = studentLogin.body.token;

  const first = await request(app).post(`/api/assignments/${assignmentId}/submit`).set('Authorization', `Bearer ${studentToken}`)
    .attach('file', Buffer.from('old'), { filename: '旧版.zip', contentType: 'application/zip' });
  const firstFile = db.prepare('SELECT file_url FROM submissions WHERE id=?').get(first.body.id).file_url;

  const second = await request(app).post(`/api/assignments/${assignmentId}/submit`).set('Authorization', `Bearer ${studentToken}`)
    .attach('file', Buffer.from('new'), { filename: '新版.zip', contentType: 'application/zip' });
  assert.equal(second.status, 201);
  assert.equal(fs.existsSync(firstFile), false, '覆盖模式下旧文件应被删除');

  const zipRes = await getZipBuffer(app, `/api/assignments/${assignmentId}/package`, teacherToken);
  assert.equal(zipRes.status, 200);
  const names = zipEntryNames(zipRes.body);
  assert.equal(names.length, 1, '覆盖模式下压缩包只应包含最新文件');
});

test('package endpoint reports 400 when nobody has submitted', async () => {
  const teacherToken = await teacherLogin();
  const courseId = await makeCourse(teacherToken);
  const assignmentId = await makeAssignment(teacherToken, courseId, 'append');
  const zipRes = await request(app).get(`/api/assignments/${assignmentId}/package`).set('Authorization', `Bearer ${teacherToken}`);
  assert.equal(zipRes.status, 400);
});

test('package zip packs online-only answers as txt entries', async () => {
  const teacherToken = await teacherLogin();
  const courseId = await makeCourse(teacherToken);
  await request(app).post(`/api/courses/${courseId}/students`).set('Authorization', `Bearer ${teacherToken}`)
    .send({ username: '20260001', name: '演示学生' });
  const assignmentId = await makeAssignment(teacherToken, courseId, 'append', 'online');

  const studentLogin = await request(app).post('/api/auth/login').send({ username: '20260001', password: '123456' });
  assert.equal(studentLogin.status, 200);
  const studentToken = studentLogin.body.token;

  const submit = await request(app).post(`/api/assignments/${assignmentId}/submit`).set('Authorization', `Bearer ${studentToken}`)
    .send({ content: '在线作答内容会打包为txt' });
  assert.equal(submit.status, 201);

  const zipRes = await getZipBuffer(app, `/api/assignments/${assignmentId}/package`, teacherToken);
  assert.equal(zipRes.status, 200);
  const names = zipEntryNames(zipRes.body);
  assert.equal(names.length, 1, '压缩包应包含一个在线作答条目');
  assert.ok(names[0].endsWith('.txt'), `在线作答应打包为 txt: ${names.join(', ')}`);
});
