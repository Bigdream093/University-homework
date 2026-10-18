<script setup>
import { computed, onUnmounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import Sortable from 'sortablejs'
import ImagePreviewDialog from './ImagePreviewDialog.vue'
import { PREVIEW_EXTENSIONS, PREVIEW_MAX_BYTES } from '@university-homework/domain/limits'

// 预览图多选区：点击/拖拽多选、逐张删除、拖动排序（顺序即提交的 sort_order）。
const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  max: { type: Number, default: 3 },
  disabled: Boolean,
})
const emit = defineEmits(['update:modelValue'])
const items = ref([])
const dragging = ref(false)
const previewDialog = ref(false)
const activePreview = ref(null)
const galleryItems = computed(() =>
  items.value.map((item) => ({ name: item.file.name, file: item.file })),
)
const galleryIndex = computed(() =>
  Math.max(
    0,
    items.value.findIndex((item) => item.url === activePreview.value?.url),
  ),
)
let dragDepth = 0
const listEl = ref(null)
const inputId = `preview-picker-${Math.random().toString(36).slice(2, 10)}`
let sortable

function extOf(name) {
  const match = /\.([a-z0-9]+)$/i.exec(name || '')
  return match ? match[1].toLowerCase() : ''
}
function emitUpdate() {
  emit(
    'update:modelValue',
    items.value.map((item) => item.file),
  )
}
function addFiles(list) {
  if (props.disabled || !list || !list.length) return
  let wrongType = 0
  for (const file of list) {
    if (items.value.length >= props.max) {
      ElMessage.warning(`预览图最多 ${props.max} 张`)
      break
    }
    if (!PREVIEW_EXTENSIONS.includes(extOf(file.name))) {
      wrongType += 1
      continue
    }
    if (file.size > PREVIEW_MAX_BYTES) {
      ElMessage.warning(`“${file.name}”超过 20M，已跳过`)
      continue
    }
    items.value.push({ file, url: URL.createObjectURL(file) })
  }
  if (wrongType) ElMessage.warning(`预览图仅支持 jpg/png，已忽略 ${wrongType} 个文件`)
  emitUpdate()
}
function onChange(event) {
  addFiles(event.target.files)
  event.target.value = ''
}
function remove(index) {
  if (props.disabled) return
  const [removed] = items.value.splice(index, 1)
  if (activePreview.value?.url === removed.url) {
    previewDialog.value = false
    activePreview.value = null
  }
  URL.revokeObjectURL(removed.url)
  emitUpdate()
}
function showPreview(item) {
  activePreview.value = item
  previewDialog.value = true
}
function activateWithKeyboard(event) {
  if (props.disabled || !['Enter', ' '].includes(event.key)) return
  event.preventDefault()
  document.getElementById(inputId)?.click()
}
function onEnter() {
  if (!props.disabled) {
    dragDepth += 1
    dragging.value = true
  }
}
function onLeave() {
  dragDepth = Math.max(0, dragDepth - 1)
  if (!dragDepth) dragging.value = false
}
function onDrop(event) {
  dragDepth = 0
  dragging.value = false
  addFiles(event.dataTransfer?.files)
}
// 父组件清空（提交成功/切换作业）时同步清空本地列表。
watch(
  () => props.modelValue,
  (value) => {
    if (!value.length && items.value.length) {
      for (const item of items.value) URL.revokeObjectURL(item.url)
      items.value = []
      previewDialog.value = false
      activePreview.value = null
    }
  },
)
watch(listEl, (element) => {
  if (!element) return
  sortable = Sortable.create(element, {
    animation: 150,
    disabled: props.disabled,
    filter: '.preview-action',
    preventOnFilter: false,
    onEnd({ oldIndex, newIndex }) {
      if (props.disabled) {
        items.value = [...items.value]
        return
      }
      if (oldIndex === newIndex) return
      const moved = items.value.splice(oldIndex, 1)[0]
      items.value.splice(newIndex, 0, moved)
      emitUpdate()
    },
  })
})
watch(
  () => props.disabled,
  (disabled) => sortable?.option('disabled', disabled),
)
onUnmounted(() => {
  for (const item of items.value) URL.revokeObjectURL(item.url)
  sortable?.destroy()
})
const countText = computed(() => `已选 ${items.value.length}/${props.max} 张`)
</script>

<template>
  <div>
    <input
      :id="inputId"
      type="file"
      hidden
      multiple
      accept="image/jpeg,image/png"
      :disabled="disabled"
      @change="onChange"
    />
    <label
      :for="inputId"
      class="upload-dropzone file-dropzone preview-zone"
      :class="{ dragging, disabled }"
      role="button"
      tabindex="0"
      :aria-disabled="disabled"
      @dragenter.prevent="onEnter"
      @dragover.prevent
      @dragleave.prevent="onLeave"
      @drop.prevent="onDrop"
      @keydown="activateWithKeyboard"
    >
      <span class="upload-dropzone__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="8.5" cy="9" r="1.5" />
          <path d="m21 15-5-5L5 20" />
        </svg>
      </span>
      <span class="upload-dropzone__main">
        <strong class="upload-dropzone__title">{{
          dragging ? '松开即可加入图片' : '添加预览图片'
        }}</strong>
        <span class="upload-dropzone__selected">点击选择或拖拽图片到这里</span>
      </span>
      <span class="upload-dropzone__details">
        <span class="upload-dropzone__tag">{{
          max === 1 ? '需提交 1 张' : `需提交 1–${max} 张`
        }}</span>
        <span class="upload-dropzone__tag">JPG / PNG</span>
        <span class="upload-dropzone__tag">单张不超过 20 MB</span>
      </span>
    </label>
    <div class="preview-meta-row">
      <strong>{{ countText }}</strong>
      <span>拖动图片卡片调整顺序，老师会按此顺序查看</span>
    </div>
    <div ref="listEl" class="preview-thumbs" :class="{ disabled }">
      <div v-for="(item, index) in items" :key="item.url" class="preview-thumb">
        <button
          type="button"
          class="preview-thumb__image preview-action"
          :aria-label="`放大查看第 ${index + 1} 张预览图`"
          @click="showPreview(item)"
        >
          <img :src="item.url" :alt="`第 ${index + 1} 张预览图`" />
        </button>
        <span class="preview-order">{{ index + 1 }}</span>
        <button
          type="button"
          class="preview-remove preview-action"
          :disabled="disabled"
          :aria-label="`删除第 ${index + 1} 张预览图`"
          @click="remove(index)"
        >
          ×
        </button>
        <span class="preview-name" :title="item.file.name"
          >{{ item.file.name }} · {{ (item.file.size / 1024 / 1024).toFixed(1) }}M</span
        >
      </div>
    </div>
    <ImagePreviewDialog
      v-model="previewDialog"
      :previews="galleryItems"
      :initial-index="galleryIndex"
      title="预览图片"
    />
  </div>
</template>

<style scoped>
.preview-zone {
  min-height: 172px;
  border-radius: 14px;
}
.preview-zone .upload-dropzone__icon {
  background: #e6f1ed;
}
.preview-zone .upload-dropzone__icon svg {
  fill: none;
}
.preview-meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin: 12px 0 8px;
  color: #607873;
  font-size: 13px;
  line-height: 1.5;
}
.preview-meta-row strong {
  color: #28574f;
  font-size: 14px;
}
.preview-thumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.preview-thumbs.disabled {
  opacity: 0.6;
}
.preview-thumb {
  position: relative;
  width: 158px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: #fff;
  padding: 8px;
  cursor: grab;
}
.preview-thumb__image {
  display: block;
  width: 140px;
  height: 104px;
  overflow: hidden;
  border: 0;
  border-radius: 8px;
  padding: 0;
  background: #f2f6f4;
  cursor: zoom-in;
}
.preview-thumb__image img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.preview-order {
  position: absolute;
  top: 14px;
  left: 14px;
  display: grid;
  place-items: center;
  min-width: 24px;
  height: 24px;
  padding: 0 5px;
  border-radius: 6px;
  background: rgba(25, 53, 50, 0.82);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  pointer-events: none;
}
.preview-remove {
  position: absolute;
  top: 12px;
  right: 12px;
  border: 0;
  background: rgba(25, 53, 50, 0.84);
  color: #fff;
  border-radius: 50%;
  width: 28px;
  height: 28px;
  line-height: 26px;
  cursor: pointer;
  font-size: 18px;
  padding: 0;
}
.preview-remove:disabled {
  cursor: not-allowed;
  opacity: 0.58;
}
.preview-name {
  display: block;
  font-size: 12px;
  color: #607873;
  margin-top: 7px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.preview-image-large {
  display: block;
  max-width: 100%;
  max-height: 76vh;
  margin: 0 auto;
  object-fit: contain;
}
@media (max-width: 520px) {
  .preview-meta-row {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
