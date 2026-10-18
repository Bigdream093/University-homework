<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ImagePreviewDialog from './ImagePreviewDialog.vue'
import { loadPreviewBlob } from '../utils/previewImages.js'
const props = defineProps({ previews: { type: Array, default: () => [] }, title: String })
const first = computed(() => props.previews[0]),
  visible = ref(false),
  source = ref(''),
  failed = ref(false),
  root = ref(null),
  inViewport = ref(false)
let sequence = 0,
  controller,
  observer,
  currentPreview
function failedThumbnail() {
  failed.value = true
  release()
}
function release() {
  if (source.value) URL.revokeObjectURL(source.value)
  source.value = ''
}
watch(
  [first, inViewport, () => first.value?.ticketPending, () => first.value?.thumbnail],
  async ([preview, shouldLoad, ticketPending]) => {
    if (preview !== currentPreview) {
      currentPreview = preview
      ++sequence
      controller?.abort()
      release()
      failed.value = false
    }
    if (!preview || !shouldLoad || ticketPending) return
    const version = ++sequence
    controller?.abort()
    controller = new AbortController()
    release()
    failed.value = false
    try {
      const blob = await loadPreviewBlob(preview, { thumbnail: true, signal: controller.signal })
      if (version === sequence) source.value = URL.createObjectURL(blob)
    } catch {
      if (version === sequence) failed.value = true
    }
  },
  { immediate: true },
)
onMounted(() => {
  if (!globalThis.IntersectionObserver) {
    inViewport.value = true
    return
  }
  observer = new IntersectionObserver(
    ([entry]) => {
      if (!entry.isIntersecting) return
      inViewport.value = true
      observer.disconnect()
    },
    { rootMargin: '160px' },
  )
  if (root.value) observer.observe(root.value)
})
onBeforeUnmount(() => {
  ++sequence
  observer?.disconnect()
  controller?.abort()
  release()
})
</script>
<template>
  <button
    ref="root"
    class="submission-preview"
    type="button"
    :aria-label="`放大查看${title || '作业'}的预览图`"
    @click="visible = true"
  >
    <img v-if="source" :src="source" alt="作业预览缩略图" loading="lazy" @error="failedThumbnail" />
    <span v-else class="submission-preview-placeholder">{{
      failed ? '点击重试' : first?.ticketPending ? '加载中…' : '预览图'
    }}</span>
    <span class="submission-preview-label">共 {{ previews.length }} 张 · 点击放大</span>
  </button>
  <ImagePreviewDialog v-model="visible" :previews="previews" :title="title || '作业预览图'" />
</template>
<style scoped>
.submission-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  max-width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: #526f65;
  font: inherit;
  font-size: 12px;
  cursor: zoom-in;
}
.submission-preview img,
.submission-preview-placeholder {
  width: 80px;
  height: 60px;
  flex: none;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #f5f8f6;
  object-fit: contain;
}
.submission-preview-placeholder {
  display: grid;
  place-items: center;
  color: #7c9085;
}
.submission-preview-label {
  line-height: 1.6;
  text-align: left;
}
.submission-preview:hover {
  color: var(--green);
}
</style>
