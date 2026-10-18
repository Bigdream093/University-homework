import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { ref } from 'vue'
import api from '../src/api/request.js'
import { loadPreviewBlob } from '../src/utils/previewImages.js'
import { useSummaryPreviews } from '../src/composables/useSummaryPreviews.js'
import { mountView, nodes, button, click, settle, storage, textOf } from './helpers/view-harness.js'

const png = new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])], {
  type: 'application/octet-stream',
})
const originalAdapter = api.defaults.adapter
let sessionNumber = 0
beforeEach(() => {
  globalThis.localStorage = storage()
  localStorage.setItem('hw_token', `preview-test-token-${++sessionNumber}`)
})
afterEach(() => {
  api.defaults.adapter = originalAdapter
  delete globalThis.localStorage
})
function mock(handler) {
  const requests = []
  api.defaults.adapter = async (config) => {
    requests.push(config)
    try {
      const data = await handler(config)
      return { data, status: 200, statusText: 'OK', headers: {}, config }
    } catch (error) {
      error.config ||= config
      throw error
    }
  }
  return requests
}
const reject = (status) => {
  throw Object.assign(new Error('HTTP ' + status), { response: { status } })
}

test('汇总票据：全量应用跳过未完成批次，缓存命中不重签，旧代响应不覆盖', async () => {
  let finish
  const calls = mock(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const students = ref([{ cells: { 1: { kind: 'group', previews: [{ id: 1 }, { id: 2 }] } } }])
  const previews = useSummaryPreviews(students, ref([{ id: 1 }]))
  const [first, second] = students.value[0].cells[1].previews
  const pending = previews.redeemTickets([1, 1])
  await settle()
  previews.applyTickets()
  assert.equal(first.ticketPending, true)
  assert.equal(second.ticketUnavailable, true)
  finish({ tickets: { 1: { thumbnail: '/thumbnail', preview: '/file' } } })
  await pending
  assert.equal(first.ticketPending, false)
  assert.equal(first.thumbnail, '/thumbnail')
  assert.equal(first.group, true)
  await previews.redeemTickets([1])
  assert.equal(calls.length, 1)
  assert.equal(first.ticketUnavailable, false)
  const stale = previews.redeemTickets([1], true)
  await settle()
  previews.clearTickets()
  first.thumbnail = '/current'
  finish({ tickets: { 1: { thumbnail: '/stale' } } })
  await stale
  assert.equal(first.thumbnail, '/current')
})

test('旧历史接口 file_url 可以携带登录头读取，错误 MIME 按真实图片字节修正', async () => {
  const calls = mock((config) => {
    assert.equal(config.url, '/submission-previews/7/file')
    assert.equal(config.headers.Authorization, `Bearer ${localStorage.getItem('hw_token')}`)
    return png
  })
  const result = await loadPreviewBlob({
    id: '7',
    original_name: '旧图.png',
    file_url: '/api/submission-previews/7/file',
  })
  assert.equal(result.type, 'image/png')
  assert.equal(result.size, png.size)
  assert.equal(calls.length, 1)
})
test('旧服务器没有 view-ticket 接口时回退至受鉴权的原图接口', async () => {
  const calls = mock((config) => (config.method === 'post' ? reject(404) : png))
  assert.equal((await loadPreviewBlob({ id: 8 })).size, png.size)
  assert.deepEqual(
    calls.map((config) => config.url),
    ['/previews/view-ticket', '/submission-previews/8/file'],
  )
})
test('过期票据刷新后使用新地址，也兼容 ticket.file_url 命名', async () => {
  const calls = mock((config) => {
    if (config.url === '/preview-files/expired') return reject(401)
    if (config.method === 'post')
      return { tickets: { 9: { file_url: '/api/preview-files/fresh' } } }
    assert.equal(config.url, '/preview-files/fresh')
    return png
  })
  await loadPreviewBlob({ id: 9, preview: '/api/preview-files/expired' })
  assert.equal(calls.length, 3)
})
test('HTTP 200 的登录页或错误 HTML 不能冒充原图', async () => {
  mock((config) =>
    config.method === 'post'
      ? { tickets: {} }
      : new Blob(['<html>login</html>'], { type: 'text/html' }),
  )
  await assert.rejects(
    loadPreviewBlob({ id: 9, preview: '/api/preview-files/wrong' }),
    /图片内容无法识别/,
  )
})
test('外站图片地址不会收到登录凭据，仍可按本地图片编号安全加载', async () => {
  const calls = mock((config) =>
    config.method === 'post' ? { tickets: { 5: { file: '/api/preview-files/local-only' } } } : png,
  )
  await loadPreviewBlob({ id: 5, preview: 'https://outside.invalid/steal' })
  assert.ok(calls.every((config) => !config.url.includes('outside.invalid')))
})
test('快速切换图片时，旧请求完成不能覆盖当前图片', async () => {
  let finishFirst
  const view = await mountView('components/PreviewGallery.vue', {
    props: {
      previews: [
        { id: 1, name: '第一张', preview: '/api/images/1' },
        { id: 2, name: '第二张', preview: '/api/images/2' },
      ],
    },
    handler: (config) =>
      config.url === '/images/1'
        ? new Promise((resolve) => {
            finishFirst = resolve
          })
        : png,
  })
  await click(button(view, '下一张 →'))
  await settle()
  assert.equal(nodes(view.root, 'img')[0].props.alt, '第二张')
  finishFirst(png)
  await settle()
  assert.equal(nodes(view.root, 'img')[0].props.alt, '第二张')
  assert.deepEqual(view.errors, [])
})

test('学生本地选图使用同一查看器时不上传文件、不请求远端接口', async () => {
  const calls = mock(() => {
    throw new Error('本地预览不应发起请求')
  })
  const result = await loadPreviewBlob({ name: '本地图片.png', file: png })
  assert.equal(result.type, 'image/png')
  assert.equal(result.size, png.size)
  assert.equal(calls.length, 0)
})

test('同一张小组缩略图同时出现在多行时只下载一次', async () => {
  let finish
  const calls = mock(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const loads = Array.from({ length: 5 }, () =>
    loadPreviewBlob({ id: 21, thumbnail: '/api/preview-files/shared' }, { thumbnail: true }),
  )
  await settle()
  assert.equal(calls.length, 1)
  finish(png)
  const blobs = await Promise.all(loads)
  assert.ok(blobs.every((blob) => blob === blobs[0]))
  await loadPreviewBlob({ id: 21 }, { thumbnail: true })
  assert.equal(calls.length, 1)
})

test('关闭一个图片位置不会取消其他位置共用的下载', async () => {
  let finish
  const calls = mock(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const controller = new AbortController()
  const preview = { id: 22, thumbnail: '/api/preview-files/shared-with-cancel' }
  const first = loadPreviewBlob(preview, { thumbnail: true, signal: controller.signal })
  const second = loadPreviewBlob(preview, { thumbnail: true })
  await settle()
  const cancelled = assert.rejects(first, { code: 'ERR_CANCELED' })
  controller.abort()
  await cancelled
  assert.equal(calls[0].signal.aborted, false)
  finish(png)
  assert.equal((await second).size, png.size)
  assert.equal(calls.length, 1)
})

test('所有图片位置关闭后取消下载，重新打开能够发起新请求', async () => {
  let attempts = 0
  const calls = mock((config) => {
    if (++attempts > 1) return png
    return new Promise((resolve, reject) => {
      config.signal.addEventListener('abort', () =>
        reject(Object.assign(new Error('cancelled'), { code: 'ERR_CANCELED' })),
      )
    })
  })
  const controller = new AbortController()
  const preview = { id: 23, preview: '/api/preview-files/cancel-and-reopen' }
  const first = loadPreviewBlob(preview, { signal: controller.signal })
  await settle()
  const cancelled = assert.rejects(first, { code: 'ERR_CANCELED' })
  controller.abort()
  await cancelled
  assert.equal(calls[0].signal.aborted, true)
  assert.equal((await loadPreviewBlob(preview)).size, png.size)
  assert.equal(calls.length, 2)
})

test('调用前已经取消的图片不会启动下载', async () => {
  const calls = mock(() => png)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(loadPreviewBlob({ id: 24 }, { signal: controller.signal }), {
    code: 'ERR_CANCELED',
  })
  assert.equal(calls.length, 0)
})

test('切换账号会取消旧账号的图片请求并重新下载', async () => {
  let attempts = 0
  const calls = mock((config) => {
    if (++attempts > 1) return png
    return new Promise((resolve, reject) => {
      config.signal.addEventListener('abort', () =>
        reject(Object.assign(new Error('cancelled'), { code: 'ERR_CANCELED' })),
      )
    })
  })
  const preview = { id: 25, preview: '/api/preview-files/account-switch' }
  const previous = loadPreviewBlob(preview)
  await settle()
  const cancelled = assert.rejects(previous, { code: 'ERR_CANCELED' })
  localStorage.setItem('hw_token', 'another-preview-account')
  assert.equal((await loadPreviewBlob(preview)).size, png.size)
  await cancelled
  assert.equal(calls[0].signal.aborted, true)
  await loadPreviewBlob(preview)
  assert.equal(calls.length, 2)
})

for (const [label, error, message] of [
  ['超时', { code: 'ECONNABORTED' }, /图片加载超时/],
  ['断网', { code: 'ERR_NETWORK' }, /图片连接中断/],
  ['服务故障', { response: { status: 503 } }, /图片服务暂时不可用/],
]) {
  test(`图片${label}后不再串行重复请求其他图片接口`, async () => {
    const calls = mock(() => {
      throw Object.assign(new Error(label), error)
    })
    await assert.rejects(
      loadPreviewBlob({ id: 26, preview: '/api/preview-files/failing' }),
      message,
    )
    assert.equal(calls.length, 1)
  })
}

test('原图先完成时直接显示，不受缩略图阻塞且不显示空图占位', async () => {
  let finishThumbnail
  const view = await mountView('components/PreviewGallery.vue', {
    props: {
      previews: [
        {
          id: 27,
          name: '快速原图',
          thumbnail: '/api/preview-files/slow-thumbnail',
          preview: '/api/preview-files/fast-original',
        },
      ],
    },
    handler: (config) =>
      config.url === '/preview-files/slow-thumbnail'
        ? new Promise((resolve) => {
            finishThumbnail = resolve
          })
        : png,
  })
  await settle()
  assert.equal(nodes(view.root, 'img')[0]?.props.alt, '快速原图')
  assert.ok(!textOf(view.root).includes('该提交没有预览图'))
  finishThumbnail(png)
  await settle()
  assert.deepEqual(view.errors, [])
})
