import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { effectScope } from 'vue'
import api from '../src/api/request.js'
import { useChunkedUpload } from '../src/composables/useChunkedUpload.js'

let scope, originals, methods, cache
beforeEach(() => {
  originals = new Map(
    ['localStorage', 'sessionStorage'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  )
  cache = new Map()
  const storage = {
    getItem: (key) => cache.get(key) ?? null,
    setItem: (key, value) => cache.set(key, String(value)),
    removeItem: (key) => cache.delete(key),
  }
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => JSON.stringify({ id: 7 }) },
  })
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage })
  methods = Object.fromEntries(['post', 'put', 'get', 'delete'].map((key) => [key, api[key]]))
  for (const key of Object.keys(methods))
    api[key] = async () => {
      throw Error('Unexpected HTTP ' + key)
    }
  scope = effectScope()
})
afterEach(() => {
  scope.stop()
  Object.assign(api, methods)
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete globalThis[key]
  }
})
const session = () => ({
  id: 'session-1',
  state: 'uploading',
  files: [{ id: 'file-1', file_role: 'source', sort_order: 0, uploaded_bytes: 0 }],
})
const args = () => ({
  kind: 'submission',
  target: { assignment_id: 1 },
  files: [{ role: 'source', file: new File(['once'], 'once.zip', { lastModified: 1 }) }],
})

test('分片完成响应丢失：重试查询已完成会话，不重建、不重传、不再次完成', async () => {
  const transfer = scope.run(() => useChunkedUpload()),
    config = args(),
    calls = []
  const result = { submit_count: 1, receipt_no: 'receipt-1' }
  api.post = async (url) => {
    calls.push(['post', url])
    if (url === '/upload-sessions') return { data: session() }
    if (url === '/upload-sessions/session-1/complete') throw Error('完成响应丢失')
    throw Error('Unexpected URL ' + url)
  }
  api.put = async (url) => {
    calls.push(['put', url])
    return { data: { uploaded_bytes: 4 } }
  }
  api.get = async (url) => {
    calls.push(['get', url])
    return { data: { ...session(), state: 'succeeded', result_json: JSON.stringify(result) } }
  }
  await assert.rejects(transfer.run(config), /完成响应丢失/)
  assert.equal(transfer.busy.value, false)
  assert.equal(transfer.pending.value, true)
  assert.equal(cache.size, 1)
  assert.deepEqual(await transfer.run(config), result)
  assert.deepEqual(calls, [
    ['post', '/upload-sessions'],
    ['put', '/upload-sessions/session-1/files/file-1/chunk'],
    ['post', '/upload-sessions/session-1/complete'],
    ['get', '/upload-sessions/session-1'],
  ])
  assert.equal(cache.size, 0)
  assert.equal(transfer.busy.value, false)
  assert.equal(transfer.pending.value, false)
})

test('立即暂停再取消：阻止重复运行，清除缓存并请求删除会话，不上传或完成', async () => {
  const transfer = scope.run(() => useChunkedUpload()),
    config = args(),
    calls = []
  let release
  api.post = (url) => {
    calls.push(['post', url])
    assert.equal(url, '/upload-sessions')
    return new Promise((resolve) => {
      release = () => resolve({ data: session() })
    })
  }
  api.delete = async (url) => {
    calls.push(['delete', url])
    return { data: {} }
  }
  const pending = transfer.run(config)
  const paused = assert.rejects(pending, (error) => error.code === 'UPLOAD_PAUSED')
  await assert.rejects(transfer.run(config), /当前上传尚未结束/)
  transfer.pause()
  release()
  await paused
  assert.equal(transfer.busy.value, false)
  assert.equal(cache.size, 1)
  await transfer.cancel()
  assert.deepEqual(calls, [
    ['post', '/upload-sessions'],
    ['delete', '/upload-sessions/session-1'],
  ])
  assert.equal(cache.size, 0)
  assert.equal(transfer.pending.value, false)
  assert.equal(transfer.state.value, '上传已取消')
})
