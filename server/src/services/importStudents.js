import ExcelJS from 'exceljs';
import bcrypt from 'bcryptjs';
import { db, transaction } from '../db.js';

export async function importStudents(buffer, courseId) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw Object.assign(new Error('Excel中没有可读取的工作表'), { status: 400 });
  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber > 1) rows.push({ rowNumber, username: String(row.getCell(1).text || '').trim(), name: String(row.getCell(2).text || '').trim() });
  });
  const result = { created: 0, joined: 0, duplicated: 0, failed: [] };
  const run = transaction(() => {
    const seen = new Set();
    const orderedRows = rows.filter(row => {
      if (!row.username || !row.name) {
        result.failed.push({ row: row.rowNumber, reason: '学号或姓名为空' });
        return false;
      }
      if (seen.has(row.username)) {
        result.failed.push({ row: row.rowNumber, reason: 'Excel中学号重复' });
        return false;
      }
      seen.add(row.username);
      return true;
    });
    const existingCount = db.prepare('SELECT COUNT(*) count FROM course_students WHERE course_id=?').get(courseId).count;
    db.prepare(`UPDATE course_students
      SET sort_order = COALESCE(sort_order, id) + ?
      WHERE course_id=?`).run(orderedRows.length + existingCount, courseId);
    orderedRows.forEach((row, index) => {
      const { username, name } = row;
      let user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
      if (user?.role === 'teacher') return result.failed.push({ row: row.rowNumber, reason: '该账号为教师账号' });
      if (!user) {
        const info = db.prepare(`INSERT INTO users(username,password_hash,name,role) VALUES(?,?,?,'student')`).run(username, bcrypt.hashSync('123456', 10), name);
        user = { id: info.lastInsertRowid };
        result.created++;
      }
      const sortOrder = index + 1;
      const membership = db.prepare('SELECT id FROM course_students WHERE course_id=? AND student_id=?').get(courseId, user.id);
      if (membership) {
        db.prepare('UPDATE course_students SET sort_order=? WHERE id=?').run(sortOrder, membership.id);
        result.duplicated++;
      } else {
        db.prepare('INSERT INTO course_students(course_id,student_id,sort_order) VALUES(?,?,?)').run(courseId, user.id, sortOrder);
        result.joined++;
      }
    });
  });
  run();
  return result;
}
