import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { db } from '../db.js'
import { config } from '../config.js'
import { assignmentAccess, courseAccess, fail, idValue, subjectFor, textValue } from './access.js'
import {
  allowedUploadName,
  fileExtension,
  PREVIEW_MAX_BYTES,
  previewExtensions,
  safeName,
} from '../utils/fileFilter.js'
import { nowText } from '../utils/time.js'
import { promoteUpload, queueCleanup } from './storage.js'
import { normalizeStorageKey, resolveUploadPath, toStorageKey } from '../utils/uploadPath.js'
import { preparePreview } from './previewService.js'
import { saveSubmission } from './submissionLogic.js'
import { studentView } from './submissionQueries.js'
import { saveMaterialSession } from './materialService.js'

const CHUNK_BYTES = 8 * 1024 * 1024
const DISK_RESERVE_BYTES = 256 * 1024 * 1024
const activeFiles = new Set()
const future = () => db.prepare("SELECT datetime('now','+08:00','+24 hours') value").get().value
const sessionDirectory = (id) => path.join(config.uploadDir, '.staging', 'sessions', id)

function ensureDiskSpace(directory, needed) {
  const stat = fs.statfsSync(directory, { bigint: true }),
    available = stat.bavail * stat.bsize
  if (available < BigInt(needed) + BigInt(DISK_RESERVE_BYTES))
    throw Object.assign(
      new Error('服务器存储空间不足，上传进度已保留，请联系管理员清理空间后继续'),
      { status: 507, expose: true },
    )
}

function sessionFiles(id) {
  return db
    .prepare(
      'SELECT id,file_role,sort_order,original_name,declared_size,uploaded_bytes,mime_type,state FROM upload_session_files WHERE session_id=? ORDER BY sort_order,id',
    )
    .all(id)
}
function view(row) {
  return { ...row, metadata: JSON.parse(row.metadata_json || '{}'), files: sessionFiles(row.id) }
}
function owned(id, user) {
  const row = db
    .prepare('SELECT * FROM upload_sessions WHERE id=? AND actor_id=?')
    .get(String(id || ''), user.id)
  if (!row) fail(404, '上传会话不存在')
  if (row.expires_at <= nowText()) fail(410, '上传会话已过期，请重新开始')
  return row
}
function targetWhere(item) {
  if (item.kind === 'submission')
    return ['kind=? AND assignment_id=?', ['submission', item.assignmentId]]
  if (item.mode === 'update') return ['kind=? AND material_id=?', ['material', item.materialId]]
  return ['kind=? AND course_id=? AND mode=?', ['material', item.courseId, 'create']]
}
function discardActive(actor, item) {
  const [where, args] = targetWhere(item),
    rows = db
      .prepare(
        `SELECT id FROM upload_sessions WHERE actor_id=? AND ${where} AND state IN ('uploading','completing')`,
      )
      .all(actor, ...args)
  for (const row of rows) {
    const paths = db
      .prepare('SELECT temporary_path FROM upload_session_files WHERE session_id=?')
      .all(row.id)
      .map((file) => file.temporary_path)
    db.prepare('DELETE FROM upload_sessions WHERE id=?').run(row.id)
    queueCleanup(paths, '放弃的分片上传')
  }
}
function cleanName(value) {
  const name = safeName(String(value || ''))
  if (!name || name.length > 255) fail(400, '文件名无效')
  return name
}
function declaredFiles(list) {
  if (!Array.isArray(list) || list.length > 11) fail(400, '上传文件清单无效')
  const ids = new Set()
  return list.map((file, index) => {
    const clientId = String(file.client_id || '')
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(clientId) || ids.has(clientId)) fail(400, '文件编号无效')
    ids.add(clientId)
    const size = Number(file.size)
    if (!Number.isSafeInteger(size) || size < 1) fail(400, '文件大小无效')
    return {
      clientId,
      role: String(file.role || ''),
      name: cleanName(file.name),
      size,
      order: Number.isSafeInteger(Number(file.order)) ? Number(file.order) : index,
      mime: String(file.mime || '').slice(0, 200),
    }
  })
}
function validateSubmission(payload, user, files) {
  if (user.role !== 'student') fail(403, '仅学生可提交作业')
  const assignment = assignmentAccess(payload.assignment_id, user, { write: true })
  if (assignment.status !== 'published') fail(400, '作业已关闭')
  subjectFor(assignment, user, { submit: true })
  const source = files.filter((file) => file.role === 'source'),
    previews = files.filter((file) => file.role === 'preview')
  if (files.some((file) => !['source', 'preview'].includes(file.role)) || source.length > 1)
    fail(400, '作业文件清单无效')
  if (assignment.type !== 'online' && source.length !== 1) fail(400, '本作业需要上传一个源文件')
  if (
    source[0] &&
    (source[0].size > (assignment.max_file_mb ?? 200) * 1024 * 1024 ||
      !allowedUploadName(source[0].name, {
        extensions: assignment.allowed_extensions?.split(',') || null,
      }))
  )
    fail(400, '源文件不符合当前作业要求')
  if (
    assignment.require_preview_image &&
    (previews.length < 1 || previews.length > Number(assignment.preview_max_count ?? 3))
  )
    fail(400, `预览图需要上传 1-${assignment.preview_max_count ?? 3} 张`)
  if (!assignment.require_preview_image && previews.length) fail(400, '本作业不要求预览图')
  if (
    previews.some(
      (file) => file.size > PREVIEW_MAX_BYTES || !previewExtensions.has(fileExtension(file.name)),
    )
  )
    fail(400, '预览图必须为不超过20M的 JPG/PNG')
  return {
    kind: 'submission',
    assignmentId: assignment.id,
    baseVersion: Number(payload.base_version ?? 0),
    metadata: { content: String(payload.metadata?.content || '') },
  }
}
function validateMaterial(payload, user, files) {
  if (user.role !== 'teacher') fail(403, '仅教师可上传课程资料')
  const mode = payload.mode === 'update' ? 'update' : 'create'
  let courseId,
    materialId = null
  if (mode === 'update') {
    materialId = idValue(payload.material_id)
    const material = db.prepare('SELECT course_id FROM materials WHERE id=?').get(materialId)
    if (!material) fail(404, '资料不存在')
    courseAccess(material.course_id, user, { write: true, teacher: true })
    courseId = material.course_id
  } else {
    courseId = courseAccess(payload.course_id, user, { write: true, teacher: true }).id
  }
  if (files.length !== 1 || files[0].role !== 'file') fail(400, '请选择一个课程资料文件')
  if (
    files[0].size > config.materialUploadMaxMb * 1024 * 1024 ||
    !allowedUploadName(files[0].name, { material: true })
  )
    fail(400, '课程资料文件不符合上传要求')
  return {
    kind: 'material',
    mode,
    courseId,
    materialId,
    metadata: {
      title: textValue(payload.metadata?.title, '资料标题', 200),
      description: textValue(payload.metadata?.description, '资料说明', 20000, false),
    },
  }
}

export function createUploadSession(payload, user) {
  if (!['submission', 'material'].includes(String(payload.kind))) fail(400, '上传类型无效')
  const files = declaredFiles(payload.files),
    item =
      String(payload.kind) === 'submission'
        ? validateSubmission(payload, user, files)
        : validateMaterial(payload, user, files)
  const id = randomUUID(),
    root = path.join(config.uploadDir, '.staging', 'sessions'),
    directory = sessionDirectory(id)
  fs.mkdirSync(root, { recursive: true })
  ensureDiskSpace(
    root,
    files.reduce((sum, file) => sum + file.size, 0),
  )
  fs.mkdirSync(directory)
  try {
    db.transaction(() => {
      discardActive(user.id, item)
      const at = nowText()
      db.prepare(
        `INSERT INTO upload_sessions(id,actor_id,kind,assignment_id,course_id,material_id,mode,metadata_json,base_version,state,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,'uploading',?,?,?)`,
      ).run(
        id,
        user.id,
        item.kind,
        item.assignmentId || null,
        item.courseId || null,
        item.materialId,
        item.mode || null,
        JSON.stringify(item.metadata),
        item.baseVersion || 0,
        at,
        at,
        future(),
      )
      const insert = db.prepare(
        "INSERT INTO upload_session_files(id,session_id,file_role,sort_order,original_name,declared_size,uploaded_bytes,mime_type,temporary_path,state) VALUES(?,?,?,?,?,?,0,?,?,'uploading')",
      )
      for (const file of files) {
        const fileId = randomUUID(),
          target = path.join(directory, fileId)
        fs.writeFileSync(target, '', { flag: 'wx' })
        insert.run(
          fileId,
          id,
          file.role,
          file.order,
          file.name,
          file.size,
          file.mime,
          toStorageKey(target),
        )
      }
    })()
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true })
    throw error
  }
  return view(db.prepare('SELECT * FROM upload_sessions WHERE id=?').get(id))
}

export function getUploadSession(id, user) {
  return view(owned(id, user))
}

export async function writeChunk({ sessionId, fileId, user, range, chunkHash, stream }) {
  const initial = owned(sessionId, user)
  if (initial.state !== 'uploading') fail(409, '上传会话当前不可写入')
  if (activeFiles.has(fileId)) fail(409, '该分片正在写入，请稍后重试')
  activeFiles.add(fileId)
  let incoming
  try {
    const file = db
      .prepare('SELECT * FROM upload_session_files WHERE id=? AND session_id=?')
      .get(fileId, initial.id)
    if (!file) fail(404, '上传文件不存在')
    // temporary_path 在库内保存为相对存储键；写入分片前解析回本机绝对路径。
    const filePath = resolveUploadPath(file.temporary_path)
    if (!filePath) fail(410, '上传临时文件丢失，请取消后重新开始上传')
    const match = String(range || '').match(/^bytes (\d+)-(\d+)\/(\d+)$/)
    if (!match) fail(400, 'Content-Range 无效')
    const start = Number(match[1]),
      end = Number(match[2]),
      total = Number(match[3]),
      length = end - start + 1
    if (total !== file.declared_size || length < 1 || length > CHUNK_BYTES || end >= total)
      fail(400, '分片范围无效')
    if (!/^[a-f0-9]{64}$/i.test(String(chunkHash || ''))) fail(400, '分片摘要无效')
    ensureDiskSpace(path.dirname(filePath), length)
    const stat = await fs.promises.stat(filePath)
    if (stat.size > file.uploaded_bytes) await fs.promises.truncate(filePath, file.uploaded_bytes)
    if (stat.size < file.uploaded_bytes) fail(410, '上传临时文件不完整，请取消后重新开始上传')
    const duplicate =
      start === file.last_chunk_offset &&
      length === file.last_chunk_length &&
      String(chunkHash).toLowerCase() === file.last_chunk_sha256
    if (start !== file.uploaded_bytes && !duplicate)
      fail(409, `上传位置已变化，请从 ${file.uploaded_bytes} 继续`)
    incoming = `${filePath}.${randomUUID()}.chunk`
    let bytes = 0
    const hash = createHash('sha256')
    const meter = new Transform({
      transform(chunk, _encoding, done) {
        bytes += chunk.length
        if (bytes > length)
          return done(Object.assign(new Error('分片超过声明大小'), { status: 400 }))
        hash.update(chunk)
        done(null, chunk)
      },
    })
    await pipeline(stream, meter, fs.createWriteStream(incoming, { flags: 'wx' }))
    const digest = hash.digest('hex')
    if (bytes !== length || digest !== String(chunkHash).toLowerCase())
      fail(400, '分片长度或摘要不一致')
    if (duplicate) {
      await fs.promises.rm(incoming, { force: true })
      return { uploaded_bytes: file.uploaded_bytes, replayed: true }
    }
    try {
      await pipeline(fs.createReadStream(incoming), fs.createWriteStream(filePath, { flags: 'a' }))
    } catch (error) {
      await fs.promises.truncate(filePath, start)
      throw error
    }
    const uploaded = end + 1,
      state = uploaded === total ? 'uploaded' : 'uploading'
    const changed = db
      .prepare(
        'UPDATE upload_session_files SET uploaded_bytes=?,last_chunk_offset=?,last_chunk_length=?,last_chunk_sha256=?,state=? WHERE id=? AND uploaded_bytes=?',
      )
      .run(uploaded, start, length, digest, state, file.id, start).changes
    if (!changed) {
      await fs.promises.truncate(filePath, start)
      fail(409, '上传位置已变化，请查询后继续')
    }
    db.prepare('UPDATE upload_sessions SET updated_at=?,expires_at=? WHERE id=?').run(
      nowText(),
      future(),
      initial.id,
    )
    return { uploaded_bytes: uploaded, state }
  } finally {
    activeFiles.delete(fileId)
    if (incoming) await fs.promises.rm(incoming, { force: true }).catch(() => {})
  }
}

function metadataFor(session, override) {
  const current = JSON.parse(session.metadata_json || '{}'),
    value = { ...current, ...(override || {}) }
  if (session.kind === 'submission') return { content: String(value.content || '') }
  return {
    title: textValue(value.title, '资料标题', 200),
    description: textValue(value.description, '资料说明', 20000, false),
  }
}
function storedFile(row) {
  const stored = resolveUploadPath(row.temporary_path) || ''
  return {
    path: stored,
    storageKey: normalizeStorageKey(row.temporary_path),
    originalname: row.original_name,
    size: row.declared_size,
    mimetype: row.mime_type || undefined,
  }
}

export async function completeUploadSession(id, user, metadata) {
  let session = owned(id, user)
  if (session.state === 'succeeded') return JSON.parse(session.result_json)
  if (session.state === 'failed') fail(410, session.last_error || '上传会话已失败，请重新提交')
  if (session.state !== 'uploading') fail(409, '上传会话正在处理或已经结束')
  const files = db
    .prepare('SELECT * FROM upload_session_files WHERE session_id=? ORDER BY sort_order,id')
    .all(session.id)
  if (files.some((file) => file.uploaded_bytes !== file.declared_size))
    fail(409, '文件尚未全部上传')
  // Complete 时重新走创建校验，确保老师中途修改要求后仍按最新规则执行。
  const declared = files.map((file, index) => ({
    clientId: file.id,
    role: file.file_role,
    name: file.original_name,
    size: file.declared_size,
    order: index,
    mime: file.mime_type,
  }))
  if (session.kind === 'submission')
    validateSubmission(
      {
        assignment_id: session.assignment_id,
        base_version: session.base_version,
        metadata,
        files: [],
      },
      user,
      declared,
    )
  else
    validateMaterial(
      {
        mode: session.mode,
        course_id: session.course_id,
        material_id: session.material_id,
        metadata,
        files: [],
      },
      user,
      declared,
    )
  const finalMetadata = metadataFor(session, metadata)
  db.prepare(
    "UPDATE upload_sessions SET state='completing',metadata_json=?,updated_at=? WHERE id=?",
  ).run(JSON.stringify(finalMetadata), nowText(), session.id)
  const promoted = [],
    generated = []
  try {
    for (const row of files) {
      if (row.state !== 'ready') {
        const file = storedFile(row)
        promoteUpload(file, `${session.kind}/${session.assignment_id || session.course_id}`)
        row.temporary_path = file.storageKey
        row.state = 'ready'
        promoted.push(file.storageKey)
        db.prepare("UPDATE upload_session_files SET temporary_path=?,state='ready' WHERE id=?").run(
          file.storageKey,
          row.id,
        )
      }
    }
    const finish = (result) =>
      db
        .prepare(
          "UPDATE upload_sessions SET state='succeeded',result_json=?,last_error=NULL,completed_at=?,updated_at=? WHERE id=?",
        )
        .run(
          JSON.stringify(session.kind === 'submission' ? studentView(result) : result),
          nowText(),
          nowText(),
          session.id,
        )
    let result
    if (session.kind === 'submission') {
      const source = files.find((file) => file.file_role === 'source')
      const previewRows = files.filter((file) => file.file_role === 'preview')
      const previews = []
      for (const row of previewRows) {
        const preview = await preparePreview(storedFile(row))
        previews.push(preview)
        if (preview.thumbnailPath) generated.push(preview.thumbnailPath)
      }
      result = studentView(
        saveSubmission({
          assignment: { id: session.assignment_id },
          studentId: user.id,
          sourceFile: source ? storedFile(source) : null,
          previewFiles: previews,
          content: finalMetadata.content,
          baseVersion: session.base_version,
          afterSave: finish,
        }),
      )
    } else {
      result = saveMaterialSession({
        session,
        user,
        file: storedFile(files[0]),
        metadata: finalMetadata,
        onSaved: finish,
      })
    }
    fs.rmSync(sessionDirectory(session.id), { recursive: true, force: true })
    return result
  } catch (error) {
    if (error.status && error.status < 500) {
      db.prepare(
        "UPDATE upload_sessions SET state='failed',last_error=?,updated_at=? WHERE id=?",
      ).run(error.message, nowText(), session.id)
      queueCleanup([...promoted, ...generated], '分片上传终检失败')
      fs.rmSync(sessionDirectory(session.id), { recursive: true, force: true })
    } else
      db.prepare(
        "UPDATE upload_sessions SET state='uploading',last_error=?,updated_at=? WHERE id=?",
      ).run('服务器处理失败，可重试', nowText(), session.id)
    throw error
  }
}

export function cancelUploadSession(id, user) {
  const session = owned(id, user)
  if (session.state === 'succeeded') fail(409, '已完成的上传不能取消')
  const paths = db
    .prepare('SELECT temporary_path FROM upload_session_files WHERE session_id=?')
    .all(session.id)
    .map((file) => file.temporary_path)
  db.prepare('DELETE FROM upload_sessions WHERE id=?').run(session.id)
  queueCleanup(paths, '取消分片上传')
  fs.rmSync(sessionDirectory(session.id), { recursive: true, force: true })
  return { cancelled: true }
}

export function purgeUploadSessions() {
  const rows = db
    .prepare(
      "SELECT id FROM upload_sessions WHERE expires_at<=datetime('now','+08:00') AND state<>'succeeded'",
    )
    .all()
  for (const row of rows) {
    const paths = db
      .prepare('SELECT temporary_path FROM upload_session_files WHERE session_id=?')
      .all(row.id)
      .map((file) => file.temporary_path)
    db.prepare('DELETE FROM upload_sessions WHERE id=?').run(row.id)
    queueCleanup(paths, '过期分片上传')
    fs.rmSync(sessionDirectory(row.id), { recursive: true, force: true })
  }
  db.prepare(
    "DELETE FROM upload_sessions WHERE state IN ('succeeded','failed','cancelled') AND updated_at<=datetime('now','+08:00','-7 days')",
  ).run()
  return rows.length
}

export function recoverUploadSessions() {
  db.prepare(
    "UPDATE upload_sessions SET state='uploading',last_error='服务器已重启，可继续完成上传' WHERE state='completing'",
  ).run()
  purgeUploadSessions()
}
