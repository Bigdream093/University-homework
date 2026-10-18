import { onMounted, onUnmounted } from 'vue'
export function useRefresh(load) {
  let timer, pending
  const refresh = () => {
    if (document.hidden || pending) return pending
    pending = Promise.resolve()
      .then(load)
      .catch(() => {})
      .finally(() => {
        pending = null
      })
    return pending
  }
  onMounted(() => {
    refresh()
    timer = setInterval(refresh, 60000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
  })
  onUnmounted(() => {
    clearInterval(timer)
    window.removeEventListener('focus', refresh)
    document.removeEventListener('visibilitychange', refresh)
  })
}
