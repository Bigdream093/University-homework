import { Router } from 'express'
import { db } from '../db.js'
import { auth } from '../middleware/auth.js'
import { teacherOnly } from '../middleware/teacher.js'
import { assignmentAccess, courseAccess, fail, textValue } from '../services/access.js'
import {
  submissionAccess,
  teacherRows,
  teacherRowsForStudent,
} from '../services/submissionQueries.js'
import { nowText } from '../utils/time.js'
const router = Router()
router.get('/assignments/:id/submissions', auth, teacherOnly, (req, res) => {
  let rows = teacherRows(assignmentAccess(req.params.id, req.user)),
    keyword = String(req.query.keyword || '').toLowerCase()
  if (keyword)
    rows = rows.filter((row) =>
      [
        row.name,
        row.username,
        ...(row.members || []).flatMap((member) => [member.name, member.username]),
      ]
        .join(' ')
        .toLowerCase()
        .includes(keyword),
    )
  const statusFilter = req.query.status
  if (statusFilter === 'unsubmitted') rows = rows.filter((row) => !row.id)
  else if (statusFilter === 'late') rows = rows.filter((row) => row.is_late === 1)
  else if (statusFilter) rows = rows.filter((row) => row.id && row.status === statusFilter)
  res.json(rows)
})
for (const [prefix, group] of [
  ['submissions', false],
  ['group-submissions', true],
]) {
  router.post('/' + prefix + '/:id/grade', auth, teacherOnly, (req, res) => {
    const { row, a: assignment, table } = submissionAccess(req.params.id, req.user, group, true),
      score = Number(req.body.score)
    if (!Number.isFinite(score) || score < 0 || score > assignment.total_score)
      fail(400, '成绩超出作业分值范围')
    db.prepare(
      `UPDATE ${table} SET score=?,comment=?,status='graded',returned_reason=NULL,graded_at=? WHERE id=?`,
    ).run(score, textValue(req.body.comment, '评语', 10000, false), nowText(), row.id)
    res.json({ message: '批改已保存' })
  })
  router.post('/' + prefix + '/:id/return', auth, teacherOnly, (req, res) => {
    const { row, table } = submissionAccess(req.params.id, req.user, group, true)
    db.prepare(
      `UPDATE ${table} SET status='returned',returned_reason=?,score=NULL,comment=NULL,graded_at=NULL WHERE id=?`,
    ).run(textValue(req.body.returned_reason, '退回原因', 2000), row.id)
    res.json({ message: '已退回，提交次数限制保持不变' })
  })
}
router.get('/courses/:id/students/:sid/submissions', auth, teacherOnly, (req, res) => {
  const course = courseAccess(req.params.id, req.user),
    studentId = Number(req.params.sid)
  if (!Number.isSafeInteger(studentId) || studentId < 1) fail(400, '无效的学生编号')
  res.json(teacherRowsForStudent(course.id, studentId))
})
export default router
