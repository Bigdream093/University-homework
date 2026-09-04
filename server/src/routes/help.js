import fs from 'node:fs'
import { Router } from 'express'
import { auth } from '../middleware/auth.js'
const index = [
  { id: 'login', title: '登录与密码', role: 'public' },
  { id: 'student-course', title: '学生：登录、加入课程与修改密码', role: 'student' },
  { id: 'student-notice', title: '学生：查看通知与未读提醒', role: 'student' },
  { id: 'student-material', title: '学生：查找与下载学习资料', role: 'student' },
  { id: 'student-submit', title: '学生：提交作业、上传进度与失败重试', role: 'student' },
  { id: 'student-receipt', title: '学生：提交历史与提交回执', role: 'student' },
  { id: 'student-group', title: '学生：分组作业', role: 'student' },
  { id: 'student-extension', title: '学生：申请延期', role: 'student' },
  { id: 'student-qa', title: '学生：课程提问与公开问答', role: 'student' },
  { id: 'student-faq', title: '学生：常见问题', role: 'student' },
  { id: 'teacher-course', title: '教师：创建课程与学生管理', role: 'teacher' },
  { id: 'teacher-assignment', title: '教师：发布个人作业', role: 'teacher' },
  { id: 'teacher-group', title: '教师：课程分组与分组作业', role: 'teacher' },
  { id: 'teacher-grading', title: '教师：批改、退回、下载与成绩导出', role: 'teacher' },
  { id: 'teacher-summary', title: '教师：成绩汇总、权重与总评导出', role: 'teacher' },
  { id: 'teacher-extension', title: '教师：审批延期申请', role: 'teacher' },
  { id: 'teacher-notice', title: '教师：发布通知与查看已读', role: 'teacher' },
  { id: 'teacher-material', title: '教师：学习资料与下载统计', role: 'teacher' },
  { id: 'teacher-qa', title: '教师：回复与管理课程问答', role: 'teacher' },
  { id: 'teacher-archive', title: '教师：归档、恢复与复制课程', role: 'teacher' },
  { id: 'maintenance', title: '教师：GitHub更新、绿联NAS部署与备份', role: 'teacher' },
]
const router = Router()
function chapters(role) {
  return index
    .filter((chapter) => chapter.role === 'public' || chapter.role === role)
    .map((chapter) => ({
      ...chapter,
      body: fs.readFileSync(new URL('../../help/' + chapter.id + '.md', import.meta.url), 'utf8'),
      version: '1.6.5',
    }))
}
router.get('/help/public', (_req, res) => res.json(chapters('public')))
router.get('/help', auth, (req, res) => {
  const keyword = String(req.query.q || '').toLowerCase()
  res.json(
    chapters(req.user.role).filter((chapter) =>
      (chapter.title + ' ' + chapter.body).toLowerCase().includes(keyword),
    ),
  )
})
router.get('/help/download', auth, (req, res) =>
  res
    .attachment('mohen-' + req.user.role + '-manual.md')
    .type('text/markdown; charset=utf-8')
    .send(
      chapters(req.user.role)
        .map((chapter) => chapter.body)
        .join('\n\n---\n\n'),
    ),
)
router.get('/help/:id', auth, (req, res) => {
  const chapter = chapters(req.user.role).find((item) => item.id === req.params.id)
  if (!chapter) return res.status(404).json({ message: '没有这个帮助章节' })
  res.json(chapter)
})
export default router
