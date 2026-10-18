import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { db, randomInvite } from '../db.js'
import { config } from '../config.js'
import { LIMITS } from '@university-homework/domain/limits'
import { auth } from '../middleware/auth.js'
import { teacherOnly } from '../middleware/teacher.js'
import { courseAccess, textValue, fail } from '../services/access.js'
import { executeOperation, operationStatus } from '../services/operations.js'
import { queueCleanup } from '../services/storage.js'
import { resolveUploadPath, toStorageKey } from '../utils/uploadPath.js'
import { nowText } from '../utils/time.js'
import { imageIds } from '../domain/richText.js'
import { storedFilename } from '../utils/storedFilename.js'
const router = Router()
router.post('/courses/:id/copy', auth, teacherOnly, async (req, res) => {
  const course = courseAccess(req.params.id, req.user)
  const name = textValue(req.body.name, '新课程名称', LIMITS.courseName),
    code = textValue(req.body.code, '课程代码', LIMITS.courseCode, false)
  const materials =
    req.body.include_materials === false
      ? []
      : db.prepare('SELECT * FROM materials WHERE course_id=? ORDER BY id').all(course.id)
  const assignments =
    req.body.include_assignments === false
      ? []
      : db.prepare('SELECT * FROM assignments WHERE course_id=?').all(course.id)
  const referencedImageIds = new Set(
    assignments
      .filter((assignment) => assignment.description_format === 'html')
      .flatMap((assignment) => [...imageIds(assignment.description)]),
  )
  const imageIdsToCopy = [...referencedImageIds]
  const imageCopies = imageIdsToCopy.length
    ? db
        .prepare(
          `SELECT * FROM editor_images WHERE id IN (${imageIdsToCopy.map(() => '?').join(',')})`,
        )
        .all(...imageIdsToCopy)
        .map((image) => ({ image, id: randomUUID() }))
    : []
  const staged = [],
    renamed = [],
    stagedImages = [],
    renamedImages = []
  let temporaryDirectory = null
  try {
    const result = await executeOperation(
      req,
      'course-copy',
      course.id,
      () => {
        const at = nowText()
        const newCourseId = db
          .prepare(
            'INSERT INTO courses(name,code,description,teacher_id,invite_code,daily_ratio,final_ratio,grade_absent_mode,created_at,copied_from_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            name,
            code,
            course.description,
            req.user.id,
            randomInvite(),
            course.daily_ratio ?? 40,
            course.final_ratio ?? 60,
            course.grade_absent_mode || 'zero',
            at,
            course.id,
          ).lastInsertRowid
        const directory = path.join(config.uploadDir, 'copies', String(newCourseId))
        if (stagedImages.length || staged.length) fs.mkdirSync(directory, { recursive: true })
        if (stagedImages.length) {
          for (const item of stagedImages) {
            const target = path.join(directory, storedFilename(item.staged, item.id))
            fs.renameSync(item.staged, target)
            renamedImages.push(target)
            db.prepare(
              'INSERT INTO editor_images(id,course_id,uploader_id,file_url) VALUES(?,?,?,?)',
            ).run(item.id, newCourseId, req.user.id, toStorageKey(target))
          }
        }
        for (const source of assignments) {
          let description = source.description
          for (const item of imageCopies)
            description = description.replaceAll(
              `/api/editor-images/${item.image.id}`,
              `/api/editor-images/${item.id}`,
            )
          db.prepare(
            "INSERT INTO assignments(course_id,title,description,type,total_score,allow_resubmit_count,submission_mode,max_file_mb,work_mode,group_submit_policy,allowed_extensions,require_preview_image,preview_max_count,description_format,required_answer,grade_weight,is_final,status,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?)",
          ).run(
            newCourseId,
            source.title,
            description,
            source.type,
            source.total_score,
            source.allow_resubmit_count,
            source.submission_mode,
            source.max_file_mb,
            source.work_mode,
            source.group_submit_policy,
            source.allowed_extensions,
            Number(source.require_preview_image ?? 0),
            Number(source.preview_max_count ?? 3),
            source.description_format,
            source.required_answer,
            source.grade_weight ?? 0,
            Number(source.is_final ?? 0),
            source.sort_order,
            at,
            at,
          )
        }
        if (staged.length) {
          for (const item of staged) {
            const target = path.join(directory, storedFilename(item.staged))
            fs.renameSync(item.staged, target)
            renamed.push(target)
            db.prepare(
              'INSERT INTO materials(course_id,teacher_id,title,description,file_url,file_name,file_size,file_type,created_at,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?)',
            ).run(
              newCourseId,
              req.user.id,
              item.material.title,
              item.material.description,
              toStorageKey(target),
              item.material.file_name,
              item.material.file_size,
              item.material.file_type,
              at,
              item.material.sort_order,
            )
          }
        }
        return { id: newCourseId, message: '课程复制成功；作业均为草稿，学生和历史数据未复制' }
      },
      () => {
        // 阶段一：附件复制放在数据库事务之外执行，避免长时间占用写锁阻塞其他请求。
        for (const original of materials) {
          const source = resolveUploadPath(original.file_url, { mustExist: true })
          if (!source) fail(409, '原课程有缺失的资料，请修复后再复制')
          if (!temporaryDirectory) {
            temporaryDirectory = path.join(config.uploadDir, 'copies-tmp', randomUUID())
            fs.mkdirSync(temporaryDirectory, { recursive: true })
          }
          const target = path.join(temporaryDirectory, storedFilename(source))
          fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
          staged.push({ material: original, staged: target })
        }
        for (const { image, id } of imageCopies) {
          const source = resolveUploadPath(image.file_url, { mustExist: true })
          if (!source) fail(409, '原课程有缺失的正文图片，请修复后再复制')
          if (!temporaryDirectory) {
            temporaryDirectory = path.join(config.uploadDir, 'copies-tmp', randomUUID())
            fs.mkdirSync(temporaryDirectory, { recursive: true })
          }
          const target = path.join(temporaryDirectory, storedFilename(source, id))
          fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
          stagedImages.push({ id, staged: target })
        }
      },
    )
    res.status(result.replayed ? 200 : 201).json(result)
  } catch (error) {
    const leftovers = [
      ...staged.map((item) => item.staged),
      ...stagedImages.map((item) => item.staged),
      ...renamed,
      ...renamedImages,
    ]
    if (leftovers.length) queueCleanup(leftovers, '复制课程失败')
    if (temporaryDirectory)
      try {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true })
      } catch {}
    throw error
  }
})
router.get('/courses/:id/copy-status/:key', auth, teacherOnly, (req, res) => {
  const course = courseAccess(req.params.id, req.user)
  res.json(operationStatus(req.user.id, 'course-copy', course.id, req.params.key))
})
export default router
