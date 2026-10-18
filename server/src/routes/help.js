import fs from 'node:fs'
import { Router } from 'express'
import { auth } from '../middleware/auth.js'
import { buildInfo } from '../buildInfo.js'

const studentIndex = [
  {
    id: 'student-submit',
    title: '一、查看与提交作业',
    nav_title: '查看与提交作业',
    aliases: [
      'student-course',
      'login',
      'student-receipt',
      'student-group',
      'student-extension',
      'student-faq',
    ],
  },
  { id: 'student-notice', title: '二、通知', nav_title: '通知', aliases: [] },
  { id: 'student-material', title: '三、学习资料', nav_title: '学习资料', aliases: [] },
  { id: 'student-qa', title: '四、课程提问', nav_title: '课程提问', aliases: [] },
]

const teacherIndex = [
  {
    id: 'teacher-assignment',
    title: '一、作业管理',
    nav_title: '作业管理',
    aliases: ['teacher-grading', 'teacher-extension'],
  },
  { id: 'teacher-notice', title: '二、通知', nav_title: '通知', aliases: [] },
  { id: 'teacher-material', title: '三、学习资料', nav_title: '学习资料', aliases: [] },
  {
    id: 'teacher-course',
    title: '四、学生名单',
    nav_title: '学生名单',
    aliases: [],
  },
  { id: 'teacher-group', title: '五、分组', nav_title: '分组', aliases: [] },
  { id: 'teacher-qa', title: '六、课程问答', nav_title: '课程问答', aliases: [] },
  {
    id: 'teacher-summary',
    title: '七、成绩汇总',
    nav_title: '成绩汇总',
    aliases: ['teacher-archive'],
  },
  {
    id: 'maintenance',
    title: '八、GitHub 更新、绿联 NAS 部署与备份',
    nav_title: '更新与部署',
    aliases: [],
  },
]

const router = Router()

function chapters(role) {
  const teacher = role === 'teacher'
  const selected = teacher ? teacherIndex : studentIndex
  return selected.map((chapter) => ({
    ...chapter,
    format: teacher ? 'teacher-manual' : 'student-manual',
    body: fs.readFileSync(new URL('../../help/' + chapter.id + '.md', import.meta.url), 'utf8'),
    version: buildInfo.version,
  }))
}

router.get('/help/public', (req, res) => {
  const role = req.query.role === 'teacher' ? 'teacher' : 'student'
  res.json([
    {
      id: role + '-login',
      title: role === 'teacher' ? '登录与课程' : '登录说明',
      format: role + '-manual',
      version: buildInfo.version,
      body: fs.readFileSync(new URL('../../help/' + role + '-login.md', import.meta.url), 'utf8'),
    },
  ])
})
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
  const chapter = chapters(req.user.role).find(
    (item) => item.id === req.params.id || item.aliases?.includes(req.params.id),
  )
  if (!chapter) return res.status(404).json({ message: '没有这个帮助章节' })
  res.json(chapter)
})

export default router
