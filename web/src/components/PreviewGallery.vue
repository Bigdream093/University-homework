<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { loadPreviewBlob, normalizePreview } from '../utils/previewImages.js'
const props = defineProps({
  previews: { type: Array, default: () => [] },
  initialIndex: { type: Number, default: 0 },
  expandable: Boolean,
  keyboardActive: { type: Boolean, default: true },
})
const emit = defineEmits(['expand'])
const index = ref(0),
  source = ref(''),
  state = ref('loading'),
  error = ref(''),
  originalError = ref(''),
  zoom = ref(1),
  rotation = ref(0)
const offset = ref({ x: 0, y: 0 })
let drag = null
function startPan(event) {
  if (zoom.value <= 1 || state.value !== 'ready') return
  drag = { x: event.clientX - offset.value.x, y: event.clientY - offset.value.y }
  event.currentTarget.setPointerCapture(event.pointerId)
}
function pan(event) {
  if (drag) offset.value = { x: event.clientX - drag.x, y: event.clientY - drag.y }
}
function endPan() {
  drag = null
}
function resetView() {
  zoom.value = 1
  rotation.value = 0
  offset.value = { x: 0, y: 0 }
}
const images = computed(() => props.previews.map(normalizePreview))
const current = computed(() => images.value[index.value])
let sequence = 0,
  controller
function release() {
  if (source.value) URL.revokeObjectURL(source.value)
  source.value = ''
}
async function load() {
  const version = ++sequence
  controller?.abort()
  const activeController = new AbortController()
  controller = activeController
  release()
  resetView()
  error.value = ''
  originalError.value = ''
  if (!current.value) {
    state.value = 'empty'
    return
  }
  state.value = 'loading'
  const image = current.value
  let originalLoaded = false
  const thumbnailTask = loadPreviewBlob(image, {
    thumbnail: true,
    signal: activeController.signal,
  })
    .then((thumbnail) => {
      if (version !== sequence || originalLoaded || activeController.signal.aborted) return
      source.value = URL.createObjectURL(thumbnail)
      state.value = 'previewing'
    })
    .catch(() => {})
  try {
    const blob = await loadPreviewBlob(image, { signal: activeController.signal })
    if (version !== sequence) return
    originalLoaded = true
    activeController.abort()
    const previousSource = source.value
    source.value = URL.createObjectURL(blob)
    if (previousSource) URL.revokeObjectURL(previousSource)
    state.value = 'ready'
  } catch (cause) {
    await thumbnailTask
    if (version !== sequence) return
    if (source.value) {
      state.value = 'previewing'
      originalError.value = cause.message
    } else {
      state.value = 'error'
      error.value = cause.message
    }
  }
}
function step(delta) {
  index.value = (index.value + delta + images.value.length) % images.value.length
}
function failed() {
  state.value = 'error'
  error.value = '浏览器无法解码这张图片，请重试或联系教师检查原文件'
}
watch(
  () => [props.previews, props.initialIndex],
  () => {
    index.value = Math.max(0, Math.min(props.initialIndex, props.previews.length - 1))
    load()
  },
  { immediate: true },
)
watch(index, load)
function keyboard(event) {
  if (!props.keyboardActive) return
  if (event.target?.closest('input,textarea,[contenteditable=true]')) return
  if (event.key === 'ArrowLeft' && images.value.length > 1) {
    event.preventDefault()
    step(-1)
  }
  if (event.key === 'ArrowRight' && images.value.length > 1) {
    event.preventDefault()
    step(1)
  }
}
onMounted(() => window.addEventListener('keydown', keyboard))
onBeforeUnmount(() => {
  ++sequence
  controller?.abort()
  release()
  window.removeEventListener('keydown', keyboard)
})
</script>
<template>
  <section class="preview-gallery" aria-label="作业图片查看">
    <div
      class="preview-gallery-stage"
      :aria-busy="state === 'loading'"
      :style="{ touchAction: zoom > 1 ? 'none' : 'auto' }"
      @pointerdown="startPan"
      @pointermove="pan"
      @pointerup="endPan"
      @pointercancel="endPan"
    >
      <img
        v-if="state === 'ready' || state === 'previewing'"
        :src="source"
        :alt="current.name"
        :style="{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom}) rotate(${rotation}deg)`,
        }"
        @error="failed"
        @dragstart.prevent
        @click="expandable && zoom === 1 && emit('expand', index)"
      />
      <div v-else-if="state === 'loading'" class="preview-gallery-state" role="status">
        正在加载预览图…
      </div>
      <div v-else-if="state === 'error'" class="preview-gallery-state" role="alert">
        <span>{{ error }}</span
        ><el-button @click="load">重试图片</el-button>
      </div>
      <div v-else class="preview-gallery-state">该提交没有预览图，可查看答案或下载源文件。</div>
      <div v-if="state === 'previewing'" class="preview-gallery-progress" role="status">
        <template v-if="originalError">
          原图加载失败：{{ originalError }}
          <el-button size="small" @click="load">重试原图</el-button>
        </template>
        <template v-else>正在加载清晰原图…</template>
      </div>
    </div>
    <div v-if="images.length" class="preview-gallery-toolbar">
      <el-button size="small" :disabled="images.length < 2" @click="step(-1)">← 上一张</el-button>
      <span class="preview-gallery-counter">第 {{ index + 1 }} / {{ images.length }} 张</span>
      <el-button size="small" :disabled="images.length < 2" @click="step(1)">下一张 →</el-button>
      <span class="preview-gallery-tools">
        <el-button
          size="small"
          :disabled="state !== 'ready' || zoom <= 1"
          @click="zoom = Math.max(1, zoom - 0.25)"
          >缩小</el-button
        >
        <el-button size="small" :disabled="state !== 'ready' || zoom >= 4" @click="zoom += 0.25"
          >放大</el-button
        >
        <el-button size="small" :disabled="state !== 'ready'" @click="rotation += 90"
          >旋转</el-button
        >
        <el-button size="small" :disabled="state !== 'ready'" @click="resetView"
          >适应窗口</el-button
        >
        <el-button v-if="expandable" size="small" @click="emit('expand', index)"
          >大图查看</el-button
        >
      </span>
    </div>
    <p v-if="current" class="preview-gallery-name" :title="current.name">{{ current.name }}</p>
    <div v-if="images.length > 1" class="preview-gallery-pages">
      <button
        v-for="(image, position) in images"
        :key="image.id || position"
        type="button"
        :class="{ active: position === index }"
        :aria-label="`查看第 ${position + 1} 张预览图`"
        :aria-pressed="position === index"
        @click="index = position"
      >
        {{ position + 1 }}
      </button>
    </div>
  </section>
</template>
<style scoped>
.preview-gallery {
  min-width: 0;
}
.preview-gallery-stage {
  position: relative;
  height: min(58vh, 680px);
  min-height: 240px;
  overflow: hidden;
  display: grid;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #f3f6f5;
}
.preview-gallery-stage img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  min-height: 0;
  transition: transform 0.15s;
}
.preview-gallery-state {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 12px;
  padding: 24px;
  color: #637b74;
  text-align: center;
}
.preview-gallery-progress {
  position: absolute;
  right: 12px;
  bottom: 12px;
  left: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.92);
  color: #526f65;
  font-size: 13px;
}
.preview-gallery-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}
.preview-gallery-toolbar .el-button {
  margin: 0;
}
.preview-gallery-counter {
  font-size: 13px;
  color: #637b74;
}
.preview-gallery-tools {
  display: flex;
  gap: 6px;
  margin-left: auto;
}
.preview-gallery-name {
  color: #71847d;
  font-size: 12px;
  margin: 8px 0;
  overflow-wrap: anywhere;
}
.preview-gallery-pages {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.preview-gallery-pages button {
  min-width: 32px;
  height: 30px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: white;
  color: var(--green);
  cursor: pointer;
}
.preview-gallery-pages button.active {
  background: var(--green);
  color: white;
}
@media (max-width: 600px) {
  .preview-gallery-tools {
    margin-left: 0;
  }
}
</style>
