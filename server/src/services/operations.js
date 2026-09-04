import fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { db } from '../db.js'
import { nowText } from '../utils/time.js'
import { fail, assignmentAccess, subjectFor, courseAccess } from './access.js'
import { queueCleanup, promoteUpload, processCleanupBatch } from './storage.js'

// 标识当前进程：服务重启后据此判定哪些 processing 记录属于已消失的旧进程。
const processOwner = randomUUID()
export function requestKey(req) {
  const key = req.get('Idempotency-Key') || randomUUID()
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key)) fail(400, '无效的上传请求编号')
  return key
}
export async function fingerprint(body, file, previews = []) {
  const digestOf = async (staged) => {
    if (!staged) return null
    let digest = ''
    if (/^[a-f0-9]{64}$/.test(staged.sha256 || '')) digest = staged.sha256
    else {
      const hash = createHash('sha256')
      for await (const chunk of fs.createReadStream(staged.path)) hash.update(chunk)
      digest = hash.digest('hex')
    }
    return { digest, name: staged.originalname, size: staged.size }
  }
  const source = await digestOf(file)
  const previewList = []
  for (const [index, preview] of previews.entries())
    previewList.push({ ...(await digestOf(preview)), order: index })
  const values = Object.keys(body || {})
    .sort()
    .map((key) => [key, typeof body[key] === 'string' ? body[key].trim() : body[key]])
  return createHash('sha256')
    .update(JSON.stringify({ values, source, previews: previewList }))
    .digest('hex')
}
// prepare 在数据库事务之外先执行（如流式复制大文件，避免长时间占用写锁阻塞其他请求）；action 与成功结果在同一事务内原子提交。
export async function executeOperation(req, kind, targetId, action, prepare) {
  const key = requestKey(req)
  const previewFiles = req.stagedPreviews || []
  const hash = await fingerprint(req.body, req.file, previewFiles),
    at = nowText()
  const find = () =>
    db
      .prepare(
        'SELECT * FROM operation_requests WHERE actor_id=? AND kind=? AND target_id=? AND request_id=?',
      )
      .get(req.user.id, kind, targetId, key)
  if (kind === 'submission') {
    const assignment = assignmentAccess(targetId, req.user, { write: true })
    if (assignment.status !== 'published') fail(400, '作业已关闭')
    subjectFor(assignment, req.user, { submit: true })
  }
  if (kind === 'material-create') courseAccess(targetId, req.user, { write: true, teacher: true })
  if (kind === 'material-update') {
    const material = db.prepare('SELECT course_id FROM materials WHERE id=?').get(targetId)
    if (!material) fail(404, '资料不存在')
    courseAccess(material.course_id, req.user, { write: true, teacher: true })
  }
  const old = find()
  if (old?.fingerprint && old.fingerprint !== hash)
    fail(409, '同一请求编号不能用于不同的内容，请开始新提交')
  const allStaged = [req.file, ...previewFiles].filter(Boolean)
  if (old?.state === 'succeeded') {
    if (allStaged.length) {
      queueCleanup(
        [
          ...allStaged.map((file) => file.path),
          ...previewFiles.flatMap((preview) =>
            preview.thumbnailPath ? [preview.thumbnailPath] : [],
          ),
        ],
        '重复上传',
      )
    }
    return { ...JSON.parse(old.result_json), replayed: true }
  }
  if (old?.state === 'processing') fail(409, '请求仍在处理中，请稍后查询结果')
  db.prepare(
    `INSERT INTO operation_requests(actor_id,kind,target_id,request_id,fingerprint,state,file_path,owner,created_at,updated_at) VALUES(?,?,?,?,?,'processing',?,?,?,?)
   ON CONFLICT(actor_id,kind,target_id,request_id) DO UPDATE SET state='processing',file_path=excluded.file_path,owner=excluded.owner,error=NULL,updated_at=excluded.updated_at`,
  ).run(req.user.id, kind, targetId, key, hash, req.file?.storageKey || null, processOwner, at, at)
  try {
    if (req.file) {
      promoteUpload(req.file, kind + '/' + targetId)
      db.prepare('UPDATE operation_requests SET file_path=? WHERE id=?').run(
        req.file.storageKey,
        find().id,
      )
    }
    // 预览图同样转正到持久目录；缩略图已在 previews 目录，不转正只登记失败清理。
    for (const preview of previewFiles) promoteUpload(preview, kind + '/' + targetId)
    let prepared
    if (prepare) prepared = await prepare()
    // 业务写入与成功结果在同一事务内一起提交。
    const result = db.transaction(() => {
      const data = action(prepared)
      db.prepare(
        "UPDATE operation_requests SET state='succeeded',result_json=?,file_path=NULL,updated_at=? WHERE id=?",
      ).run(JSON.stringify(data), nowText(), find().id)
      return data
    })()
    return result
  } catch (error) {
    db.prepare(
      "UPDATE operation_requests SET state='failed',error=?,file_path=NULL,updated_at=? WHERE id=?",
    ).run(
      error.status && error.status < 500 ? error.message : '处理失败，请联系管理员或安全重试',
      nowText(),
      find().id,
    )
    if (allStaged.length) {
      queueCleanup(
        [
          ...allStaged.map((file) => file.path),
          ...previewFiles.flatMap((preview) =>
            preview.thumbnailPath ? [preview.thumbnailPath] : [],
          ),
        ],
        '失败的上传',
      )
    }
    throw error
  }
}
export function recoverOperations() {
  for (const row of db
    .prepare(
      "SELECT * FROM operation_requests WHERE state='processing' AND (owner IS NULL OR owner<>?)",
    )
    .all(processOwner)) {
    queueCleanup([row.file_path], '进程中断的未完成请求')
    db.prepare(
      "UPDATE operation_requests SET state='failed',error='服务器曾重新启动，请安全重试',file_path=NULL,updated_at=? WHERE id=?",
    ).run(nowText(), row.id)
  }
  processCleanupBatch()
}
export function operationStatus(actor, kind, target, key) {
  const row = db
    .prepare(
      'SELECT state,result_json,error FROM operation_requests WHERE actor_id=? AND kind=? AND target_id=? AND request_id=?',
    )
    .get(actor, kind, target, key)
  return row
    ? {
        state: row.state,
        result: row.result_json ? JSON.parse(row.result_json) : null,
        error: row.error,
      }
    : { state: 'unknown' }
}
