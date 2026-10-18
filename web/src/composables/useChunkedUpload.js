import { computed, ref, watch } from 'vue'
import { sha256 as sha256Compatible } from 'hash-wasm'
import api from '../api/request.js'
import { readUser } from '../utils/session.js'
import { intentSignature, isSubmissionConflict, newRequestId, useUpload } from './useUpload.js'
import { CHUNK_BYTES } from '@university-homework/domain/limits'

const FALLBACK_BYTES = 32 * 1024 * 1024
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
    phase = ref('idle'),
    percent = ref(0),
    state = ref(''),
    pending = ref(false),
    loaded = ref(0),
    total = ref(null),
    fallbackUpload = useUpload()
  let controller,
    sessionId,
    slot,
    clientReference,
    paused = false,
    cancelled = false,
    delegated = false
  const canPause = computed(
    () => busy.value && !delegated && ['preparing', 'uploading'].includes(phase.value),
  )
  const canCancel = computed(
    () =>
      !['idle', 'saving', 'uncertain', 'succeeded', 'conflict', 'cancelled'].includes(phase.value),
  )
  for (const key of ['busy', 'phase', 'percent', 'state', 'pending', 'loaded', 'total'])
    watch(
      fallbackUpload[key],
      (value) => {
        if (delegated) ({ busy, phase, percent, state, pending, loaded, total })[key].value = value
      },
      { flush: 'sync' },
    )

  async function fallbackToMultipart(fallbackConfig, bytes, error, reference) {
    if (![404, 405].includes(error?.response?.status)) throw error
    if (bytes > FALLBACK_BYTES) throw new Error('服务器版本暂不支持大文件断点上传，请先升级服务器')
    sessionId = null
    delegated = true
    return fallbackUpload.run({ ...fallbackConfig, clientReference: reference })
  }

  async function run({
    kind,
    target,
    metadata = {},
    baseVersion = 0,
    files = [],
    fallback: fallbackConfig,
    clientReference: requestedReference,
    onRequestId,
  }) {
    if (busy.value) throw new Error('当前上传尚未结束')
    const entries = files.filter((item) => item.file),
      bytes = entries.reduce((sum, item) => sum + item.file.size, 0)
    if (!entries.length) {
      delegated = true
      try {
        return await fallbackUpload.run({
          ...fallbackConfig,
          clientReference: requestedReference,
          onRequestId,
        })
      } finally {
        delegated = false
      }
    }
    const identity = entries.map((item, index) => ({
      role: item.role,
      order: item.order ?? index,
      name: item.file.name,
      size: item.file.size,
      modified: item.file.lastModified,
    }))
    slot = `chunk-upload:${readUser()?.id}:${kind}:${JSON.stringify(target)}`
    const signature = intentSignature({ kind, target, baseVersion, metadata, files: identity })
    let saved
    try {
      saved = JSON.parse(sessionStorage.getItem(slot) || 'null')
    } catch {}
    const sameIntent = saved?.signature === signature
    clientReference = requestedReference || (sameIntent ? saved?.reference : null) || newRequestId()
    onRequestId?.(clientReference)
    if (sameIntent && !saved.reference)
      sessionStorage.setItem(slot, JSON.stringify({ ...saved, reference: clientReference }))
    busy.value = true
    phase.value = 'preparing'
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
          session = (
            await api.get(`/upload-sessions/${saved.id}`, {
              headers: { 'X-Client-Reference': clientReference },
            })
          ).data
          if (session.state === 'failed') {
            sessionStorage.removeItem(slot)
            session = null
          }
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
          session = (
            await api.post('/upload-sessions', payload, {
              headers: { 'X-Client-Reference': clientReference },
            })
          ).data
        } catch (error) {
          return await fallbackToMultipart(fallbackConfig, bytes, error, clientReference)
        }
        sessionStorage.setItem(
          slot,
          JSON.stringify({ id: session.id, signature, reference: clientReference }),
        )
      }
      sessionId = session.id
      if (session.state === 'succeeded') {
        phase.value = 'succeeded'
        loaded.value = bytes
        percent.value = 100
        sessionStorage.removeItem(slot)
        pending.value = false
        state.value = '已保存'
        return JSON.parse(session.result_json)
      }
      if (session.state === 'completing') {
        phase.value = 'uncertain'
        state.value = '服务器仍在处理，结果待确认；请稍后查询/重试'
        throw new Error(state.value)
      }
      const remote = session.files
      loaded.value = Math.min(
        bytes,
        remote.reduce((sum, item) => sum + Number(item.uploaded_bytes || 0), 0),
      )
      percent.value = Math.round((loaded.value / bytes) * 100)
      const stopIfRequested = () => {
        if (paused || cancelled)
          throw Object.assign(new Error(cancelled ? '上传已取消' : '上传已暂停'), {
            code: cancelled ? 'UPLOAD_CANCELLED' : 'UPLOAD_PAUSED',
          })
      }
      const refresh = async () => {
        session = (
          await api.get(`/upload-sessions/${sessionId}`, {
            headers: { 'X-Client-Reference': clientReference },
          })
        ).data
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
          stopIfRequested()
          const start = file.uploaded_bytes,
            end = Math.min(start + CHUNK_BYTES, entry.file.size),
            chunk = entry.file.slice(start, end),
            digest = await hashChunk(chunk)
          stopIfRequested()
          let done = false,
            lastError
          for (let attempt = 0; attempt < 3 && !done; attempt += 1) {
            stopIfRequested()
            try {
              controller = new AbortController()
              phase.value = 'uploading'
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
                    'X-Client-Reference': clientReference,
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
                stopIfRequested()
              }
            } finally {
              controller = null
            }
          }
          if (!done) {
            phase.value = 'paused'
            state.value = '网络不稳定，已保留上传进度'
            throw lastError
          }
          loaded.value = remote.reduce((sum, item) => sum + item.uploaded_bytes, 0)
          percent.value = Math.round((loaded.value / bytes) * 100)
        }
      }
      phase.value = 'saving'
      state.value = '正在校验并保存'
      stopIfRequested()
      const result = (
        await api.post(
          `/upload-sessions/${sessionId}/complete`,
          { metadata },
          { timeout: 0, headers: { 'X-Client-Reference': clientReference } },
        )
      ).data
      sessionStorage.removeItem(slot)
      pending.value = false
      phase.value = 'succeeded'
      state.value = '已保存'
      return result
    } catch (error) {
      if (delegated) throw error
      if (isSubmissionConflict(error)) {
        phase.value = 'conflict'
        if (slot) sessionStorage.removeItem(slot)
        pending.value = false
        state.value = '提交冲突，请先刷新确认'
        throw error
      }
      if (error.code === 'UPLOAD_PAUSED') {
        phase.value = 'paused'
        state.value = '已暂停，点击继续即可断点上传'
      } else if (error.code === 'UPLOAD_CANCELLED') {
        phase.value = 'cancelled'
        pending.value = false
        state.value = '上传已取消'
      } else if (
        phase.value === 'saving' &&
        (!error.response?.status || error.response.status >= 500)
      ) {
        pending.value = true
        phase.value = 'uncertain'
        state.value = '保存结果待确认，点击查询/重试'
      } else if (phase.value === 'saving') {
        pending.value = false
        phase.value = 'failed'
        state.value = error.response?.data?.message || error.message || '保存失败，可以重试'
      } else if (!['paused', 'uncertain'].includes(phase.value)) {
        phase.value = 'failed'
        pending.value = false
        state.value = error.response?.data?.message || error.message || '上传失败，可重试'
      }
      throw error
    } finally {
      busy.value = false
      controller = null
      sessionId = null
      clientReference = null
      delegated = false
    }
  }

  function pause() {
    if (!canPause.value) return
    paused = true
    controller?.abort()
  }
  async function cancel() {
    if (!canCancel.value) return
    if (delegated) return fallbackUpload.cancel()
    cancelled = true
    controller?.abort()
    let saved
    try {
      saved = slot && JSON.parse(sessionStorage.getItem(slot) || 'null')
    } catch {}
    if (saved?.id) {
      try {
        await api.delete(`/upload-sessions/${saved.id}`, {
          headers: { 'X-Client-Reference': clientReference || saved.reference },
        })
      } catch (error) {
        if (![404, 410].includes(error.response?.status)) {
          state.value = error.response?.data?.message || '无法取消上传，请稍后确认保存状态'
          return
        }
      }
    }
    if (slot) sessionStorage.removeItem(slot)
    pending.value = false
    phase.value = 'cancelled'
    state.value = '上传已取消'
  }
  return {
    busy,
    phase,
    canPause,
    canCancel,
    percent,
    state,
    pending,
    loaded,
    total,
    run,
    pause,
    cancel,
  }
}
