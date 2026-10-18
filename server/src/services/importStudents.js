import ExcelJS from 'exceljs'
import bcrypt from 'bcryptjs'
import { db } from '../db.js'
import { reactivateDetachedStudent } from './studentAccounts.js'
import { fail } from './access.js'

export async function importStudents(buffer, courseId) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  const sheet = workbook.worksheets[0]
  if (!sheet) fail(400, 'Excel中没有可读取的工作表')
  const rows = []
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber > 1)
      rows.push({
        rowNumber,
        username: String(row.getCell(1).text || '').trim(),
        name: String(row.getCell(2).text || '').trim(),
      })
  })
  const result = { created: 0, joined: 0, duplicated: 0, reactivated: 0, failed: [] }
  const seen = new Set()
  const orderedRows = rows.filter((row) => {
    if (!row.username || !row.name) {
      result.failed.push({ row: row.rowNumber, reason: '学号或姓名为空' })
      return false
    }
    if (seen.has(row.username)) {
      result.failed.push({ row: row.rowNumber, reason: 'Excel中学号重复' })
      return false
    }
    seen.add(row.username)
    return true
  })
  const courseStatus = db.prepare('SELECT status FROM courses WHERE id=?').get(courseId)?.status
  if (courseStatus !== 'active') fail(409, '课程已归档或不存在')
  const passwordHashes = new Map()
  await Promise.all(
    orderedRows.map(async (row) => {
      const user = db.prepare('SELECT * FROM users WHERE username=?').get(row.username)
      if (!user || (user.role === 'student' && user.status === 'disabled'))
        passwordHashes.set(row.username, await bcrypt.hash('123456', 10))
    }),
  )
  db.transaction(() => {
    if (db.prepare('SELECT status FROM courses WHERE id=?').get(courseId)?.status !== 'active')
      fail(409, '课程已归档或不存在')
    const existingCount = db
      .prepare('SELECT COUNT(*) count FROM course_students WHERE course_id=?')
      .get(courseId).count
    db.prepare(
      `UPDATE course_students
      SET sort_order = COALESCE(sort_order, id) + ?
      WHERE course_id=?`,
    ).run(orderedRows.length + existingCount, courseId)
    orderedRows.forEach((row, index) => {
      const { username, name } = row
      let user = db.prepare('SELECT * FROM users WHERE username=?').get(username)
      if (user?.role === 'teacher')
        return result.failed.push({ row: row.rowNumber, reason: '该账号为教师账号' })
      if (!user) {
        const passwordHash = passwordHashes.get(username)
        if (!passwordHash) fail(409, '账号状态已变化，请重新导入')
        const info = db
          .prepare(
            "INSERT INTO users(username,password_hash,name,role,created_at) VALUES(?,?,?,'student',datetime('now','+08:00'))",
          )
          .run(username, passwordHash, name)
        user = { id: info.lastInsertRowid }
        result.created++
      }
      const sortOrder = index + 1
      const membership = db
        .prepare('SELECT id FROM course_students WHERE course_id=? AND student_id=?')
        .get(courseId, user.id)
      if (
        !membership &&
        user.status === 'disabled' &&
        reactivateDetachedStudent(user, passwordHashes.get(username))
      ) {
        user.status = 'active'
        result.reactivated++
      }
      if (membership) {
        db.prepare('UPDATE course_students SET sort_order=? WHERE id=?').run(
          sortOrder,
          membership.id,
        )
        result.duplicated++
      } else {
        db.prepare(
          "INSERT INTO course_students(course_id,student_id,sort_order,joined_at) VALUES(?,?,?,datetime('now','+08:00'))",
        ).run(courseId, user.id, sortOrder)
        result.joined++
      }
    })
  })()
  return result
}
