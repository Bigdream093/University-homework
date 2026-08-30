import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mohen-import-order-'));
process.env.DATA_DIR = dataDir;

const { db } = await import('../src/db.js');
const { importStudents } = await import('../src/services/importStudents.js');

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function makeWorkbook(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('学生名单');
  sheet.addRow(['学号', '姓名']);
  rows.forEach(row => sheet.addRow(row));
  return workbook.xlsx.writeBuffer();
}

function displayedUsernames(courseId) {
  return db.prepare(`SELECT u.username
    FROM course_students cs JOIN users u ON u.id=cs.student_id
    WHERE cs.course_id=?
    ORDER BY COALESCE(cs.sort_order, cs.id), cs.id`).all(courseId).map(row => row.username);
}

test('Excel import and re-import preserve the exact row order', async () => {
  const teacher = db.prepare("SELECT id FROM users WHERE username='teacher'").get();
  const courseId = Number(db.prepare("INSERT INTO courses(name,teacher_id,invite_code) VALUES('排序测试',?,'ORDER1')").run(teacher.id).lastInsertRowid);

  await importStudents(await makeWorkbook([
    ['20425120', '陈颖'],
    ['20425119', '陆裸'],
    ['20425118', '张恒硕']
  ]), courseId);
  assert.deepEqual(displayedUsernames(courseId), ['20425120', '20425119', '20425118']);

  await importStudents(await makeWorkbook([
    ['20425118', '张恒硕'],
    ['20425120', '陈颖'],
    ['20425119', '陆裸']
  ]), courseId);
  assert.deepEqual(displayedUsernames(courseId), ['20425118', '20425120', '20425119']);
});
