import { Router } from 'express'
import { db } from '../db.js'
import { auth } from '../middleware/auth.js'
import { teacherOnly } from '../middleware/teacher.js'
import { assignmentAccess, courseAccess, idValue, textValue } from '../services/access.js'
import {
  submissionAccess,
  absenceMarks,
  teacherRows,
  teacherRowsForStudent,
} from '../services/submissionQueries.js'
import { LIMITS, boundedInt } from '@university-homework/domain/limits'
import { mergeAbsenceMarks, submissionCounts } from '@university-homework/domain/gradingSummary'
import { parseGradeScore } from '@university-homework/domain/numbers'
import { nowText } from '../utils/time.js'
const router = Router()

router.get('/assignments/:id/submissions', auth, teacherOnly, (req, res) => {
  const assignment = assignmentAccess(req.params.id, req.user),
    allRows = mergeAbsenceMarks(teacherRows(assignment), absenceMarks(assignment.id)),
    summary = submissionCounts(allRows, assignment)
  let rows = allRows.slice(),
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
  const lateOnly = statusFilter === 'late' || req.query.late === '1' || req.query.late === 'true'
  if (statusFilter === 'unsubmitted') rows = rows.filter((row) => !row.id)
  else if (statusFilter === 'missingPreview')
    rows = rows.filter((row) => row.id && !(row.preview_count > 0))
  else if (statusFilter && statusFilter !== 'late')
    rows = rows.filter((row) => row.id && row.status === statusFilter)
  // 兼容旧客户端的 status=late，同时支持与批改状态组合筛选。
  if (lateOnly) rows = rows.filter((row) => row.id && row.is_late === 1)
  const page = boundedInt(req.query.page, 1, Number.MAX_SAFE_INTEGER),
    pageSize = boundedInt(req.query.page_size, LIMITS.defaultPageSize, LIMITS.maxPageSize)
  res.json({
    rows: rows.slice((page - 1) * pageSize, page * pageSize),
    total: rows.length,
    page,
    page_size: pageSize,
    counts: summary.counts,
    stats: summary.stats,
  })
})

const pendingReviewsSql = `
  SELECT pending.* FROM (
    SELECT s.id,'individual' kind,a.id assignment_id,a.title assignment_title,
      c.id course_id,c.name course_name,u.name,u.username,s.status,s.score,s.is_late,
      s.submitted_at,s.file_name,'' members,'/submissions/'||s.id api_base
    FROM submissions s JOIN assignments a ON a.id=s.assignment_id
    JOIN courses c ON c.id=a.course_id JOIN users u ON u.id=s.student_id
    WHERE c.teacher_id=? AND s.status='submitted' AND instr(u.name,'测试员')=0
    UNION ALL
    SELECT s.id,'group' kind,a.id assignment_id,a.title assignment_title,
      c.id course_id,c.name course_name,g.name,g.name username,s.status,s.score,s.is_late,
      s.submitted_at,s.file_name,
      COALESCE((SELECT group_concat(m.name_snapshot||'（'||m.username_snapshot||'）','、')
        FROM assignment_group_members m WHERE m.assignment_group_id=g.id),'') members,
      '/group-submissions/'||s.id api_base
    FROM group_submissions s JOIN assignment_groups g ON g.id=s.assignment_group_id
    JOIN assignments a ON a.id=g.assignment_id JOIN courses c ON c.id=a.course_id
    WHERE c.teacher_id=? AND s.status='submitted'
      AND EXISTS (SELECT 1 FROM assignment_group_members m
        WHERE m.assignment_group_id=g.id AND instr(m.name_snapshot,'测试员')=0)
  ) pending
  WHERE (? IS NULL OR course_id=?)
    AND (?='' OR instr(lower(course_name||' '||assignment_title||' '||name||' '||username||' '||members),?)>0)
`

router.get('/teacher/pending-reviews', auth, teacherOnly, (req, res) => {
  const page = boundedInt(req.query.page, 1, Number.MAX_SAFE_INTEGER),
    pageSize = boundedInt(req.query.page_size, LIMITS.defaultPageSize, LIMITS.maxPageSize),
    rawCourseId = req.query.course_id,
    courseId = rawCourseId ? idValue(rawCourseId, '课程编号无效') : null,
    keyword = String(req.query.keyword || '')
      .trim()
      .toLowerCase()
  const params = [req.user.id, req.user.id, courseId, courseId, keyword, keyword]
  const total = db.prepare(`SELECT count(*) total FROM (${pendingReviewsSql})`).get(...params).total
  const rows = db
    .prepare(`${pendingReviewsSql} ORDER BY submitted_at ASC,assignment_id,id LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize)
  res.json({ rows, total, page, page_size: pageSize })
})

function batchResultIdentity(item) {
  return item.id
    ? { id: idValue(item.id), kind: item.kind }
    : {
        id: null,
        kind: item.kind,
        student_id: item.student_id ? idValue(item.student_id) : null,
        assignment_group_id: item.assignment_group_id ? idValue(item.assignment_group_id) : null,
      }
}

function applyBatchItem(assignmentId, teacher, item, action, body) {
  const assignment = assignmentAccess(assignmentId, teacher, { write: true }),
    identity = batchResultIdentity(item),
    group = identity.kind === 'group'
  if (!['individual', 'group'].includes(identity.kind)) throw new Error('提交类型无效')
  if (group !== (assignment.work_mode === 'group')) throw new Error('提交类型与作业不匹配')

  if (identity.id) {
    const access = submissionAccess(identity.id, teacher, group, true)
    if (access.a.id !== assignment.id) throw new Error('提交记录不属于当前作业')
    if (
      item.expected_status !== undefined &&
      String(item.expected_status) !== String(access.row.status)
    )
      throw new Error('提交状态已变化，请刷新后重新批改')
    if (
      item.expected_submit_count !== undefined &&
      Number(item.expected_submit_count) !== Number(access.row.submit_count)
    )
      throw new Error('学生已重新提交，请刷新后再批改最新版本')
    if (access.row.status === 'returned') throw new Error('该作业已退回，等待学生重新提交后再批改')
    const editingExistingGrade = access.row.status === 'graded' && item.expected_status === 'graded'
    if (access.row.status !== 'submitted' && !editingExistingGrade)
      throw new Error('当前作业状态不支持此操作，请刷新后重试')
    if (action === 'grade') {
      const score = parseGradeScore(body.score, assignment.total_score)
      if (score === null) throw new Error(`成绩必须在 0 到 ${assignment.total_score} 之间`)
      db.prepare(
        `UPDATE ${access.table} SET score=?,comment=?,status='graded',returned_reason=NULL,graded_at=? WHERE id=?`,
      ).run(score, textValue(body.comment, '评语', LIMITS.comment, false), nowText(), access.row.id)
      return '批改已保存'
    }
    db.prepare(
      `UPDATE ${access.table} SET status='returned',returned_reason=?,score=NULL,comment=NULL,graded_at=NULL WHERE id=?`,
    ).run(textValue(body.returned_reason, '退回原因', LIMITS.reason), access.row.id)
    return '已退回'
  }

  if (action !== 'grade' || Number(body.score) !== 0) throw new Error('未交记录只能批量记 0 分')
  const markAt = nowText()
  if (group) {
    const target = db
      .prepare(
        'SELECT g.id FROM assignment_groups g WHERE g.id=? AND g.assignment_id=? AND EXISTS (SELECT 1 FROM assignment_group_members m WHERE m.assignment_group_id=g.id)',
      )
      .get(identity.assignment_group_id, assignment.id)
    if (!target) throw new Error('未交小组不属于当前作业')
    if (db.prepare('SELECT 1 FROM group_submissions WHERE assignment_group_id=?').get(target.id))
      throw new Error('该小组已有提交，请刷新后重试')
    db.prepare(
      `INSERT INTO absence_grade_marks(assignment_id,assignment_group_id,graded_by,graded_at)
       VALUES(?,?,?,?) ON CONFLICT(assignment_id,assignment_group_id) WHERE assignment_group_id IS NOT NULL
       DO UPDATE SET graded_by=excluded.graded_by,graded_at=excluded.graded_at`,
    ).run(assignment.id, target.id, teacher.id, markAt)
  } else {
    const target = db
      .prepare(
        `SELECT cs.student_id FROM course_students cs JOIN users u ON u.id=cs.student_id
         WHERE cs.course_id=? AND cs.student_id=? AND u.role='student'`,
      )
      .get(assignment.course_id, identity.student_id)
    if (!target) throw new Error('未交学生不属于当前课程')
    if (
      db
        .prepare('SELECT 1 FROM submissions WHERE assignment_id=? AND student_id=?')
        .get(assignment.id, target.student_id)
    )
      throw new Error('该学生已有提交，请刷新后重试')
    db.prepare(
      `INSERT INTO absence_grade_marks(assignment_id,student_id,graded_by,graded_at)
       VALUES(?,?,?,?) ON CONFLICT(assignment_id,student_id) WHERE student_id IS NOT NULL
       DO UPDATE SET graded_by=excluded.graded_by,graded_at=excluded.graded_at`,
    ).run(assignment.id, target.student_id, teacher.id, markAt)
  }
  return '未交已记 0 分'
}

for (const action of ['grade', 'return']) {
  router.post(`/assignments/:id/batch-${action}`, auth, teacherOnly, (req, res) => {
    const assignment = assignmentAccess(req.params.id, req.user, {
        write: true,
      }),
      items = req.body.items
    if (!Array.isArray(items) || !items.length || items.length > LIMITS.batchItems)
      return res.status(400).json({ message: `请选择 1 到 ${LIMITS.batchItems} 条记录` })
    const keys = items.map((item) => JSON.stringify(batchResultIdentity(item || {})))
    if (new Set(keys).size !== keys.length)
      return res.status(400).json({ message: '选择记录重复，请刷新后重试' })
    const results = items.map((item) => {
      const identity = batchResultIdentity(item || {})
      try {
        const message = db.transaction(() =>
          applyBatchItem(assignment.id, req.user, item || {}, action, req.body),
        )()
        return { ...identity, success: true, message }
      } catch (error) {
        return {
          ...identity,
          success: false,
          message: error.message || '处理失败',
        }
      }
    })
    res.json({
      results,
      success_count: results.filter((result) => result.success).length,
      failure_count: results.filter((result) => !result.success).length,
    })
  })
}
router.get('/courses/:id/students/:sid/submissions', auth, teacherOnly, (req, res) => {
  const course = courseAccess(req.params.id, req.user),
    studentId = idValue(req.params.sid)
  const assignmentId =
    req.query.assignment_id === undefined ? null : idValue(req.query.assignment_id)
  res.json(teacherRowsForStudent(course.id, studentId, assignmentId))
})
export default router
