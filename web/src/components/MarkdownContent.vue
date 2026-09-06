<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import api from '../api/request.js'
import { renderMarkdown } from '../utils/markdown.js'

const props = defineProps({
  content: { type: String, default: '' },
  format: { type: String, default: 'markdown' },
})
const root = ref(null)
const html = computed(() => renderMarkdown(props.content, props.format))
let generation = 0
let controller
const urls = new Set()
function clear() {
  controller?.abort()
  for (const url of urls) URL.revokeObjectURL(url)
  urls.clear()
}
watch(
  html,
  async () => {
    const current = ++generation
    clear()
    controller = new AbortController()
    const signal = controller.signal
    await nextTick()
    if (current !== generation) return
    const images = [...(root.value?.querySelectorAll('img[data-editor-src]') || [])]
    const sources = [...new Set(images.map((img) => img.dataset.editorSrc))]
    // Bound concurrent downloads when a document contains many screenshots.
    let cursor = 0
    await Promise.all(
      Array.from({ length: Math.min(4, sources.length) }, async () => {
        while (cursor < sources.length && !signal.aborted) {
          const src = sources[cursor++]
          const targets = images.filter((img) => img.dataset.editorSrc === src)
          try {
            const { data } = await api.get(src.slice(4), { responseType: 'blob', signal })
            if (current !== generation) return
            const url = URL.createObjectURL(data)
            urls.add(url)
            for (const img of targets) img.src = url
          } catch {
            if (current !== generation) return
            for (const img of targets) {
              const message = document.createElement('span')
              message.textContent = `[${img.alt}：加载失败，请重新打开正文]`
              img.replaceWith(message)
            }
          }
        }
      }),
    )
  },
  { immediate: true, flush: 'post' },
)
onBeforeUnmount(() => {
  generation++
  clear()
})
</script>

<template>
  <div
    ref="root"
    class="markdown-content"
    :class="{ plain: format !== 'markdown' }"
    v-html="html"
  ></div>
</template>

<style scoped>
.markdown-content {
  min-width: 0;
  line-height: 1.8;
  overflow-wrap: anywhere;
}
.plain {
  white-space: pre-wrap;
}
.markdown-content :deep(img) {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 12px 0;
  border-radius: 6px;
}
.markdown-content :deep(pre) {
  padding: 14px;
  overflow-x: auto;
  background: #f5f7fa;
  border-radius: 6px;
  white-space: pre;
}
.markdown-content :deep(table) {
  display: block;
  max-width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
}
.markdown-content :deep(th),
.markdown-content :deep(td) {
  padding: 8px 12px;
  border: 1px solid #dcdfe6;
  min-width: 64px;
}
.markdown-content :deep(blockquote) {
  margin-left: 0;
  padding-left: 14px;
  border-left: 4px solid #c8d8d3;
  color: #606266;
}
.markdown-content :deep(a) {
  color: #15554e;
  text-decoration: underline;
}
.markdown-content :deep(ul),
.markdown-content :deep(ol) {
  padding-left: 24px;
}
</style>
