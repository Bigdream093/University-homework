<script setup>
import { computed, onUnmounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import Sortable from 'sortablejs'

// 预览图多选区：点击/拖拽多选、逐张删除、拖动排序（顺序即提交的 sort_order）。
const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  max: { type: Number, default: 3 },
  disabled: Boolean,
})
const emit = defineEmits(['update:modelValue'])
const PREVIEW_EXTS = ['jpg', 'jpeg', 'png']
const PREVIEW_MAX_BYTES = 20 * 1024 * 1024
const items = ref([])
const dragging = ref(false)
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
    if (!PREVIEW_EXTS.includes(extOf(file.name))) {
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
  URL.revokeObjectURL(items.value[index].url)
  items.value.splice(index, 1)
  emitUpdate()
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
    }
  },
)
watch(listEl, (element) => {
  if (!element) return
  sortable = Sortable.create(element, {
    animation: 150,
    disabled: props.disabled,
    onEnd({ oldIndex, newIndex }) {
      if (oldIndex === newIndex) return
      const moved = items.value.splice(oldIndex, 1)[0]
      items.value.splice(newIndex, 0, moved)
      emitUpdate()
    },
  })
})
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
      class="file-dropzone preview-zone"
      :class="{ dragging, disabled }"
      @dragenter.prevent="onEnter"
      @dragover.prevent
      @dragleave.prevent="onLeave"
      @drop.prevent="onDrop"
    >
      <b>{{ dragging ? '松开即可加入这些图片' : '点击选择或拖拽图片到这里（可多选）' }}</b
      ><br />
      <span class="hint">需交 1-{{ max }} 张，仅 jpg/png，单张不超过 20M</span>
    </label>
    <p class="hint" style="margin: 10px 0 6px">
      {{ countText }}，拖动缩略图可调整顺序（老师按此顺序查看）
    </p>
    <div ref="listEl" class="preview-thumbs" :class="{ disabled }">
      <div v-for="(item, index) in items" :key="item.url" class="preview-thumb">
        <img :src="item.url" alt="预览图缩略" />
        <button type="button" class="preview-remove" :disabled="disabled" @click="remove(index)">
          ×
        </button>
        <span class="preview-name" :title="item.file.name"
          >{{ item.file.name }} · {{ (item.file.size / 1024 / 1024).toFixed(1) }}M</span
        >
      </div>
    </div>
  </div>
</template>

<style scoped>
.preview-zone {
  border-radius: 14px;
  padding: 22px 15px;
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
  width: 108px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #fff;
  padding: 6px;
  cursor: grab;
}
.preview-thumb img {
  width: 94px;
  height: 70px;
  object-fit: cover;
  border-radius: 6px;
  display: block;
}
.preview-remove {
  position: absolute;
  top: 2px;
  right: 6px;
  border: 0;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  border-radius: 50%;
  width: 20px;
  height: 20px;
  line-height: 18px;
  cursor: pointer;
  font-size: 14px;
  padding: 0;
}
.preview-name {
  display: block;
  font-size: 11px;
  color: #7d8d89;
  margin-top: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
