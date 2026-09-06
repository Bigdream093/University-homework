<script setup>
import { onBeforeUnmount, ref, watch } from 'vue'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import api from '../api/request.js'

const props = defineProps(nodeViewProps)
const url = ref('')
const failed = ref(false)
let controller
let objectUrl
function clear() {
  controller?.abort()
  if (objectUrl) URL.revokeObjectURL(objectUrl)
  objectUrl = ''
  url.value = ''
}
watch(
  () => props.node.attrs.src,
  async (src) => {
    clear()
    failed.value = false
    if (/^https:\/\//i.test(src)) {
      url.value = src
      return
    }
    if (!/^\/api\/editor-images\//.test(src)) {
      failed.value = true
      return
    }
    controller = new AbortController()
    try {
      const { data } = await api.get(src.slice(4), {
        responseType: 'blob',
        signal: controller.signal,
      })
      objectUrl = URL.createObjectURL(data)
      url.value = objectUrl
    } catch (error) {
      if (error.name !== 'CanceledError') failed.value = true
    }
  },
  { immediate: true },
)
onBeforeUnmount(clear)
</script>

<template>
  <NodeViewWrapper class="rich-image" :class="{ selected }">
    <img v-if="url" :src="url" :alt="node.attrs.alt || '图片'" draggable="false" />
    <span v-else>{{ failed ? '图片加载失败' : '图片加载中…' }}</span>
  </NodeViewWrapper>
</template>

<style scoped>
.rich-image {
  display: block;
  margin: 12px 0;
}
.rich-image img {
  display: block;
  max-width: 100%;
  height: auto;
  border-radius: 6px;
}
.rich-image.selected img {
  outline: 2px solid #15554e;
  outline-offset: 2px;
}
</style>
