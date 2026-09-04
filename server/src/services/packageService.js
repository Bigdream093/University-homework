import path from 'node:path'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { db } from '../db.js'
import { config } from '../config.js'
import { safeName } from '../utils/fileFilter.js'
import { resolveUploadPath } from '../utils/uploadPath.js'
import { pipeZipToResponse, writeZipFile } from '../utils/zipStream.js'
import { fail } from './access.js'
import { submissionAccess } from './submissionQueries.js'

function histories({ assignmentId, submissionId, group }) {
  if (group)
    return db
      .prepare(
        `SELECT h.id history_id,h.group_submission_id submission_id,h.file_url,h.file_name,h.content,h.submitted_at,h.is_late,g.name,g.name username
    FROM group_submission_history h JOIN group_submissions s ON s.id=h.group_submission_id
    JOIN assignment_groups g ON g.id=s.assignment_group_id
    WHERE ${submissionId ? 's.id=?' : 'g.assignment_id=?'} AND h.file_state IN ('available','online') ORDER BY g.id,h.id`,
      )
      .all(submissionId || assignmentId)
  return db
    .prepare(
      `SELECT h.id history_id,h.submission_id,h.file_url,h.file_name,h.content,h.submitted_at,h.is_late,u.name,u.username
    FROM submission_history h JOIN submissions s ON s.id=h.submission_id JOIN users u ON u.id=s.student_id
    WHERE ${submissionId ? 's.id=?' : 's.assignment_id=?'} AND h.file_state IN ('available','online') ORDER BY u.username,h.id`,
    )
    .all(submissionId || assignmentId)
}

function previews(rows, group) {
  if (!rows.length) return new Map()
  const ids = rows.map((row) => row.history_id),
    marks = ids.map(() => '?').join(','),
    foreign = group ? 'group_submission_history_id' : 'submission_history_id'
  const found = db
    .prepare(
      `SELECT ${foreign} history_id,file_url,original_name,sort_order FROM submission_preview_images WHERE ${foreign} IN (${marks}) AND file_state='available' ORDER BY ${foreign},sort_order,id`,
    )
    .all(...ids)
  const result = new Map()
  for (const image of found) {
    const list = result.get(image.history_id) || []
    list.push(image)
    result.set(image.history_id, list)
  }
  return result
}

function archiveEntries(rows, group, withOwnerFolder) {
  const images = previews(rows, group),
    versions = new Map(),
    used = new Set(),
    missing = [],
    entries = []
  const unique = (name) => {
    const ext = path.extname(name),
      stem = name.slice(0, name.length - ext.length)
    let candidate = name,
      index = 2
    while (used.has(candidate.toLowerCase())) candidate = `${stem} (${index++})${ext}`
    used.add(candidate.toLowerCase())
    return candidate
  }
  for (const row of rows) {
    const version = (versions.get(row.submission_id) || 0) + 1
    versions.set(row.submission_id, version)
    const owner = withOwnerFolder ? `${safeName(row.name)}_${safeName(row.username)}/` : ''
    const stamp = String(row.submitted_at || '')
      .replaceAll(':', '-')
      .replace(' ', '_')
    const folder = `${owner}第${String(version).padStart(2, '0')}次_${stamp}_${row.is_late ? '迟交' : '准时'}/`
    if (row.file_url) {
      const file = resolveUploadPath(row.file_url, { mustExist: true })
      if (file)
        entries.push({
          name: unique(folder + '附件/' + safeName(row.file_name || path.basename(file))),
          path: file,
        })
      else missing.push(`${row.name} ${row.username}：${row.file_name || '附件'} 不存在`)
    } else if (row.content) {
      entries.push({ name: unique(folder + '在线作答.txt'), content: row.content })
    }
    for (const image of images.get(row.history_id) || []) {
      const file = resolveUploadPath(image.file_url, { mustExist: true })
      const name = `${String(image.sort_order + 1).padStart(2, '0')}_${safeName(image.original_name)}`
      if (file) entries.push({ name: unique(folder + '照片/' + name), path: file })
      else missing.push(`${row.name} ${row.username}：照片 ${image.original_name} 不存在`)
    }
  }
  if (missing.length)
    entries.push({
      name: unique('下载说明.txt'),
      content: '以下文件未能加入压缩包：\n' + missing.join('\n'),
    })
  return entries
}

const buildingPackages = new Map(),
  packageDir = path.join(config.dataDir, 'download-cache')
function packagePath(requestId, signature) {
  const hash = createHash('sha256').update(signature).digest('hex').slice(0, 16)
  return path.join(packageDir, `${requestId}-${hash}.zip`)
}
function prunePackageCache() {
  fs.mkdirSync(packageDir, { recursive: true })
  const expires = Date.now() - 24 * 60 * 60 * 1000
  for (const file of fs.readdirSync(packageDir)) {
    const target = path.join(packageDir, file)
    try {
      if (fs.statSync(target).mtimeMs < expires) fs.rmSync(target, { force: true })
    } catch {}
  }
}
async function preparedPackage(entries, requestId, signature) {
  prunePackageCache()
  const target = packagePath(requestId, signature)
  if (fs.existsSync(target)) return target
  if (!buildingPackages.has(target)) {
    const temporary = `${target}.building`
    fs.rmSync(temporary, { force: true })
    buildingPackages.set(
      target,
      writeZipFile(entries, temporary)
        .then(() => {
          fs.renameSync(temporary, target)
          return target
        })
        .finally(() => buildingPackages.delete(target)),
    )
  }
  return buildingPackages.get(target)
}
async function send(entries, name, res, signature) {
  if (!entries.length) fail(400, '还没有学生提交作业')
  const requestId = String(res.req?.get?.('X-Download-Request-Id') || '')
  if (/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) {
    const file = await preparedPackage(entries, requestId, signature)
    return new Promise((resolve, reject) =>
      res.download(file, name, (error) => (error ? reject(error) : resolve())),
    )
  }
  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
  await pipeZipToResponse(entries, res)
}

export async function downloadAssignmentPackage(assignmentId, teacherId, res) {
  const assignment = db
    .prepare(
      'SELECT a.* FROM assignments a JOIN courses c ON c.id=a.course_id WHERE a.id=? AND c.teacher_id=?',
    )
    .get(assignmentId, teacherId)
  if (!assignment) fail(404, '作业不存在')
  const group = assignment.work_mode === 'group'
  await send(
    archiveEntries(histories({ assignmentId, group }), group, true),
    `${assignment.title}-全部作业.zip`,
    res,
    `assignment:${assignment.id}:teacher:${teacherId}`,
  )
}

export async function downloadSubmissionPackage(submissionId, user, group, res) {
  const { row, a } = submissionAccess(submissionId, user, group)
  if (user.role !== 'teacher') fail(403, '仅教师可打包下载')
  const rows = histories({ submissionId: row.id, group })
  await send(
    archiveEntries(rows, group, false),
    `${a.title}-${rows[0]?.name || '作业'}.zip`,
    res,
    `${group ? 'group-' : ''}submission:${row.id}:teacher:${user.id}`,
  )
}
