import api from '../api/request.js'
import { readToken } from './session.js'

const imageBlobCache = new Map()
const imageLoads = new Map()
let cachedImageBytes = 0
let imageCacheToken
const MAX_CACHED_IMAGE_BYTES = 48 * 1024 * 1024

// Lists, history endpoints and old servers use different names for the same fields.
export function normalizePreview(value = {}) {
  return {
    ...value,
    id: Number(value.id) || null,
    name: value.name || value.original_name || '作业预览图',
    thumbnail: value.thumbnail || value.thumbnail_url || '',
    preview: value.preview || value.file || value.file_url || value.url || '',
  }
}

export function applyPreviewTicket(preview, ticket) {
  if (!ticket) return
  const normalized = normalizePreview(ticket)
  if (normalized.thumbnail) preview.thumbnail = normalized.thumbnail
  if (normalized.preview) preview.preview = normalized.preview
}

function cacheImage(key, blob, sessionToken) {
  if (imageCacheToken !== sessionToken || readToken() !== sessionToken) return
  if (blob.size > MAX_CACHED_IMAGE_BYTES) return
  if (imageBlobCache.has(key)) {
    cachedImageBytes -= imageBlobCache.get(key).size
    imageBlobCache.delete(key)
  }
  imageBlobCache.set(key, blob)
  cachedImageBytes += blob.size
  while (cachedImageBytes > MAX_CACHED_IMAGE_BYTES && imageBlobCache.size) {
    const [oldestKey, oldestBlob] = imageBlobCache.entries().next().value
    imageBlobCache.delete(oldestKey)
    cachedImageBytes -= oldestBlob.size
  }
}

function useImageCacheForToken(sessionToken) {
  if (imageCacheToken === sessionToken) return
  imageBlobCache.clear()
  cachedImageBytes = 0
  for (const load of imageLoads.values()) load.controller.abort()
  imageLoads.clear()
  imageCacheToken = sessionToken
}

function cancelError() {
  return Object.assign(new Error('图片加载已取消'), { code: 'ERR_CANCELED' })
}

function waitForImage(load, signal) {
  load.waiters += 1
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      load.waiters -= 1
      if (!load.waiters && !load.settled) {
        load.controller.abort()
        if (imageLoads.get(load.key) === load) imageLoads.delete(load.key)
      }
      callback(value)
    }
    const onAbort = () => finish(reject, cancelError())
    load.promise.then(
      (blob) => finish(resolve, blob),
      (error) => finish(reject, error),
    )
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function apiPath(value) {
  const origin = globalThis.location?.origin || 'http://localhost'
  const url = new URL(value, origin)
  if (url.origin !== origin || !url.pathname.startsWith('/api/'))
    throw new Error('图片地址无效，请刷新作业后重试')
  return url.pathname.slice(4) + url.search
}

async function readImage(url, signal) {
  const { data } = await api.get(apiPath(url), {
    responseType: 'blob',
    signal,
    timeout: 60000,
    skipSessionExpiry: true,
  })
  return verifiedImage(data)
}

async function verifiedImage(data) {
  if (!(data instanceof Blob) || !data.size) throw new Error('图片接口没有返回有效图片')
  // Older download endpoints may return application/octet-stream. Verify real bytes.
  const head = new Uint8Array(await data.slice(0, 12).arrayBuffer())
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => head[index] === byte)
  const jpeg = head[0] === 255 && head[1] === 216 && head[2] === 255
  if (!png && !jpeg) throw new Error('图片内容无法识别，接口可能返回了登录页或错误内容')
  return new Blob([data], { type: png ? 'image/png' : 'image/jpeg' })
}

export async function loadPreviewBlob(value, { thumbnail = false, signal } = {}) {
  if (signal?.aborted) throw cancelError()
  if (value.file instanceof Blob) return verifiedImage(value.file)
  const sessionToken = readToken()
  useImageCacheForToken(sessionToken)
  const preview = normalizePreview(value)
  const cacheKey = `${preview.id || preview.preview || preview.thumbnail}:${thumbnail ? 'thumbnail' : 'full'}`
  const cached = imageBlobCache.get(cacheKey)
  if (cached) {
    imageBlobCache.delete(cacheKey)
    imageBlobCache.set(cacheKey, cached)
    return cached
  }
  const loadKey = `${sessionToken || 'anonymous'}\u0000${cacheKey}`
  let load = imageLoads.get(loadKey)
  if (!load) {
    const controller = new AbortController()
    load = { key: loadKey, controller, waiters: 0, settled: false, promise: null }
    load.promise = loadPreview(preview, thumbnail, sessionToken, cacheKey, controller.signal)
      .then(
        (blob) => {
          load.settled = true
          return blob
        },
        (error) => {
          load.settled = true
          throw error
        },
      )
      .finally(() => {
        if (imageLoads.get(loadKey) === load) imageLoads.delete(loadKey)
      })
    imageLoads.set(loadKey, load)
  }
  return waitForImage(load, signal)
}

async function loadPreview(preview, thumbnail, sessionToken, cacheKey, signal) {
  const attempted = new Set()
  let lastError
  async function attempt(url) {
    if (!url || attempted.has(url)) return null
    attempted.add(url)
    try {
      return await readImage(url, signal)
    } catch (error) {
      if (signal?.aborted || error.code === 'ERR_CANCELED') throw error
      if (['ECONNABORTED', 'ETIMEDOUT'].includes(error.code))
        throw new Error('图片加载超时，请点击重试', { cause: error })
      if (error.code === 'ERR_NETWORK')
        throw new Error('图片连接中断，请点击重试', { cause: error })
      if (error.response?.status >= 500)
        throw new Error(error.response.data?.message || '图片服务暂时不可用，请点击重试', {
          cause: error,
        })
      lastError = error
      return null
    }
  }
  const prefix = preview.group ? 'group-' : ''
  const direct = preview.id
    ? `/api/${prefix}submission-previews/${preview.id}/${thumbnail ? 'thumbnail' : 'file'}`
    : ''
  const derivedThumbnail = /\/file(?=\?|$)/.test(preview.preview)
    ? preview.preview.replace(/\/file(?=\?|$)/, '/thumbnail')
    : ''
  const existing = thumbnail
    ? preview.thumbnail || derivedThumbnail || direct || preview.preview
    : preview.preview
  let blob = await attempt(existing)
  if (blob) {
    cacheImage(cacheKey, blob, sessionToken)
    return blob
  }
  let ticketServiceHandledPreview = false
  if (preview.id) {
    if (!preview.ticketUnavailable) {
      try {
        const { data } = await api.post('/previews/view-ticket', { ids: [preview.id] }, { signal })
        ticketServiceHandledPreview = true
        const ticket = normalizePreview(data.tickets?.[preview.id] || {})
        blob = await attempt(thumbnail ? ticket.thumbnail || ticket.preview : ticket.preview)
        if (blob) {
          cacheImage(cacheKey, blob, sessionToken)
          return blob
        }
        if (data.errors?.[preview.id]) lastError = new Error(data.errors[preview.id])
      } catch (error) {
        if (signal?.aborted || error.code === 'ERR_CANCELED') throw error
        lastError = error
      }
    }
    if (!ticketServiceHandledPreview) {
      // Older servers without view-ticket still enforce the current user's permissions.
      blob = await attempt(direct)
      if (blob) {
        cacheImage(cacheKey, blob, sessionToken)
        return blob
      }
    }
  }
  if (lastError?.response?.status === 404) throw new Error('图片文件不存在或已被替换')
  if ([401, 403].includes(lastError?.response?.status))
    throw new Error('图片访问凭据失效或没有查看权限，请重试')
  throw new Error(lastError?.message || '图片暂时无法加载，请重试')
}
