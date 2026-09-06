<script setup>
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { ElMessage } from 'element-plus'
import api, { messageOf } from '../api/request.js'
import MarkdownContent from './MarkdownContent.vue'

const props = defineProps({
  courseId: { type: [String, Number], required: true },
  label: { type: String, default: 'Markdown 正文' },
})
const model = defineModel({ type: String, required: true })
const emit = defineEmits(['busy'])
const mode = ref('split'),
  fullscreen = ref(false),
  input = ref(null),
  picker = ref(null)
const pending = ref(false),
  progress = ref(0),
  failures = ref([])
const busy = computed(() => pending.value || failures.value.length > 0)
let start = 0,
  end = 0,
  controller
function report() {
  emit('busy', busy.value)
}
function remember() {
  if (input.value) {
    start = input.value.selectionStart
    end = input.value.selectionEnd
  }
}
async function insert(text) {
  const value = model.value || ''
  model.value = value.slice(0, start) + text + value.slice(end)
  start += text.length
  end = start
  await nextTick()
  input.value?.focus()
  input.value?.setSelectionRange(start, end)
}
function syntax(before, after = '') {
  insert(before + (model.value || '').slice(start, end) + after)
}
async function uploadFiles(files) {
  if (pending.value) return
  const selected = [...files]
  if (!selected.length) return
  pending.value = true
  report()
  controller = new AbortController()
  const signal = controller.signal
  const courseId = props.courseId
  for (const file of selected) {
    if (signal.aborted) break
    if (
      !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
      file.size > 10 * 1024 * 1024
    ) {
      ElMessage.warning(`${file.name || '图片'}：仅支持 JPG、PNG、WebP，单张不超过 10 MB`)
      continue
    }
    progress.value = 0
    try {
      const body = new FormData()
      body.append('file', file)
      const { data } = await api.post(`/courses/${courseId}/editor-images`, body, {
        signal,
        onUploadProgress: (event) => {
          progress.value = Math.min(
            99,
            Math.round((event.loaded / (event.total || file.size)) * 100),
          )
        },
      })
      if (signal.aborted) break
      await insert(`\n\n![图片说明](${data.url})\n\n`)
      progress.value = 100
    } catch (error) {
      if (!signal.aborted) {
        failures.value.push(file)
        ElMessage.error(messageOf(error))
      }
    }
  }
  pending.value = false
  report()
}
function choose(event) {
  uploadFiles(event.target.files)
  event.target.value = ''
}
function paste(event) {
  if (event.clipboardData?.files.length) {
    event.preventDefault()
    remember()
    uploadFiles(event.clipboardData.files)
  }
}
function dragover(event) {
  if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault()
}
function drop(event) {
  if (event.dataTransfer?.files.length) {
    event.preventDefault()
    remember()
    uploadFiles(event.dataTransfer.files)
  }
}
function retry() {
  const files = failures.value
  failures.value = []
  uploadFiles(files)
}
function discard() {
  failures.value = []
  report()
}
onBeforeUnmount(() => {
  controller?.abort()
  emit('busy', false)
})
</script>

<template>
  <div class="markdown-editor" :class="{ fullscreen }">
    <div class="editor-toolbar">
      <el-radio-group v-model="mode" size="small" :disabled="pending">
        <el-radio-button value="edit">编辑</el-radio-button>
        <el-radio-button value="split">分栏</el-radio-button>
        <el-radio-button value="preview">预览</el-radio-button>
      </el-radio-group>
      <el-button size="small" :disabled="pending" @click="picker.click()">上传图片</el-button>
      <el-button size="small" :disabled="pending" @click="syntax('\n## 标题\n')">标题</el-button>
      <el-button size="small" :disabled="pending" @click="syntax('**', '**')">加粗</el-button>
      <el-button size="small" :disabled="pending" @click="syntax('\n- 列表项\n')">列表</el-button>
      <el-button
        size="small"
        :disabled="pending"
        @click="syntax('\n| 项目 | 要求 |\n| --- | --- |\n| 内容 | 说明 |\n')"
        >插入表格</el-button
      >
      <el-button size="small" @click="fullscreen = !fullscreen">{{
        fullscreen ? '退出全屏' : '全屏编辑'
      }}</el-button>
      <input
        ref="picker"
        class="file-picker"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        @change="choose"
      />
    </div>
    <div class="editor-body" :class="{ split: mode === 'split' }">
      <textarea
        v-show="mode !== 'preview'"
        ref="input"
        v-model="model"
        :aria-label="label"
        :readonly="pending"
        placeholder="支持 Markdown 标题、表格、列表；可粘贴截图或拖入图片。"
        @select="remember"
        @click="remember"
        @keyup="remember"
        @input="remember"
        @blur="remember"
        @paste="paste"
        @dragover="dragover"
        @drop="drop"
      />
      <div v-if="mode !== 'edit'" class="preview"><MarkdownContent :content="model" /></div>
    </div>
    <p class="editor-hint">
      图片支持选择、粘贴和拖拽，插入当前光标处。JPG / PNG / WebP，单张 ≤10 MB。表格支持普通行列。
    </p>
    <div v-if="pending" role="status">正在上传图片 {{ progress }}%，完成后可保存正文。</div>
    <div v-if="failures.length" role="alert">
      {{ failures.length }} 张图片上传失败，请重试或忽略后保存。
      <el-button :disabled="pending" @click="retry">重试</el-button>
      <el-button :disabled="pending" @click="discard">忽略失败图片</el-button>
    </div>
  </div>
</template>

<style scoped>
.markdown-editor {
  width: 100%;
  min-width: 0;
}
.fullscreen {
  position: fixed;
  inset: 0;
  z-index: 4000;
  padding: 20px;
  box-sizing: border-box;
  background: white;
  overflow: auto;
}
.editor-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}
.editor-toolbar :deep(.el-button + .el-button) {
  margin-left: 0;
}
.file-picker {
  display: none;
}
.editor-body {
  display: grid;
  gap: 16px;
}
.editor-body.split {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}
textarea {
  width: 100%;
  min-height: 380px;
  padding: 12px;
  box-sizing: border-box;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  resize: vertical;
  font: inherit;
  line-height: 1.7;
  color: #303133;
}
textarea:focus {
  outline: 2px solid #15554e;
  outline-offset: 1px;
}
.preview {
  min-width: 0;
  min-height: 380px;
  max-height: 60vh;
  overflow: auto;
  padding: 12px;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  box-sizing: border-box;
}
.fullscreen textarea,
.fullscreen .preview {
  height: 75vh;
  max-height: none;
}
.editor-hint {
  margin: 8px 0;
  color: #606266;
  font-size: 12px;
  line-height: 1.6;
}
@media (max-width: 768px) {
  .editor-body.split {
    grid-template-columns: minmax(0, 1fr);
  }
  textarea,
  .preview {
    min-height: 260px;
  }
}
</style>
