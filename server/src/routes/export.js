import { Router } from 'express';
import ExcelJS from 'exceljs';
import { db } from '../db.js';
import { auth } from '../middleware/auth.js';
import { teacherOnly } from '../middleware/teacher.js';

const router = Router();
router.get('/assignments/:id/export', auth, teacherOnly, async (req, res) => {
  const assignment = db.prepare(`SELECT a.* FROM assignments a JOIN courses c ON c.id=a.course_id WHERE a.id=? AND c.teacher_id=?`).get(req.params.id, req.user.id);
  if (!assignment) return res.status(404).json({ message: '作业不存在' });
  const rows = db.prepare(`SELECT u.username,u.name,s.status,s.submitted_at,s.is_late,s.score,s.comment FROM course_students cs JOIN users u ON u.id=cs.student_id LEFT JOIN submissions s ON s.student_id=u.id AND s.assignment_id=? WHERE cs.course_id=? ORDER BY u.username`).all(assignment.id, assignment.course_id);
  const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('成绩表');
  sheet.columns = [
    { header:'学号',key:'username',width:18 },{ header:'姓名',key:'name',width:14 },{ header:'提交状态',key:'status',width:14 },
    { header:'提交时间',key:'submitted_at',width:22 },{ header:'是否超时',key:'late',width:12 },{ header:'成绩',key:'score',width:10 },{ header:'评语',key:'comment',width:36 }
  ];
  const statusMap = { submitted:'已提交',graded:'已评分',returned:'已退回' };
  rows.forEach(r => sheet.addRow({ ...r, status: statusMap[r.status] || '未提交', late: r.is_late ? '是' : '否' }));
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type:'pattern',pattern:'solid',fgColor:{argb:'FF245B55'} };
  sheet.views = [{ state:'frozen',ySplit:1 }];
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(assignment.title + '-成绩表.xlsx')}`);
  await workbook.xlsx.write(res); res.end();
});

export default router;
