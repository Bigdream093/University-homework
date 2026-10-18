import { ref } from 'vue'
import api from '../api/request.js'
import { readUser } from '../utils/session.js'
export function newRequestId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}
export function intentSignature(value) {
  const text = JSON.stringify(value)
  let fnvHash = 2166136261,
    djbHash = 5381
  for (let index = 0; index < text.length; index++) {
    fnvHash = Math.imul(fnvHash ^ text.charCodeAt(index), 16777619)
    djbHash = Math.imul(djbHash, 33) ^ text.charCodeAt(index)
  }
  return (fnvHash >>> 0).toString(16) + (djbHash >>> 0).toString(16)
}
// 服务端 409 版本冲突（个人/小组提交被更新页面抢先）是终态，不应进入"可重试"流程。
export function isSubmissionConflict(error) {
  return (
    error?.response?.status === 409 &&
    /已有更新|已有新的提交记录/.test(String(error?.response?.data?.message || ''))
  )
}
export function useUpload() {
  const busy = ref(false),
    phase = ref('idle'),
    percent = ref(0),
    state = ref(''),
    pending = ref(false),
    loaded = ref(0),
    total = ref(null)
  let controller
  async function run({
    url,
    statusUrl,
    method = 'post',
    fields = {},
    file = null,
    extraFiles = [],
    clientReference,
    onRequestId,
  }) {
    if (busy.value) throw new Error('当前上传尚未结束')
    const slot = 'upload:' + readUser()?.id + ':' + url,
      signature = intentSignature({
        fields,
        file: file ? { name: file.name, size: file.size, modified: file.lastModified } : null,
        previews: extraFiles.map((preview) => ({
          name: preview.name,
          size: preview.size,
          modified: preview.lastModified,
        })),
      })
    let saved
    try {
      saved = JSON.parse(sessionStorage.getItem(slot) || 'null')
    } catch {}
    const previous = saved?.signature === signature
    const intent = previous ? saved : { key: newRequestId(), signature }
    sessionStorage.setItem(slot, JSON.stringify(intent))
    onRequestId?.(clientReference || intent.key)
    busy.value = true
    phase.value = 'preparing'
    pending.value = true
    percent.value = 0
    loaded.value = 0
    total.value = null
    function succeed(result) {
      phase.value = 'succeeded'
      state.value = '已保存'
      pending.value = false
      sessionStorage.removeItem(slot)
      return result
    }
    try {
      if (previous) {
        phase.value = 'uncertain'
        state.value = '正在查询上次结果'
        const { data } = await api.get(statusUrl + intent.key, {
          headers: { 'X-Client-Reference': clientReference || intent.key },
        })
        if (data.state === 'succeeded') return succeed(data.result)
        if (data.state === 'processing') throw new Error('服务器仍在处理，请稍后查询/重试')
      }
      const body = new FormData()
      for (const [key, value] of Object.entries(fields)) body.append(key, value ?? '')
      if (file) body.append('file', file)
      for (const extra of extraFiles) body.append('previews', extra)
      controller = new AbortController()
      phase.value = 'uploading'
      state.value = '正在上传'
      const { data } = await api.request({
        url,
        method,
        data: body,
        timeout: 0,
        signal: controller.signal,
        headers: {
          'Idempotency-Key': intent.key,
          'X-Client-Reference': clientReference || intent.key,
        },
        onUploadProgress: (event) => {
          loaded.value = event.loaded
          total.value = event.total || null
          percent.value = event.total
            ? Math.min(100, Math.round((event.loaded / event.total) * 100))
            : 0
          phase.value = percent.value >= 100 ? 'saving' : 'uploading'
          state.value = phase.value === 'saving' ? '正在保存，请勿重复提交' : '正在上传'
        },
      })
      return succeed(data)
    } catch (error) {
      if (isSubmissionConflict(error)) {
        phase.value = 'conflict'
        state.value = '提交冲突，请先刷新确认'
        pending.value = false
        sessionStorage.removeItem(slot)
        throw error
      }
      if (error.response?.status && error.response.status < 500) {
        phase.value = 'failed'
        pending.value = false
        state.value = error.response.data?.message || '服务器拒绝了本次提交，请修改后重试'
        throw error
      }
      phase.value = 'uncertain'
      state.value = '正在确认服务器保存结果'
      try {
        const { data } = await api.get(statusUrl + intent.key, {
          headers: { 'X-Client-Reference': clientReference || intent.key },
        })
        if (data.state === 'succeeded') return succeed(data.result)
        if (data.state === 'failed') {
          phase.value = 'failed'
          pending.value = false
          state.value = data.error || '保存失败，可以重试'
        } else if (data.state === 'processing') {
          pending.value = true
          state.value = '服务器仍在处理，结果待确认；请稍后查询/重试'
        } else {
          pending.value = true
          state.value = '暂未查到服务器记录，结果待确认；请查询/重试同一内容'
        }
      } catch {
        pending.value = true
        state.value = '结果待确认，服务器状态暂时无法读取；请查询/重试'
      }
      throw error
    } finally {
      busy.value = false
      controller = null
    }
  }
  function cancel() {
    if (!busy.value || !controller) return
    controller?.abort()
    phase.value = 'uncertain'
    state.value = '已取消等待，正在确认服务器结果'
  }
  return { busy, phase, percent, state, pending, loaded, total, run, cancel }
}
