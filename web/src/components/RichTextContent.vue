<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import api from '../api/request.js'
import { renderRichText } from '../utils/richText.js'

const props = defineProps({ content: { type: String, default: '' } })
const root = ref(null)
const html = computed(() => renderRichText(props.content))
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
    const sources = [...new Set(images.map((image) => image.dataset.editorSrc))]
    let cursor = 0
    await Promise.all(
      Array.from({ length: Math.min(4, sources.length) }, async () => {
        while (cursor < sources.length && !signal.aborted) {
          const src = sources[cursor++]
          const targets = images.filter((image) => image.dataset.editorSrc === src)
          try {
            const { data } = await api.get(src.slice(4), { responseType: 'blob', signal })
            if (current !== generation) return
            const url = URL.createObjectURL(data)
            urls.add(url)
            for (const image of targets) image.src = url
          } catch {
            for (const image of targets)
              image.replaceWith(document.createTextNode('[图片加载失败]'))
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

<template><div ref="root" class="rich-text-content" v-html="html"></div></template>

<style scoped>
.rich-text-content {
  min-width: 0;
  line-height: 1.8;
  overflow-wrap: anywhere;
}
.rich-text-content :deep(img) {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 12px 0;
  border-radius: 6px;
}
.rich-text-content :deep(pre) {
  padding: 14px;
  overflow-x: auto;
  background: #f5f7fa;
  border-radius: 6px;
  white-space: pre;
}
.rich-text-content :deep(.tableWrapper),
.rich-text-content {
  overflow-x: auto;
}
.rich-text-content :deep(table) {
  border-collapse: collapse;
  table-layout: fixed;
  width: max-content;
  min-width: 100%;
}
.rich-text-content :deep(th),
.rich-text-content :deep(td) {
  min-width: 64px;
  padding: 8px 12px;
  border: 1px solid #dcdfe6;
  vertical-align: top;
}
.rich-text-content :deep(blockquote) {
  margin-left: 0;
  padding-left: 14px;
  border-left: 4px solid #c8d8d3;
  color: #606266;
}
.rich-text-content :deep(a) {
  color: #15554e;
  text-decoration: underline;
}
.rich-text-content :deep(ul),
.rich-text-content :deep(ol) {
  padding-left: 24px;
}
</style>
