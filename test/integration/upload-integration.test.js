import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { effectScope } from 'vue'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mohen-frontend-upload-'))
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'frontend-upload-isolated-test'
process.env.DATA_DIR = directory
process.env.UPLOAD_DIR = path.join(directory, 'uploads')
process.env.TZ = 'Asia/Shanghai'
const { app } = await import('../../server/src/index.js')
const { db } = await import('../../server/src/db.js')
const { resolveUploadPath } = await import('../../server/src/utils/uploadPath.js')
const server = app.listen(0, '127.0.0.1')
await new Promise((resolve) => server.once('listening', resolve))
const baseURL = `http://127.0.0.1:${server.address().port}/api`

function storage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    get size() { return values.size },
  }
}
const originals = new Map(['localStorage', 'sessionStorage'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
for (const name of originals.keys()) {
  Object.defineProperty(globalThis, name, { value: storage(), configurable: true })
}
const { default: api } = await import('../../web/src/api/request.js')
const { useChunkedUpload } = await import('../../web/src/composables/useChunkedUpload.js')
api.defaults.baseURL = baseURL
const scope = effectScope()
after(async () => {
  scope.stop()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  db.close()
  fs.rmSync(directory, { recursive: true, force: true })
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})

const login = (await api.post('/auth/login', { username: 'teacher', password: '123456' })).data
localStorage.setItem('hw_token', login.token)
localStorage.setItem('hw_user', JSON.stringify(login.user))
const course = (await api.post('/courses', { name: '隔离上传测试' })).data

test('前端分片上传 → 真实服务端保存 → 下载：跨 8MB 分片字节完全一致', async () => {
  const transfer = scope.run(() => useChunkedUpload())
  const content = Buffer.alloc(8 * 1024 * 1024 + 123, 42)
  const file = new File([content], 'fixture.zip', { type: 'application/zip', lastModified: 123 })
  const result = await transfer.run({
    kind: 'material', target: { mode: 'create', course_id: course.id },
    metadata: { title: '跨分片资料' },
    files: [{ role: 'file', file, order: 0 }],
  })
  assert.equal(transfer.busy.value, false)
  assert.equal(transfer.pending.value, false)
  assert.equal(transfer.percent.value, 100)
  assert.equal(sessionStorage.size, 0)
  const materials = (await api.get(`/courses/${course.id}/materials`)).data
  assert.equal(materials.length, 1)
  assert.ok(result)
  const downloaded = await api.get(`/materials/${materials[0].id}/file`, { responseType: 'arraybuffer' })
  assert.deepEqual(Buffer.from(downloaded.data), content)
})

test('分片上传：首片落盘后暂停，恢复从已确认偏移继续且不重复创建资料', async () => {
  const transfer = scope.run(() => useChunkedUpload())
  const chunkSize = 8 * 1024 * 1024
  const content = Buffer.concat([Buffer.alloc(chunkSize, 65), Buffer.alloc(123, 66)])
  const file = new File([content], 'resume.zip', { lastModified: 123 })
  const args = {
    kind: 'material', target: { mode: 'create', course_id: course.id },
    metadata: { title: '暂停恢复资料' }, files: [{ role: 'file', file }],
  }
  const ranges = []
  const originalPut = api.put
  let confirmedFile
  // 只在真实 HTTP 首片响应返回后暂停，所有分片仍通过原 Axios 客户端上传。
  api.put = async function (url, data, config) {
    if (url.endsWith('/chunk')) ranges.push(config.headers['Content-Range'])
    const response = await originalPut.call(this, url, data, config)
    if (url.endsWith('/chunk') && !confirmedFile) {
      const fileId = url.split('/files/')[1].split('/')[0]
      confirmedFile = db.prepare('SELECT * FROM upload_session_files WHERE id=?').get(fileId)
      transfer.pause()
    }
    return response
  }
  try {
    const pending = transfer.run(args)
    const paused = assert.rejects(pending, (error) => error.code === 'UPLOAD_PAUSED')
    await assert.rejects(transfer.run(args), /当前上传尚未结束/)
    await paused
    assert.ok(confirmedFile)
    assert.equal(confirmedFile.uploaded_bytes, chunkSize)
    assert.deepEqual(fs.readFileSync(resolveUploadPath(confirmedFile.temporary_path)), content.subarray(0, chunkSize))
    assert.deepEqual(ranges, [`bytes 0-${chunkSize - 1}/${content.length}`])
    assert.equal(transfer.busy.value, false)
    assert.equal(sessionStorage.size, 1)
    const remote = (await api.get(`/upload-sessions/${confirmedFile.session_id}`)).data
    assert.equal(remote.files[0].uploaded_bytes, chunkSize)
    await transfer.run(args)
    assert.deepEqual(ranges, [
      `bytes 0-${chunkSize - 1}/${content.length}`,
      `bytes ${chunkSize}-${content.length - 1}/${content.length}`,
    ], '恢复必须从首片末尾继续，不得重新发送已确认分片')
    assert.equal(sessionStorage.size, 0)
    const materials = (await api.get(`/courses/${course.id}/materials`)).data
      .filter((material) => material.title === '暂停恢复资料')
    assert.equal(materials.length, 1)
    const downloaded = await api.get(`/materials/${materials[0].id}/file`, { responseType: 'arraybuffer' })
    assert.deepEqual(Buffer.from(downloaded.data), content)
  } finally {
    api.put = originalPut
  }
})

test('分片上传：立即暂停后取消清除客户端缓存，不产生资料记录', async () => {
  const transfer = scope.run(() => useChunkedUpload())
  const pending = transfer.run({
    kind: 'material', target: { mode: 'create', course_id: course.id },
    metadata: { title: '取消资料' },
    files: [{ role: 'file', file: new File(['cancel'], 'cancel.zip') }],
  })
  transfer.pause()
  await assert.rejects(pending, (error) => error.code === 'UPLOAD_PAUSED')
  await transfer.cancel()
  assert.equal(sessionStorage.size, 0)
  assert.equal(transfer.pending.value, false)
  const materials = (await api.get(`/courses/${course.id}/materials`)).data
  assert.equal(materials.filter((material) => material.title === '取消资料').length, 0)
})
