import { ref, watch } from 'vue'
import { sha256 as sha256Compatible } from 'hash-wasm'
import api from '../api/request.js'
import { readUser } from '../utils/session.js'
import { intentSignature, isSubmissionConflict, useUpload } from './useUpload.js'

const CHUNK_BYTES = 8 * 1024 * 1024,
  FALLBACK_BYTES = 32 * 1024 * 1024
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export async function hashChunk(blob, subtle = globalThis.crypto?.subtle) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (subtle) {
    try {
      const digest = await subtle.digest('SHA-256', bytes)
      return Array.from(new Uint8Array(digest), (value) =>
        value.toString(16).padStart(2, '0'),
      ).join('')
    } catch {
      // 某些内嵌浏览器虽然暴露 subtle，但在 HTTP 页面上调用仍可能失败。
    }
  }
  // hash-wasm 不依赖安全上下文，让局域网/公网 HTTP 也能计算分片摘要并断点续传。
  return sha256Compatible(bytes)
}

export function useChunkedUpload() {
  const busy = ref(false),
    percent = ref(0),
    state = ref(''),
    pending = ref(false),
    loaded = ref(0),
    total = ref(null),
    legacy = useUpload()
  let controller,
    sessionId,
    slot,
    paused = false,
    cancelled = false,
    delegated = false
  for (const key of ['busy', 'percent', 'state', 'pending', 'loaded', 'total'])
    watch(legacy[key], (value) => {
      if (!sessionId) ({ busy, percent, state, pending, loaded, total })[key].value = value
    })

  async function fallback(config, bytes, error) {
    if (![404, 405].includes(error?.response?.status)) throw error
    if (bytes > FALLBACK_BYTES) throw new Error('服务器版本暂不支持大文件断点上传，请先升级服务器')
    sessionId = null
    delegated = true
    return legacy.run(config)
  }

  async function run({
    kind,
    target,
    metadata = {},
    baseVersion = 0,
    files = [],
    legacy: legacyConfig,
  }) {
    if (busy.value) throw new Error('当前上传尚未结束')
    const entries = files.filter((item) => item.file),
      bytes = entries.reduce((sum, item) => sum + item.file.size, 0)
    if (!entries.length) return legacy.run(legacyConfig)
    const identity = entries.map((item, index) => ({
      role: item.role,
      order: item.order ?? index,
      name: item.file.name,
      size: item.file.size,
      modified: item.file.lastModified,
    }))
    slot = `chunk-upload:${readUser()?.id}:${kind}:${JSON.stringify(target)}`
    const signature = intentSignature({ kind, target, files: identity })
    let saved
    try {
      saved = JSON.parse(sessionStorage.getItem(slot) || 'null')
    } catch {}
    busy.value = true
    pending.value = true
    paused = false
    cancelled = false
    delegated = false
    total.value = bytes
    loaded.value = 0
    percent.value = 0
    try {
      let session
      if (saved?.signature === signature) {
        state.value = '正在恢复上次进度'
        try {
          session = (await api.get(`/upload-sessions/${saved.id}`)).data
        } catch (error) {
          if (![404, 410].includes(error?.response?.status)) throw error
        }
      }
      if (!session) {
        state.value = '正在创建上传会话'
        const payload = {
          kind,
          base_version: baseVersion,
          metadata,
          files: entries.map((item, index) => ({
            client_id: `file-${index}`,
            role: item.role,
            order: item.order ?? index,
            name: item.file.name,
            size: item.file.size,
            mime: item.file.type,
          })),
          ...target,
        }
        try {
          session = (await api.post('/upload-sessions', payload)).data
        } catch (error) {
          return await fallback(legacyConfig, bytes, error)
        }
        sessionStorage.setItem(slot, JSON.stringify({ id: session.id, signature }))
      }
      sessionId = session.id
      if (session.state === 'succeeded') {
        sessionStorage.removeItem(slot)
        pending.value = false
        state.value = '已保存'
        return JSON.parse(session.result_json)
      }
      const remote = session.files
      const refresh = async () => {
        session = (await api.get(`/upload-sessions/${sessionId}`)).data
        for (const file of remote) {
          const fresh = session.files.find((item) => item.id === file.id)
          if (fresh) Object.assign(file, fresh)
        }
      }
      for (const [index, entry] of entries.entries()) {
        const file = remote.find(
          (item) => item.sort_order === (entry.order ?? index) && item.file_role === entry.role,
        )
        if (!file) throw new Error('服务器文件清单不一致')
        while (file.uploaded_bytes < entry.file.size) {
          if (paused || cancelled)
            throw Object.assign(new Error(cancelled ? '上传已取消' : '上传已暂停'), {
              code: cancelled ? 'UPLOAD_CANCELLED' : 'UPLOAD_PAUSED',
            })
          const start = file.uploaded_bytes,
            end = Math.min(start + CHUNK_BYTES, entry.file.size),
            chunk = entry.file.slice(start, end),
            digest = await hashChunk(chunk)
          let done = false,
            lastError
          for (let attempt = 0; attempt < 3 && !done; attempt += 1) {
            try {
              controller = new AbortController()
              state.value = `正在上传 ${entry.file.name}`
              const committed = remote.reduce((sum, item) => sum + item.uploaded_bytes, 0)
              const response = await api.put(
                `/upload-sessions/${sessionId}/files/${file.id}/chunk`,
                chunk,
                {
                  timeout: 0,
                  signal: controller.signal,
                  headers: {
                    'Content-Type': 'application/octet-stream',
                    'Content-Range': `bytes ${start}-${end - 1}/${entry.file.size}`,
                    'X-Chunk-SHA256': digest,
                  },
                  onUploadProgress: (event) => {
                    loaded.value = Math.min(bytes, committed + event.loaded)
                    percent.value = Math.round((loaded.value / bytes) * 100)
                  },
                },
              )
              file.uploaded_bytes = response.data.uploaded_bytes
              done = true
            } catch (error) {
              if (paused || cancelled)
                throw Object.assign(error, {
                  code: cancelled ? 'UPLOAD_CANCELLED' : 'UPLOAD_PAUSED',
                })
              lastError = error
              if (error.response?.status === 409) {
                await refresh()
                if (file.uploaded_bytes >= end) {
                  done = true
                  break
                }
              }
              if (
                error.response?.status &&
                error.response.status < 500 &&
                error.response.status !== 409
              )
                throw error
              if (!done && attempt < 2) {
                state.value = '网络波动，正在重试'
                await wait(2 ** attempt * 1000 + Math.random() * 500)
              }
            } finally {
              controller = null
            }
          }
          if (!done) {
            state.value = '网络不稳定，已保留上传进度'
            throw lastError
          }
          loaded.value = remote.reduce((sum, item) => sum + item.uploaded_bytes, 0)
          percent.value = Math.round((loaded.value / bytes) * 100)
        }
      }
      state.value = '正在校验并保存'
      const result = (
        await api.post(`/upload-sessions/${sessionId}/complete`, { metadata }, { timeout: 0 })
      ).data
      sessionStorage.removeItem(slot)
      pending.value = false
      state.value = '已保存'
      return result
    } catch (error) {
      if (isSubmissionConflict(error)) {
        if (slot) sessionStorage.removeItem(slot)
        pending.value = false
        state.value = '提交冲突，请先刷新确认'
        throw error
      }
      if (error.code === 'UPLOAD_PAUSED') state.value = '已暂停，点击继续即可断点上传'
      else if (error.code === 'UPLOAD_CANCELLED') state.value = '上传已取消'
      else if (!state.value.includes('已保留'))
        state.value = error.response?.data?.message || error.message || '上传失败，可重试'
      throw error
    } finally {
      busy.value = false
      controller = null
      sessionId = null
    }
  }

  function pause() {
    if (delegated) {
      state.value = '整体上传不支持暂停，可取消后重新上传'
      return
    }
    paused = true
    controller?.abort()
  }
  async function cancel() {
    if (delegated) return legacy.cancel()
    cancelled = true
    controller?.abort()
    let saved
    try {
      saved = slot && JSON.parse(sessionStorage.getItem(slot) || 'null')
    } catch {}
    if (saved?.id) await api.delete(`/upload-sessions/${saved.id}`).catch(() => {})
    if (slot) sessionStorage.removeItem(slot)
    pending.value = false
    state.value = '上传已取消'
  }
  return { busy, percent, state, pending, loaded, total, run, pause, cancel }
}
