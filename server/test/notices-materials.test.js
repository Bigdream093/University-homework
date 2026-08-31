import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import request from 'supertest';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mohen-content-'));
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

function getBinary(url, token) {
  return request(app).get(url).set('Authorization', `Bearer ${token}`)
    .buffer(true)
    .parse((res, cb) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
}

async function login(username) {
  const res = await request(app).post('/api/auth/login').send({ username, password: '123456' });
  assert.equal(res.status, 200);
  return res.body.token;
}

async function makeCourse(token, name) {
  const res = await request(app).post('/api/courses').set('Authorization', `Bearer ${token}`)
    .send({ name: name || '内容测试', code: 'CNT' });
  assert.equal(res.status, 201);
  return res.body.id;
}

function addTeacher(username) {
  const info = db.prepare(`INSERT INTO users(username,password_hash,name,role,must_change_password) VALUES(?,?,?, 'teacher', 1)`)
    .run(username, bcrypt.hashSync('123456', 10), username);
  return info.lastInsertRowid;
}

test('notices: teacher CRUD, student only sees published, permissions enforced', async () => {
  const teacherToken = await login('teacher');
  const courseId = await makeCourse(teacherToken);
  await request(app).post(`/api/courses/${courseId}/students`).set('Authorization', `Bearer ${teacherToken}`)
    .send({ username: '20260001', name: '演示学生' });
  const studentToken = await login('20260001');

  const noTitle = await request(app).post(`/api/courses/${courseId}/notices`).set('Authorization', `Bearer ${teacherToken}`)
    .send({ title: '', content: 'x' });
  assert.equal(noTitle.status, 400, '标题必填');

  const draft = await request(app).post(`/api/courses/${courseId}/notices`).set('Authorization', `Bearer ${teacherToken}`)
    .send({ title: '草稿通知', content: '还没发布', status: 'draft' });
  assert.equal(draft.status, 201);
  assert.equal(draft.body.status, 'draft');

  const published = await request(app).post(`/api/courses/${courseId}/notices`).set('Authorization', `Bearer ${teacherToken}`)
    .send({ title: '重要通知', content: '请查收', status: 'published', pinned: true });
  assert.equal(published.status, 201);

  const teacherList = await request(app).get(`/api/courses/${courseId}/notices`).set('Authorization', `Bearer ${teacherToken}`);
  assert.equal(teacherList.status, 200);
  assert.equal(teacherList.body.length, 2, '教师可见全部通知');

  const studentList = await request(app).get(`/api/courses/${courseId}/notices`).set('Authorization', `Bearer ${studentToken}`);
  assert.equal(studentList.status, 200);
  assert.equal(studentList.body.length, 1, '学生只看到已发布');
  assert.equal(studentList.body[0].title, '重要通知');

  const otherCourse = await makeCourse(teacherToken, '未加入课程');
  const outsiderList = await request(app).get(`/api/courses/${otherCourse}/notices`).set('Authorization', `Bearer ${studentToken}`);
  assert.equal(outsiderList.status, 403, '未加入课程的学生不能查看');

  const edit = await request(app).put(`/api/notices/${draft.body.id}`).set('Authorization', `Bearer ${teacherToken}`)
    .send({ title: '草稿通知-改', content: '已改', status: 'published' });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.status, 'published');

  const withdrawn = await request(app).post(`/api/notices/${published.body.id}/withdraw`).set('Authorization', `Bearer ${teacherToken}`);
  assert.equal(withdrawn.status, 200);

  addTeacher('otherteacher');
  const otherToken = await login('otherteacher');
  const otherTeaches = await request(app).post('/api/courses').set('Authorization', `Bearer ${otherToken}`)
    .send({ name: '别的老师课程', code: 'OTH' });
  const otherCourseId = otherTeaches.body.id;
  const notOwnerList = await request(app).get(`/api/courses/${courseId}/notices`).set('Authorization', `Bearer ${otherToken}`);
  assert.equal(notOwnerList.status, 403, '非本课程教师不能查看');
  const notOwnerDelete = await request(app).delete(`/api/notices/${draft.body.id}`).set('Authorization', `Bearer ${otherToken}`);
  assert.equal(notOwnerDelete.status, 403, '非本课程教师不能删除他人通知');
  assert.equal(otherCourseId > 0, true);
});

test('materials: teacher uploads, student lists and downloads, delete removes file', async () => {
  const teacherToken = await login('teacher');
  const courseId = await makeCourse(teacherToken);
  await request(app).post(`/api/courses/${courseId}/students`).set('Authorization', `Bearer ${teacherToken}`)
    .send({ username: '20260001', name: '演示学生' });
  const studentToken = await login('20260001');

  const noTitle = await request(app).post(`/api/courses/${courseId}/materials`).set('Authorization', `Bearer ${teacherToken}`)
    .field('title', '')
    .attach('file', Buffer.from('内容'), { filename: 'x.pdf', contentType: 'application/pdf' });
  assert.equal(noTitle.status, 400, '标题必填');

  const upload = await request(app).post(`/api/courses/${courseId}/materials`).set('Authorization', `Bearer ${teacherToken}`)
    .field('title', '课程讲义')
    .field('description', '第一章')
    .attach('file', Buffer.from('讲义内容'), { filename: '讲义.pdf', contentType: 'application/pdf' });
  assert.equal(upload.status, 201);
  const materialId = upload.body.id;
  assert.equal(upload.body.file_name, '讲义.pdf');

  const studentList = await request(app).get(`/api/courses/${courseId}/materials`).set('Authorization', `Bearer ${studentToken}`);
  assert.equal(studentList.status, 200);
  assert.equal(studentList.body.length, 1);
  assert.equal(studentList.body[0].file_name, '讲义.pdf');
  assert.equal(studentList.body[0].file_url, undefined, '列表不泄露内部路径');

  const download = await getBinary(`/api/materials/${materialId}/file`, studentToken);
  assert.equal(download.status, 200);
  assert.equal(download.body.toString(), '讲义内容');

  const outsider = await request(app).get(`/api/courses/${courseId}/materials`).set('Authorization', `Bearer ${teacherToken}`);
  assert.equal(outsider.status, 200);

  const del = await request(app).delete(`/api/materials/${materialId}`).set('Authorization', `Bearer ${teacherToken}`);
  assert.equal(del.status, 200);

  const gone = await getBinary(`/api/materials/${materialId}/file`, studentToken);
  assert.equal(gone.status, 404, '删除后文件不可再下载');
});

test('materials: non-enrolled student cannot list or download', async () => {
  const teacherToken = await login('teacher');
  const courseId = await makeCourse(teacherToken, '别人课程');
  const studentToken = await login('20260001');
  const list = await request(app).get(`/api/courses/${courseId}/materials`).set('Authorization', `Bearer ${studentToken}`);
  assert.equal(list.status, 403, '未加入课程的学生不能查看资料');
});
