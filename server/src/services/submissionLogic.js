import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { db } from '../db.js'
import { nowText, isLate } from '../utils/time.js'
import { safeName } from '../utils/fileFilter.js'
import { assignmentAccess, subjectFor, fail } from './access.js'
import { effectiveDeadline } from './extensions.js'
import { queueCleanup } from './storage.js'

export function saveSubmission({
  assignment,
  studentId,
  sourceFile,
  previewFiles = [],
  content,
  baseVersion,
  afterSave,
}) {
  const result = db.transaction(() => {
    const student = db
      .prepare("SELECT id,username,name,role FROM users WHERE id=? AND role='student'")
      .get(studentId)
    if (!student) fail(404, '学生账号不存在')
    const currentAssignment = assignmentAccess(assignment.id, student, { write: true })
    if (currentAssignment.status !== 'published') fail(400, '作业当前不可提交')
    const subject = subjectFor(currentAssignment, student, { submit: true }),
      group = !!subject.group
    const table = group ? 'group_submissions' : 'submissions',
      historyTable = group ? 'group_submission_history' : 'submission_history'
    const foreign = group ? 'group_submission_id' : 'submission_id'
    const file = sourceFile,
      previews = (previewFiles || []).slice()
    const current = group
      ? db
          .prepare('SELECT * FROM group_submissions WHERE assignment_group_id=?')
          .get(subject.group.id)
      : db
          .prepare('SELECT * FROM submissions WHERE assignment_id=? AND student_id=?')
          .get(currentAssignment.id, studentId)
    // 乐观并发控制：个人与小组（含 append 模式）统一以 submit_count 为版本号，旧页面提交一律 409。
    const version = Number(baseVersion ?? 0)
    if (!Number.isSafeInteger(version) || version < 0) fail(400, '提交版本无效，请刷新页面后重试')
    if (version !== (current?.submit_count || 0))
      fail(
        409,
        group
          ? '本组已有更新，请刷新后确认再提交'
          : '本次作业已有新的提交记录，请刷新页面确认后再提交',
      )
    // 次数耗尽后仅"退回重做"状态额外放行一次；重新提交后状态恢复 submitted，额外机会自动消耗。
    const exhausted =
      current &&
      currentAssignment.allow_resubmit_count !== -1 &&
      current.submit_count >= currentAssignment.allow_resubmit_count + 1
    if (exhausted && current.status !== 'returned') fail(400, '已达到允许提交次数')
    const answer = String(content ?? '').trim()
    if (!file && !answer) fail(400, '请上传文件或填写在线作答内容')
    // 文件类作业必须携带文件：否则一段文字就会在覆盖模式下顶掉并删除已提交的文件。
    if (currentAssignment.type !== 'online' && !file) fail(400, '本作业需要上传文件提交')
    if (file && file.size > (currentAssignment.max_file_mb ?? 200) * 1024 * 1024)
      fail(400, '文件超过本作业大小限制')
    // 预览图规则：要求时必交且数量 1..N；未要求时不接受。
    if (currentAssignment.type === 'online' && previews.length)
      fail(400, '在线作答作业不接受预览图')
    if (currentAssignment.require_preview_image) {
      if (!previews.length) fail(400, '本作业要求另交图片预览，请至少上传 1 张')
      const max = Number(currentAssignment.preview_max_count ?? 3)
      if (previews.length > max) fail(400, `预览图最多 ${max} 张`)
    } else if (previews.length) fail(400, '本作业不要求预览图')
    const at = nowText(),
      deadline = effectiveDeadline(currentAssignment, subject),
      late = isLate(deadline.deadline, at)
    const [date, time] = at.split(' '),
      stamp = date.slice(5) + '-' + time.slice(0, 5)
    const owner = group ? subject.group.name : student.name
    const name = file
      ? `${safeName(owner)}_${safeName(student.username)}_${stamp}_${late ? '迟交' : '准时'}${path.extname(file.originalname).toLowerCase()}`
      : null
    // 库内只保存相对存储键；file.path 仅供本次请求内的文件系统操作使用。
    const values = [
      answer || null,
      file?.storageKey || null,
      name,
      file?.size ?? null,
      file ? path.extname(file.originalname).slice(1).toLowerCase() : null,
    ]
    let id = current?.id
    if (current) {
      if (currentAssignment.submission_mode !== 'append') {
        const replaced = db
          .prepare(
            `SELECT file_url FROM ${historyTable} WHERE ${foreign}=? AND file_state='available'`,
          )
          .all(id)
        const oldPreviews = db
          .prepare(
            `SELECT p.id,p.file_url,p.thumbnail_url FROM submission_preview_images p JOIN ${historyTable} h ON p.${group ? 'group_submission_history_id' : 'submission_history_id'}=h.id WHERE h.${foreign}=? AND p.file_state='available'`,
          )
          .all(id)
        queueCleanup(
          [
            ...replaced.map((row) => row.file_url),
            current.file_url,
            ...oldPreviews.flatMap((row) => [row.file_url, row.thumbnail_url].filter(Boolean)),
          ],
          '覆盖提交的旧文件',
        )
        db.prepare(
          `UPDATE ${historyTable} SET file_state='replaced',replaced_at=? WHERE ${foreign}=? AND file_state='available'`,
        ).run(at, id)
        if (oldPreviews.length)
          db.prepare(
            `UPDATE submission_preview_images SET file_state='replaced',replaced_at=? WHERE id IN (${oldPreviews.map(() => '?').join(',')})`,
          ).run(at, ...oldPreviews.map((row) => row.id))
      }
      db.prepare(
        `UPDATE ${table} SET content=?,file_url=?,file_name=?,file_size=?,file_type=?,submit_count=submit_count+1,status='submitted',score=NULL,comment=NULL,returned_reason=NULL,is_late=?,submitted_at=?,graded_at=NULL${group ? ',submitted_by=?' : ''} WHERE id=?`,
      ).run(...values, late, at, ...(group ? [studentId] : []), id)
    } else {
      const sql = group
        ? "INSERT INTO group_submissions(assignment_group_id,content,file_url,file_name,file_size,file_type,submit_count,status,is_late,submitted_at,submitted_by) VALUES(?,?,?,?,?,?,1,'submitted',?,?,?)"
        : "INSERT INTO submissions(assignment_id,student_id,content,file_url,file_name,file_size,file_type,submit_count,status,is_late,submitted_at) VALUES(?,?,?,?,?,?,?,1,'submitted',?,?)"
      id = db
        .prepare(sql)
        .run(
          ...(group ? [subject.group.id] : [currentAssignment.id, studentId]),
          ...values,
          late,
          at,
          ...(group ? [studentId] : []),
        ).lastInsertRowid
    }
    const history = db
      .prepare(
        `INSERT INTO ${historyTable}(${foreign},content,file_url,file_name,file_size,file_type,file_state,is_late,submitted_at${group ? ',submitted_by' : ''}) VALUES(?,?,?,?,?,?,?,?,?${group ? ',?' : ''})`,
      )
      .run(id, ...values, file ? 'available' : 'online', late, at, ...(group ? [studentId] : []))
    const historyId = history.lastInsertRowid
    previews.forEach((preview, index) => {
      db.prepare(
        `INSERT INTO submission_preview_images(${group ? 'group_submission_history_id' : 'submission_history_id'},file_url,thumbnail_url,original_name,file_size,mime_type,width,height,sha256,sort_order,file_state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,'available',?)`,
      ).run(
        historyId,
        preview.storageKey,
        preview.thumbnailKey || null,
        safeName(preview.originalname),
        preview.size,
        preview.image?.mime || preview.mimetype || 'image/png',
        preview.image?.width ?? null,
        preview.image?.height ?? null,
        preview.sha256,
        index,
        at,
      )
    })
    const members = group
      ? db
          .prepare(
            'SELECT student_id,username_snapshot username,name_snapshot name FROM assignment_group_members WHERE assignment_group_id=? ORDER BY student_id',
          )
          .all(subject.group.id)
      : null
    const previewSnapshot = previews.map((preview, index) => ({
      name: safeName(preview.originalname),
      size: preview.size,
      sha256: preview.sha256,
      order: index,
    }))
    const snapshot = {
      course_id: currentAssignment.course_id,
      course_name: currentAssignment.course_name,
      assignment_title: currentAssignment.title,
      work_mode: currentAssignment.work_mode,
      student: { username: student.username, name: student.name },
      group: group ? { id: subject.group.id, name: subject.group.name, members } : null,
      file_name: name,
      file_size: file?.size ?? null,
      file_type: values[4],
      file_state: file ? 'available' : 'online',
      preview_count: previewSnapshot.length,
      previews: previewSnapshot,
      submitted_at: at,
      is_late: !!late,
      effective_deadline: deadline.deadline,
      extension: deadline.extension
        ? { id: deadline.extension.id, approved_deadline: deadline.extension.approved_deadline }
        : null,
      submit_count: (current?.submit_count || 0) + 1,
    }
    const receiptNo = 'MH-' + randomUUID()
    db.prepare(
      `INSERT INTO submission_receipts(receipt_no,${group ? 'group_submission_history_id' : 'submission_history_id'},assignment_id,${group ? 'assignment_group_id' : 'student_id'},snapshot_json,created_at) VALUES(?,?,?,?,?,?)`,
    ).run(
      receiptNo,
      historyId,
      currentAssignment.id,
      group ? subject.group.id : studentId,
      JSON.stringify(snapshot),
      at,
    )
    const submissionResult = {
      ...db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id),
      preview_count: previewSnapshot.length,
      receipt_no: receiptNo,
      kind: group ? 'group' : 'individual',
    }
    afterSave?.(submissionResult)
    return submissionResult
  })()
  return result
}
