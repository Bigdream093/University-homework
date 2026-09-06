<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { EditorContent, VueNodeViewRenderer, useEditor } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table'
import TextAlign from '@tiptap/extension-text-align'
import { Color, TextStyle } from '@tiptap/extension-text-style'
import Highlight from '@tiptap/extension-highlight'
import { ElMessage } from 'element-plus'
import api, { messageOf } from '../api/request.js'
import RichTextImageNode from './RichTextImageNode.vue'

const props = defineProps({
  courseId: { type: [String, Number], required: true },
  label: { type: String, default: '富文本正文' },
})
const model = defineModel({ type: String, required: true })
const emit = defineEmits(['busy'])
const fullscreen = ref(false)
const pending = ref(false)
const progress = ref(0)
const failures = ref([])
const picker = ref(null)
const dragging = ref(false)
const busy = computed(() => pending.value || failures.value.length > 0)
let controller

const AuthImage = Image.extend({
  addNodeView() {
    return VueNodeViewRenderer(RichTextImageNode)
  },
})

function transferImages(transfer) {
  const found = []
  const keys = new Set()
  const add = (file) => {
    if (!file || !file.type?.startsWith('image/')) return
    const key = `${file.name}|${file.type}|${file.size}|${file.lastModified}`
    if (!keys.has(key)) {
      keys.add(key)
      found.push(file)
    }
  }
  for (const file of transfer?.files || []) add(file)
  for (const item of transfer?.items || []) {
    if (item.kind === 'file' && item.type?.startsWith('image/')) add(item.getAsFile?.())
  }
  return found
}

async function uploadFiles(files, position) {
  if (pending.value || !files.length) return
  pending.value = true
  emit('busy', true)
  editor.value?.setEditable(false)
  controller = new AbortController()
  const signal = controller.signal
  let insertAt = position ?? editor.value?.state.selection.from ?? 0
  for (const file of files) {
    if (signal.aborted) break
    if (
      !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
      file.size > 10 * 1024 * 1024
    ) {
      ElMessage.warning(`${file.name || '剪贴板图片'}：仅支持 JPG、PNG、WebP，单张不超过 10 MB`)
      continue
    }
    progress.value = 0
    try {
      const body = new FormData()
      body.append('file', file, file.name || `clipboard-${Date.now()}.png`)
      const { data } = await api.post(`/courses/${props.courseId}/editor-images`, body, {
        signal,
        onUploadProgress: (event) => {
          progress.value = Math.min(
            99,
            Math.round((event.loaded / (event.total || file.size)) * 100),
          )
        },
      })
      if (signal.aborted) break
      editor.value
        ?.chain()
        .insertContentAt(insertAt, {
          type: 'image',
          attrs: { src: data.url, alt: file.name || '图片' },
        })
        .run()
      insertAt += 1
      progress.value = 100
    } catch (error) {
      if (!signal.aborted) {
        failures.value.push(file)
        ElMessage.error(messageOf(error))
      }
    }
  }
  pending.value = false
  editor.value?.setEditable(true)
  editor.value?.commands.focus(insertAt)
  emit('busy', busy.value)
}

const editor = useEditor({
  content: model.value || '',
  extensions: [
    StarterKit.configure({ link: false, underline: false }),
    Underline,
    Link.configure({ openOnClick: false, autolink: true, defaultProtocol: 'https' }),
    AuthImage.configure({ allowBase64: false }),
    TableKit.configure({ table: { resizable: true, lastColumnResizable: true } }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    TextStyle,
    Color,
    Highlight.configure({ multicolor: true }),
  ],
  editorProps: {
    attributes: {
      class: 'rich-editor-surface',
      role: 'textbox',
      'aria-label': props.label,
      'aria-multiline': 'true',
    },
    handlePaste(view, event) {
      const files = transferImages(event.clipboardData)
      if (!files.length) return false
      uploadFiles(files, view.state.selection.from)
      return true
    },
  },
  onUpdate: ({ editor: current }) => {
    model.value = current.getHTML()
  },
})

watch(model, (value) => {
  if (editor.value && value !== editor.value.getHTML())
    editor.value.commands.setContent(value || '', { emitUpdate: false })
})
function command(run) {
  run(editor.value?.chain().focus())?.run()
}
function setLink() {
  const previous = editor.value?.getAttributes('link').href || ''
  const href = window.prompt('请输入链接地址', previous)
  if (href === null) return
  if (!href.trim()) command((chain) => chain.unsetLink())
  else command((chain) => chain.extendMarkRange('link').setLink({ href: href.trim() }))
}
function choose(event) {
  uploadFiles([...event.target.files])
  event.target.value = ''
}
function retry() {
  const files = failures.value
  failures.value = []
  uploadFiles(files)
}
function discard() {
  failures.value = []
  emit('busy', pending.value)
}
function onDragOver(event) {
  if (
    transferImages(event.dataTransfer).length ||
    [...(event.dataTransfer?.types || [])].includes('Files')
  ) {
    event.preventDefault()
    dragging.value = true
  }
}
function onDragLeave(event) {
  if (!event.currentTarget.contains(event.relatedTarget)) dragging.value = false
}
function onDrop(event) {
  dragging.value = false
  const files = transferImages(event.dataTransfer)
  if (!files.length) return
  event.preventDefault()
  const position = editor.value?.view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
  uploadFiles(files, position)
}
onBeforeUnmount(() => {
  controller?.abort()
  editor.value?.destroy()
  emit('busy', false)
})
</script>

<template>
  <div
    class="rich-text-editor"
    :class="{ fullscreen, dragging }"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div v-if="editor" class="editor-toolbar">
      <el-button size="small" @click="command((c) => c.undo())">撤销</el-button>
      <el-button size="small" @click="command((c) => c.redo())">重做</el-button>
      <el-select
        size="small"
        style="width: 105px"
        placeholder="段落格式"
        @change="
          (value) =>
            command((c) =>
              value === 'paragraph' ? c.setParagraph() : c.toggleHeading({ level: Number(value) }),
            )
        "
      >
        <el-option label="正文" value="paragraph" /><el-option label="标题 1" value="1" /><el-option
          label="标题 2"
          value="2"
        /><el-option label="标题 3" value="3" />
      </el-select>
      <el-button
        size="small"
        :type="editor.isActive('bold') ? 'primary' : ''"
        @click="command((c) => c.toggleBold())"
        >加粗</el-button
      >
      <el-button
        size="small"
        :type="editor.isActive('italic') ? 'primary' : ''"
        @click="command((c) => c.toggleItalic())"
        >斜体</el-button
      >
      <el-button
        size="small"
        :type="editor.isActive('underline') ? 'primary' : ''"
        @click="command((c) => c.toggleUnderline())"
        >下划线</el-button
      >
      <el-button size="small" @click="command((c) => c.toggleBulletList())">项目符号</el-button>
      <el-button size="small" @click="command((c) => c.toggleOrderedList())">编号</el-button>
      <el-button size="small" @click="command((c) => c.setTextAlign('left'))">左对齐</el-button>
      <el-button size="small" @click="command((c) => c.setTextAlign('center'))">居中</el-button>
      <el-button size="small" @click="command((c) => c.setTextAlign('right'))">右对齐</el-button>
      <el-button size="small" @click="setLink">链接</el-button>
      <label class="color-control"
        >文字色<input type="color" @input="command((c) => c.setColor($event.target.value))"
      /></label>
      <el-button size="small" @click="picker.click()">插入图片</el-button>
      <el-button
        size="small"
        @click="command((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }))"
        >插入表格</el-button
      >
      <template v-if="editor.isActive('table')">
        <el-button size="small" @click="command((c) => c.addRowAfter())">下方加行</el-button>
        <el-button size="small" @click="command((c) => c.addColumnAfter())">右侧加列</el-button>
        <el-button size="small" @click="command((c) => c.deleteRow())">删除行</el-button>
        <el-button size="small" @click="command((c) => c.deleteColumn())">删除列</el-button>
        <el-button
          size="small"
          :disabled="!editor.can().mergeCells()"
          @click="command((c) => c.mergeCells())"
          >合并单元格</el-button
        >
        <el-button
          size="small"
          :disabled="!editor.can().splitCell()"
          @click="command((c) => c.splitCell())"
          >拆分单元格</el-button
        >
        <el-button size="small" type="danger" plain @click="command((c) => c.deleteTable())"
          >删除表格</el-button
        >
      </template>
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
    <div class="editor-frame">
      <EditorContent :editor="editor" />
      <div v-if="dragging" class="drop-mask">松开以上传图片</div>
    </div>
    <p class="editor-hint">
      可直接编辑排版；支持选择图片、粘贴截图或 PPT
      图片、拖入图片。表格可合并、拆分单元格并拖动列边界。
    </p>
    <div v-if="pending" role="status">正在上传图片 {{ progress }}%，完成后可保存正文。</div>
    <div v-if="failures.length" role="alert">
      {{ failures.length }} 张图片上传失败。<el-button :disabled="pending" @click="retry"
        >重试</el-button
      ><el-button :disabled="pending" @click="discard">忽略</el-button>
    </div>
  </div>
</template>

<style scoped>
.rich-text-editor {
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
  gap: 7px;
  margin-top: 10px;
  margin-bottom: 10px;
}
.editor-toolbar :deep(.el-button + .el-button) {
  margin-left: 0;
}
.file-picker {
  display: none;
}
.color-control {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: #606266;
}
.color-control input {
  width: 28px;
  height: 26px;
  padding: 1px;
  border: 1px solid #dcdfe6;
  background: white;
}
.editor-frame {
  position: relative;
  overflow-x: auto;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  background: white;
}
.rich-text-editor :deep(.rich-editor-surface) {
  min-height: 420px;
  padding: 16px;
  box-sizing: border-box;
  outline: none;
  line-height: 1.7;
}
.rich-text-editor :deep(.rich-editor-surface > *:first-child) {
  margin-top: 0;
}
.rich-text-editor :deep(.tableWrapper) {
  overflow-x: auto;
  margin: 14px 0;
}
.rich-text-editor :deep(table) {
  border-collapse: collapse;
  table-layout: fixed;
  width: max-content;
  min-width: 100%;
}
.rich-text-editor :deep(th),
.rich-text-editor :deep(td) {
  position: relative;
  min-width: 64px;
  padding: 8px 12px;
  border: 1px solid #bfc4cc;
  vertical-align: top;
}
.rich-text-editor :deep(.selectedCell::after) {
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
  content: '';
  background: rgba(21, 85, 78, 0.16);
}
.rich-text-editor :deep(.column-resize-handle) {
  position: absolute;
  top: 0;
  right: -2px;
  bottom: -2px;
  width: 4px;
  z-index: 4;
  background: #15554e;
  pointer-events: none;
}
.rich-text-editor :deep(.resize-cursor) {
  cursor: col-resize;
}
.rich-text-editor :deep(img) {
  max-width: 100%;
  height: auto;
}
.drop-mask {
  position: absolute;
  inset: 8px;
  z-index: 10;
  display: grid;
  place-items: center;
  border: 2px dashed #15554e;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.9);
  color: #15554e;
  font-weight: 700;
  pointer-events: none;
}
.editor-hint {
  margin: 8px 0;
  color: #606266;
  font-size: 12px;
  line-height: 1.6;
}
.fullscreen .editor-frame {
  min-height: calc(100vh - 150px);
}
.fullscreen :deep(.rich-editor-surface) {
  min-height: calc(100vh - 170px);
}
@media (max-width: 768px) {
  .rich-text-editor :deep(.rich-editor-surface) {
    min-height: 300px;
    padding: 12px;
  }
}
</style>
