import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { ref } from 'vue'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mohen-desktop-network-'))
const body = Buffer.alloc(128 * 1024, 97)
let healthStatus = 200
let healthBody = JSON.stringify({ ok: true })
const received = []
const server = http.createServer((request, response) => {
  received.push({ url: request.url, headers: request.headers })
  if (request.url === '/api/health') {
    response.writeHead(healthStatus, { 'Content-Type': 'application/json' })
    response.end(healthBody)
    return
  }
  if (request.method === 'POST') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end('{}')
    return
  }
  const offset = Number(request.headers.range?.match(/bytes=(\d+)-/)?.[1] || 0)
  response.writeHead(offset ? 206 : 200, {
    'Content-Length': body.length - offset,
    ETag: '"fixture-v1"',
    ...(offset ? { 'Content-Range': `bytes ${offset}-${body.length - 1}/${body.length}` } : {}),
  })
  response.write(body.subarray(offset, offset + 1024))
  if (request.headers['x-download-request-id'] === 'download-resume-0001' && !offset) return
  const timer = setTimeout(() => response.end(body.subarray(offset + 1024)), 60)
  response.on('close', () => clearTimeout(timer))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const serverUrl = `http://127.0.0.1:${server.address().port}`

// 主进程与 preload 均执行原源码；只替换 Electron 外壳，HTTP、文件读写和下载流为真实实现。
const mainPath = new URL('../../desktop/src/main.cjs', import.meta.url)
const require = createRequire(mainPath)
const progress = []
let onProgress = () => {}
const event = { sender: {
  id: 1,
  isDestroyed: () => false,
  send: (channel, view) => { progress.push(view); onProgress(view) },
} }
const module = { exports: {} }
runInNewContext(read(mainPath) + '\nmodule.exports = {testServer, writeSettings, saveDownloadFile, pauseDownload, resumeDownload, cancelDownload, dismissDownload, listDownloads};', {
  require: (name) => name === 'electron' ? {
    app: {
      getVersion: () => 'test',
      getPath: (kind) => path.join(directory, kind),
      setAppUserModelId() {},
      whenReady: () => ({ then() {} }),
      on() {},
    },
  } : require(name),
  module, URL, AbortController, fetch, setTimeout, clearTimeout, console,
})
const desktop = module.exports
desktop.writeSettings({ serverUrl })
after(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(directory, { recursive: true, force: true })
})
function read(filename) {
  return fs.readFileSync(filename, 'utf8')
}
function payload(requestId) {
  return { requestId, endpoint: '/api/materials/1/file', token: 'test-token', fileName: 'fixture.bin', fileSize: body.length }
}

test('桌面连接：真实 HTTP 健康检查、地址规范化与 User-Agent', async () => {
  const result = await desktop.testServer(serverUrl.replace('http://', '') + '/?ignored=1#hash')
  assert.equal(result.serverUrl, serverUrl)
  assert.equal(result.ok, true)
  assert.match(received.at(-1).headers['user-agent'], /KexuDesktop/)
})

test('桌面连接：服务端错误、无效健康响应和带密码地址均被拒绝', async () => {
  try {
    healthStatus = 503
    await assert.rejects(desktop.testServer(serverUrl), /503/)
    healthStatus = 200
    healthBody = '{"ok":false}'
    await assert.rejects(desktop.testServer(serverUrl), /健康检查未通过/)
    healthBody = '<html>proxy error</html>'
    await assert.rejects(desktop.testServer(serverUrl), /无法连接服务器/)
    await assert.rejects(desktop.testServer('http://user:password@127.0.0.1'), /不能包含账号或密码/)
    await assert.rejects(desktop.testServer(''), /请输入服务器地址/)
  } finally {
    healthStatus = 200
    healthBody = '{"ok":true}'
  }
})

test('桌面下载：真实传输字节、鉴权、落盘及完成清理', async () => {
  const result = await desktop.saveDownloadFile(event, payload('download-complete-001'))
  assert.equal(result.state, 'completed')
  assert.deepEqual(fs.readFileSync(path.join(directory, 'downloads', 'fixture.bin')), body)
  assert.equal(received.find((item) => item.url === '/api/materials/1/file').headers.authorization, 'Bearer test-token')
  assert.ok(progress.some((view) => view.state === 'downloading'))
  desktop.dismissDownload(event, result.requestId)
  assert.equal(desktop.listDownloads(event).length, 0)
  assert.ok(fs.existsSync(path.join(directory, 'downloads', 'fixture.bin')))
  assert.equal(fs.readdirSync(path.join(directory, 'downloads')).filter((name) => name.endsWith('.part')).length, 0)
})

test('桌面下载：暂停后 Range 续传，字节不重复、文件不覆盖', { timeout: 5000 }, async () => {
  const requestId = 'download-resume-0001'
  fs.mkdirSync(path.join(directory, 'downloads'), { recursive: true })
  fs.writeFileSync(path.join(directory, 'downloads', 'fixture.bin'), body)
  // 进度事件早于磁盘写入；必须在确有已落盘字节后暂停，才能验证 Range 分支。
  const temporaryPath = path.join(directory, 'downloads', `.fixture (2).bin.${requestId}.part`)
  const pauseTimer = setInterval(() => {
    if (fs.existsSync(temporaryPath) && fs.statSync(temporaryPath).size > 0) {
      clearInterval(pauseTimer)
      desktop.pauseDownload(event, requestId)
    }
  }, 5)
  let first
  try {
    first = await desktop.saveDownloadFile(event, payload(requestId))
  } finally {
    clearInterval(pauseTimer)
  }
  assert.equal(first.state, 'paused')
  const result = await desktop.resumeDownload(event, { requestId, token: 'refreshed-token' })
  assert.equal(result.state, 'completed')
  assert.ok(received.some((item) => item.headers.range && item.headers.authorization === 'Bearer refreshed-token'))
  assert.deepEqual(fs.readFileSync(path.join(directory, 'downloads', 'fixture (2).bin')), body)
  desktop.dismissDownload(event, requestId)
})

test('桌面下载：取消清理临时文件、跨窗口任务和外站下载被拒绝', async () => {
  const requestId = 'download-cancel-0001'
  onProgress = (view) => {
    if (view.requestId === requestId && view.state === 'downloading') {
      onProgress = () => {}
      setImmediate(() => desktop.cancelDownload(event, requestId))
    }
  }
  const result = await desktop.saveDownloadFile(event, payload(requestId))
  assert.equal(result.state, 'cancelled')
  assert.throws(() => desktop.dismissDownload({ sender: { id: 2 } }, requestId), /下载任务不存在/)
  desktop.dismissDownload(event, requestId)
  assert.equal(fs.readdirSync(path.join(directory, 'downloads')).filter((name) => name.endsWith('.part')).length, 0)
  await assert.rejects(desktop.saveDownloadFile(event, { ...payload('download-invalid-001'), endpoint: 'https://example.com/file' }), /下载地址无效/)
  await assert.rejects(desktop.saveDownloadFile(event, { ...payload('download-invalid-002'), token: '' }), /登录状态已失效/)
})

test('桌面 preload：真实桥接源码正确转发连接参数与进度订阅清理', async () => {
  const bridges = {}
  const listeners = new Map()
  runInNewContext(read(new URL('../../desktop/src/preload.cjs', import.meta.url)), {
    require: () => ({
      contextBridge: { exposeInMainWorld: (name, bridge) => { bridges[name] = bridge } },
      ipcRenderer: {
        invoke: (channel, value) => {
          assert.equal(channel, 'server:test')
          return desktop.testServer(value)
        },
        on: (channel, listener) => listeners.set(channel, listener),
        removeListener: (channel, listener) => {
          assert.equal(listeners.get(channel), listener)
          listeners.delete(channel)
        },
      },
    }),
  })
  assert.equal((await bridges.kexuDesktop.testServer(serverUrl)).ok, true)
  let observed
  const unsubscribe = bridges.mohenDesktop.onDownloadProgress((view) => { observed = view })
  const view = { requestId: 'test', state: 'paused' }
  listeners.get('download:progress')({}, view)
  assert.equal(observed, view)
  unsubscribe()
  assert.equal(listeners.size, 0)
})

test('前端下载模块 → preload → 主进程 → HTTP：任务完成与面板清理', async () => {
  const bridges = {}
  const listeners = new Map()
  runInNewContext(read(new URL('../../desktop/src/preload.cjs', import.meta.url)), {
    require: () => ({
      contextBridge: { exposeInMainWorld: (name, bridge) => { bridges[name] = bridge } },
      ipcRenderer: {
        invoke: async (channel, value) => {
          const handlers = {
            'download:save': desktop.saveDownloadFile,
            'download:list': desktop.listDownloads,
            'download:dismiss': desktop.dismissDownload,
          }
          assert.ok(handlers[channel], channel)
          return handlers[channel](event, value)
        },
        on: (channel, listener) => listeners.set(channel, listener),
        removeListener: (channel) => listeners.delete(channel),
      },
    }),
  })
  let dispose
  const messages = []
  const source = read(new URL('../src/composables/useDownload.js', import.meta.url))
    .replace(/^import .+$/gm, '').replace('export function', 'function')
  const useDownload = new Function(
    'ref', 'onMounted', 'onBeforeUnmount', 'ElMessage', 'api', 'messageOf', 'readToken', 'window',
    source + '\nreturn useDownload',
  )(
    ref, (callback) => callback(), (callback) => { dispose = callback },
    { info: (message) => messages.push(message), success: (message) => messages.push(message), error: (message) => assert.fail(message) },
    {}, (error) => error.message, () => 'front-end-token', bridges,
  )
  onProgress = (view) => listeners.get('download:progress')?.({}, view)
  try {
    const transfer = useDownload()
    await Promise.resolve()
    await transfer.start({ endpoint: '/api/materials/1/file', fileName: 'frontend.bin', fileSize: body.length })
    assert.equal(transfer.tasks.value.length, 1)
    assert.equal(transfer.tasks.value[0].state, 'completed')
    assert.deepEqual(fs.readFileSync(path.join(directory, 'downloads', 'frontend.bin')), body)
    await transfer.dismiss(transfer.tasks.value[0].requestId)
    assert.equal(transfer.tasks.value.length, 0)
    assert.ok(messages.includes('下载完成'))
  } finally {
    dispose?.()
    onProgress = () => {}
  }
  assert.equal(listeners.size, 0)
})

test('桌面设置页：连接按钮、Enter 保存与错误后恢复可操作', async () => {
  const nodes = new Map()
  function node(selector) {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: '', disabled: false, textContent: '', className: '', handlers: {},
      focus() {},
      addEventListener(name, handler) { this.handlers[name] = handler },
    })
    return nodes.get(selector)
  }
  let saves = 0
  runInNewContext(read(new URL('../../desktop/src/setup.js', import.meta.url)), {
    document: { querySelector: node },
    window: { kexuDesktop: {
      getSettings: async () => ({ productName: '墨痕学生端', role: 'student', version: 'test', serverUrl }),
      testServer: desktop.testServer,
      saveServer: async (value) => {
        const result = await desktop.testServer(value)
        saves += 1
        return result
      },
    } },
  })
  await Promise.resolve()
  assert.equal(node('#role-mark').textContent, '学')
  const checking = node('#test').handlers.click()
  assert.equal(node('#save').disabled, true)
  await checking
  assert.match(node('#status').textContent, /连接成功/)
  assert.equal(node('#test').disabled, false)
  // Enter 事件处理器不返回 Promise，等实际 HTTP 请求完成后检查结果。
  node('#server-url').handlers.keydown({ key: 'Enter' })
  for (let attempt = 0; attempt < 100 && node('#save').disabled; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(saves, 1)
  assert.equal(node('#save').disabled, false)
  try {
    healthStatus = 503
    await node('#save').handlers.click()
    assert.match(node('#status').textContent, /503/)
    assert.equal(node('#save').disabled, false)
    assert.equal(saves, 1)
  } finally {
    healthStatus = 200
  }
})
