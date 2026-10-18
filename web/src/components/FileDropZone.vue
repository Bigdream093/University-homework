<script setup>
import { onUnmounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'

const props = defineProps({
  modelValue: { type: [File, null], default: null },
  disabled: Boolean,
  placeholder: { type: String, default: '点击选择或拖拽文件到这里' },
  accept: { type: String, default: null },
  id: { type: String, default: () => `dropzone-${Math.random().toString(36).slice(2, 10)}` },
})
const emit = defineEmits(['update:modelValue'])

const dragging = ref(false)
let dragDepth = 0
const input = ref(null)

function emitFile(selected) {
  if (props.disabled) return
  if (!selected) return
  if (selected instanceof FileList) {
    if (selected.length > 1) ElMessage.warning('一次只能选择一个文件，已选用第一个')
    selected = selected[0]
  }
  emit('update:modelValue', selected || null)
}

function onChange(event) {
  emitFile(event.target.files)
}

function onDragEnter() {
  if (props.disabled) return
  dragDepth += 1
  dragging.value = true
}
function onDragLeave() {
  dragDepth = Math.max(0, dragDepth - 1)
  if (!dragDepth) dragging.value = false
}
function onDrop(event) {
  dragDepth = 0
  dragging.value = false
  emitFile(event.dataTransfer?.files)
}

function activateWithKeyboard(event) {
  if (props.disabled || !['Enter', ' '].includes(event.key)) return
  event.preventDefault()
  input.value?.click()
}

function formatSize(bytes) {
  if (bytes < 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

// 拖到上传框以外的区域时阻止浏览器默认打开文件。
function preventWindowDrop(event) {
  event.preventDefault()
}
window.addEventListener('dragover', preventWindowDrop)
window.addEventListener('drop', preventWindowDrop)
onUnmounted(() => {
  window.removeEventListener('dragover', preventWindowDrop)
  window.removeEventListener('drop', preventWindowDrop)
})

// 父组件把值置回空时清空 input，保证同一文件可以重复选择。
watch(
  () => props.modelValue,
  (value) => {
    if (!value && input.value) input.value.value = ''
  },
)
</script>

<template>
  <input
    :id="id"
    ref="input"
    type="file"
    hidden
    :accept="accept"
    :disabled="disabled"
    @change="onChange"
  />
  <label
    :for="id"
    class="upload-dropzone file-dropzone"
    :class="{ dragging, disabled }"
    role="button"
    tabindex="0"
    :aria-disabled="disabled"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
    @keydown="activateWithKeyboard"
  >
    <span class="upload-dropzone__icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none">
        <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v5h14v-5" />
      </svg>
    </span>
    <span class="upload-dropzone__main">
      <strong class="upload-dropzone__title">{{
        modelValue ? modelValue.name : dragging ? '松开即可选用该文件' : placeholder
      }}</strong>
      <span v-if="modelValue" class="upload-dropzone__selected">
        已选择 · {{ formatSize(modelValue.size) }} · 点击此处可更换
      </span>
    </span>
    <span v-if="$slots.default" class="upload-dropzone__details"><slot /></span>
  </label>
</template>
