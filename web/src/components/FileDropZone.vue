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
    class="file-dropzone"
    :class="{ dragging, disabled }"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
  >
    <b>{{ modelValue ? modelValue.name : dragging ? '松开即可选用该文件' : placeholder }}</b>
    <slot />
  </label>
</template>

<style scoped>
.file-dropzone {
  display: block;
  border: 1px dashed #9bb8b2;
  border-radius: 12px;
  padding: 18px;
  text-align: center;
  cursor: pointer;
  background: #f7fbf9;
  transition:
    border-color 0.15s,
    background 0.15s,
    box-shadow 0.15s;
}
.file-dropzone:hover {
  border-color: #15554e;
}
.file-dropzone.dragging {
  border: 2px solid #15554e;
  background: #e8f3ef;
  box-shadow: 0 0 0 4px rgba(21, 85, 78, 0.08);
}
.file-dropzone.disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.file-dropzone.disabled:hover {
  border-color: #9bb8b2;
}
</style>
