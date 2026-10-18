import { onScopeDispose, ref } from 'vue'
import { messageOf } from '../api/request.js'

// Abort saves work; the sequence also protects against transports that ignore abort.
export function useAsyncList(loader, { initialData = [], onLoaded } = {}) {
  const data = ref(initialData),
    loading = ref(false),
    loaded = ref(false),
    loadError = ref('')
  let sequence = 0,
    controller,
    disposed = false
  function cancel() {
    sequence += 1
    controller?.abort()
    controller = null
    loading.value = false
  }
  async function load() {
    if (disposed) return
    const current = ++sequence
    controller?.abort()
    const requestController = new AbortController()
    controller = requestController
    loading.value = true
    loadError.value = ''
    try {
      const result = await loader(requestController.signal)
      if (current !== sequence) return
      data.value = result
      onLoaded?.(result)
      loaded.value = true
      return result
    } catch (error) {
      if (
        current === sequence &&
        !['CanceledError', 'AbortError'].includes(error?.name) &&
        error?.code !== 'ERR_CANCELED'
      )
        loadError.value = messageOf(error)
    } finally {
      if (current === sequence) {
        loading.value = false
        controller = null
      }
    }
  }
  onScopeDispose(() => {
    disposed = true
    cancel()
  })
  return { data, loading, loaded, loadError, load, reload: load, cancel }
}
