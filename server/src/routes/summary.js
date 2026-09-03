import { Router } from 'express'
import ExcelJS from 'exceljs'
import { auth } from '../middleware/auth.js'
import { teacherOnly } from '../middleware/teacher.js'
import { courseAccess } from '../services/access.js'
import { courseSummary, saveGradeConfig } from '../services/summaryService.js'
import { nowText } from '../utils/time.js'

const router = Router()

router.get('/courses/:id/summary', auth, teacherOnly, (req, res) => {
  const course = courseAccess(req.params.id, req.user)
  res.json(courseSummary(course))
})

router.put('/courses/:id/grade-config', auth, teacherOnly, (req, res) => {
  const course = courseAccess(req.params.id, req.user, { write: true })
  res.json({ message: '成绩设置已保存', config: saveGradeConfig(course, req.body) })
})

// 导出行序 = 学生名单原序（course_students.sort_order），与汇总页、学生名单页同一排序，不做任何重排。
router.get('/courses/:id/summary/export', auth, teacherOnly, async (req, res) => {
  const course = courseAccess(req.params.id, req.user)
  const { config, assignments, students } = courseSummary(course)
  const workbook = new ExcelJS.Workbook()

  const sheet = workbook.addWorksheet('成绩汇总')
  sheet.columns = [
    { header: '姓名', key: 'name', width: 14 },
    { header: '学号', key: 'username', width: 20 },
    { header: '平时成绩', key: 'daily', width: 12 },
    { header: '期末成绩', key: 'final', width: 12 },
    { header: '总成绩', key: 'total', width: 12 },
  ]
  for (const student of students) {
    sheet.addRow({
      name: student.name,
      username: student.username,
      daily: student.scores.daily_score ?? '—',
      final: student.scores.final_score ?? '—',
      total: student.scores.total_score ?? '—',
    })
  }
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF245B55' } }
  sheet.views = [{ state: 'frozen', ySplit: 1 }]

  const finalAssignment = assignments.find((assignment) => assignment.is_final === 1)
  const info = workbook.addWorksheet('计算说明')
  info.columns = [
    { header: '项目', key: 'item', width: 24 },
    { header: '内容', key: 'value', width: 60 },
  ]
  const rows = [
    ['导出时间', nowText()],
    ['成绩口径', '平时/期末/总成绩均为百分制，保留 1 位小数；每次作业按 得分÷满分×100 折算后乘以其占总成绩的百分比计入'],
    ['平时占比', `${config.daily_ratio}%`],
    ['期末占比', `${config.final_ratio}%`],
    [
      '期末作业',
      finalAssignment
        ? `${finalAssignment.title}（满分 ${finalAssignment.total_score}）`
        : '未指定，总成绩暂按平时成绩',
    ],
    [
      '未交/未评计入方式',
      config.grade_absent_mode === 'zero'
        ? '未交、已交未评、已退回均按 0 分计入'
        : '未评（待批改、已退回）不计入，未交、未安排仍按 0 分计入',
    ],
    ['期末未评分/未交时', '期末栏显示"—"，总成绩暂按平时成绩'],
    ['草稿作业', '不参与平时成绩计算'],
  ]
  for (const [item, value] of rows) info.addRow({ item, value })
  info.addRow({})
  info.addRow({ item: '平时作业（占总成绩 %）', value: '满分' })
  for (const assignment of assignments.filter((assignment) => assignment.is_final !== 1)) {
    info.addRow({
      item: `${assignment.title}${assignment.status === 'draft' ? '（草稿）' : ''} · 占总成绩 ${assignment.grade_weight}%`,
      value: `满分 ${assignment.total_score}`,
    })
  }
  info.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
  info.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF245B55' } }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(course.name + '-成绩汇总.xlsx')}`,
  )
  await workbook.xlsx.write(res)
  res.end()
})

export default router
