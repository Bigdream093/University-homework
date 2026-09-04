import { onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import api, { messageOf } from '../api/request.js'
import { readToken } from '../utils/session.js'

function requestId() {
  return `download-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`
}

// 完成、失败和取消任务停留 5 秒后自动清除面板与主进程记录；
// 只有暂停任务保留在面板里等待继续。
const AUTO_DISMISS_MS = 5000
const AUTO_DISMISS_STATES = new Set(['completed', 'failed', 'cancelled'])

export function useDownload() {
  const tasks = ref([])
  const timers = new Map()
  let removeListener

  function upsert(view) {
    if (!view?.requestId) return
    const index = tasks.value.findIndex((task) => task.requestId === view.requestId)
    if (index >= 0) tasks.value.splice(index, 1, { ...tasks.value[index], ...view })
    else tasks.value.push({ ...view })
    if (AUTO_DISMISS_STATES.has(view.state)) scheduleAutoDismiss(view.requestId)
  }

  function remove(id) {
    const timer = timers.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.delete(id)
    }
    tasks.value = tasks.value.filter((task) => task.requestId !== id)
  }

  function scheduleAutoDismiss(id) {
    if (timers.has(id)) return
    timers.set(
      id,
      setTimeout(async () => {
        timers.delete(id)
        try {
          await window.mohenDesktop?.dismissDownload?.(id)
        } catch {
          /* 主进程记录清理失败不影响前端面板移除 */
        }
        remove(id)
      }, AUTO_DISMISS_MS),
    )
  }

  // 支持并发：主进程按 requestId 管理下载，前端只按请求维护面板列表。
  async function start({ endpoint, ticket, fileName, fileSize = 0 }) {
    if (!window.mohenDesktop?.saveDownloadFile) {
      try {
        const { data } = await api.post('/downloads/ticket', ticket)
        const link = document.createElement('a')
        link.href = data.url
        link.download = fileName
        document.body.appendChild(link)
        link.click()
        link.remove()
        ElMessage.success('已交给浏览器下载')
      } catch (error) {
        ElMessage.error(messageOf(error))
      }
      return
    }

    const id = requestId()
    tasks.value.push({
      requestId: id,
      fileName,
      loaded: 0,
      total: fileSize,
      state: 'starting',
      message: '正在检查磁盘空间并连接服务器…',
    })
    ElMessage.info('下载已开始，文件将保存到系统“下载”目录')
    try {
      const result = await window.mohenDesktop.saveDownloadFile({
        requestId: id,
        endpoint,
        fileName,
        fileSize,
        token: readToken(),
      })
      upsert({ requestId: id, ...result })
      if (result.state === 'completed') ElMessage.success('下载完成')
    } catch (error) {
      remove(id)
      ElMessage.error(error?.message || messageOf(error))
    }
  }

  async function pause(id) {
    try {
      await window.mohenDesktop.pauseDownload(id)
    } catch (error) {
      ElMessage.error(error?.message || messageOf(error))
    }
  }

  async function resume(id) {
    try {
      const result = await window.mohenDesktop.resumeDownload({ requestId: id, token: readToken() })
      upsert({ requestId: id, ...result })
      if (result.state === 'completed') ElMessage.success('下载完成')
    } catch (error) {
      const message = error?.message || messageOf(error)
      upsert({ requestId: id, state: 'failed', message })
      ElMessage.error(message)
    }
  }

  async function cancel(id) {
    try {
      const result = await window.mohenDesktop.cancelDownload(id)
      upsert({ requestId: id, ...result })
      ElMessage.info('下载已取消，临时文件已清理')
    } catch (error) {
      ElMessage.error(error?.message || messageOf(error))
    }
  }

  async function openFolder(id) {
    try {
      await window.mohenDesktop.openDownloadFolder(id)
    } catch (error) {
      ElMessage.error(error?.message || messageOf(error))
    }
  }

  async function dismiss(id) {
    const timer = timers.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.delete(id)
    }
    try {
      await window.mohenDesktop.dismissDownload(id)
    } catch (error) {
      ElMessage.error(error?.message || messageOf(error))
    }
    remove(id)
  }

  onMounted(() => {
    removeListener = window.mohenDesktop?.onDownloadProgress?.((progress) => upsert(progress))
    window.mohenDesktop?.listDownloads?.().then((downloads) => {
      for (const view of downloads || []) upsert(view)
    })
  })
  onBeforeUnmount(() => {
    removeListener?.()
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
  })

  return { tasks, start, pause, resume, cancel, openFolder, dismiss }
}
