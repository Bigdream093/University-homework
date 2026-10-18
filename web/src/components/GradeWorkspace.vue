<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { messageOf } from '../api/request.js'
import PreviewGallery from './PreviewGallery.vue'
import ImagePreviewDialog from './ImagePreviewDialog.vue'
import { gradeSubmission, returnSubmission } from '../api/grading.js'
import RequiredAnswerContent from './RequiredAnswerContent.vue'
import { displayFileName as displayFileNameOf, sourceFilesOf } from '../utils/submissionFiles.js'
import { readUser } from '../utils/session.js'
import { parseGradeScore } from '../utils/grading.js'

const props = defineProps({
  modelValue: Boolean,
  row: { type: Object, default: null },
  rows: { type: Array, default: () => [] },
  assignment: { type: Object, default: () => ({}) },
  initialIntent: { type: String, default: 'view' },
  readonly: Boolean,
})
const emit = defineEmits(['update:modelValue', 'saved', 'download-file'])

const form = reactive({ score: null, comment: '', returned_reason: '' })
const saving = ref(false)
const previewOpen = ref(false)
const previewIndex = ref(0)
function openImages(index) {
  previewIndex.value = index
  previewOpen.value = true
}
const draftSaved = ref(false)
const intent = ref('view')
const editingExisting = ref(false)
let settingForm = false
let baseline = ''

const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value),
})
const previews = computed(() => props.row?.previews || [])
const sourceFiles = computed(() => (props.row ? sourceFilesOf(props.row) : []))
const displayName = (file) => displayFileNameOf(props.row, file)
const archived = computed(() => props.readonly || props.assignment.course_status === 'archived')
const canEdit = computed(
  () =>
    !archived.value &&
    (props.row?.status === 'submitted' ||
      (props.row?.status === 'graded' && editingExisting.value)),
)
const statusText = computed(
  () =>
    ({ submitted: '待批改', graded: '已经评分', returned: '已经退回' })[props.row?.status] ||
    '状态未知',
)

const draftKey = () =>
  `draft:grading:${readUser()?.id || 'guest'}:${props.assignment?.id || ''}:${props.row?.api_base || 'none'}:workspace`
function readDraft() {
  try {
    return JSON.parse(sessionStorage.getItem(draftKey()) || 'null')
  } catch {
    return null
  }
}
function writeDraft(value) {
  try {
    if (value) sessionStorage.setItem(draftKey(), value)
    else sessionStorage.removeItem(draftKey())
  } catch {}
}
const formSnapshot = () =>
  JSON.stringify({
    score: form.score,
    comment: form.comment,
    returned_reason: form.returned_reason,
  })

function setForm(row, restoreDraft) {
  const initial = {
    score: row?.score ?? null,
    comment: row?.comment || '',
    returned_reason: row?.returned_reason || '',
  }
  baseline = JSON.stringify(initial)
  const saved = restoreDraft ? readDraft() : null
  settingForm = true
  Object.assign(form, saved || initial)
  settingForm = false
  draftSaved.value = !!saved && JSON.stringify(saved) !== baseline
}

function openRow(row, openingIntent) {
  if (!row) return
  editingExisting.value = false
  if (row.status === 'submitted' && !archived.value) {
    intent.value = openingIntent === 'return' ? 'return' : 'grade'
    setForm(row, true)
  } else {
    intent.value = 'view'
    setForm(row, false)
  }
}

watch(
  [visible, () => props.row, () => props.initialIntent],
  ([isVisible, row, openingIntent]) => {
    if (isVisible) openRow(row, openingIntent)
  },
  { immediate: true },
)
watch(
  [visible, canEdit, () => form.score, () => form.comment, () => form.returned_reason],
  () => {
    if (!visible.value || !canEdit.value || settingForm || !props.row) return
    const snapshot = formSnapshot()
    if (snapshot === baseline) {
      writeDraft('')
      draftSaved.value = false
    } else {
      writeDraft(snapshot)
      draftSaved.value = true
    }
  },
  { flush: 'sync' },
)

function beginEditing() {
  if (archived.value || props.row?.status !== 'graded') return
  editingExisting.value = true
  intent.value = 'grade'
  setForm(props.row, true)
}
function discardDraft() {
  if (props.row) writeDraft('')
  editingExisting.value = props.row?.status === 'graded' ? editingExisting.value : false
  setForm(props.row, false)
}
async function persist(kind) {
  if (saving.value || !canEdit.value) return false
  const score = kind === 'grade' ? parseGradeScore(form.score, props.assignment.total_score) : null
  if (kind === 'grade') {
    if (score === null) {
      ElMessage.warning(`成绩必须在 0 到 ${props.assignment.total_score} 之间`)
      return false
    }
  } else if (!String(form.returned_reason || '').trim()) {
    ElMessage.warning('请填写退回原因，学生会看到这条说明')
    return false
  }

  if (kind === 'return') {
    try {
      await ElMessageBox.confirm('退回后，学生需要修改并重新提交。', '确认退回作业', {
        type: 'warning',
        confirmButtonText: '确认退回',
        cancelButtonText: '继续批改',
      })
    } catch {
      return false
    }
  }

  saving.value = true
  try {
    if (kind === 'grade')
      await gradeSubmission(props.assignment.id, props.row, {
        score,
        comment: form.comment,
      })
    else
      await returnSubmission(props.assignment.id, props.row, {
        returned_reason: form.returned_reason,
      })
    writeDraft('')
    draftSaved.value = false
    ElMessage.success(kind === 'grade' ? '批改已保存' : '作业已退回')
    return {
      ...props.row,
      status: kind === 'grade' ? 'graded' : 'returned',
      score,
      comment: kind === 'grade' ? form.comment : '',
      returned_reason: kind === 'return' ? form.returned_reason : '',
    }
  } catch (error) {
    ElMessage.error(messageOf(error))
    return false
  } finally {
    saving.value = false
  }
}

async function saveAndNext() {
  if (props.row?.status !== 'submitted') return
  const savedRow = await persist('grade')
  if (!savedRow) return
  const list = props.rows.filter((row) => row.id && row.status === 'submitted')
  const position = list.findIndex((row) => row.api_base === props.row.api_base)
  const next = list.slice(position + 1).find((row) => !row.is_test_student) || null
  emit('saved', savedRow, true, next)
}
async function submit(kind) {
  const savedRow = await persist(kind)
  if (savedRow) {
    emit('saved', savedRow, false, null)
    visible.value = false
  }
}
</script>

<template>
  <el-dialog
    v-model="visible"
    class="grading-workspace-dialog"
    :title="`作业批改 · ${row?.name || row?.name_snapshot || row?.username || ''}`"
    width="min(1600px,98vw)"
    top="2vh"
    append-to-body
    :close-on-click-modal="false"
  >
    <div class="workspace">
      <div class="viewer">
        <div class="submission-heading">
          <div>
            <b>{{ row?.username }} {{ row?.name }}</b>
            <span v-if="row?.members?.length" class="hint">
              · {{ row.members.map((member) => member.name).join('、') }}
            </span>
          </div>
          <el-tag
            :type="
              row?.status === 'graded' ? 'success' : row?.status === 'returned' ? 'warning' : ''
            "
          >
            {{ statusText }}<span v-if="row?.is_late && row?.status !== 'returned'"> · 迟交</span>
          </el-tag>
        </div>

        <PreviewGallery
          :previews="previews"
          expandable
          :keyboard-active="!previewOpen"
          @expand="openImages"
        />
        <ImagePreviewDialog
          v-model="previewOpen"
          :previews="previews"
          :initial-index="previewIndex"
          :title="`作业图片 · ${row?.name || ''}`"
        />

        <section v-if="row?.answer_question || row?.content" class="answer-content">
          <h3>答案</h3>
          <RequiredAnswerContent :questions="row.answer_question" :content="row.content" />
        </section>
        <section class="submission-meta hint">
          <span>提交时间：{{ row?.submitted_at || '—' }}</span>
          <span>第 {{ row?.submit_count || 1 }} 次提交</span>
          <span>实际提交人：{{ row?.submitted_by_name || row?.name || '—' }}</span>
        </section>
        <section v-if="row?.status === 'returned'" class="returned-note">
          <b>退回原因</b>
          <p>{{ row.returned_reason || '老师未填写退回原因。' }}</p>
        </section>
        <section v-if="sourceFiles.length" class="source-files">
          <b>源文件</b>
          <el-button
            v-for="file in sourceFiles"
            :key="file.history_id || file.file_name"
            link
            type="primary"
            @click="emit('download-file', row, file)"
          >
            下载 {{ displayName(file) || '作业文件' }}
          </el-button>
        </section>
      </div>

      <aside class="grade-panel">
        <div v-if="canEdit && (row?.status === 'submitted' || editingExisting)" class="intent-tabs">
          <el-button :type="intent === 'grade' ? 'primary' : 'default'" @click="intent = 'grade'">
            评分
          </el-button>
          <el-button :type="intent === 'return' ? 'warning' : 'default'" @click="intent = 'return'">
            退回重做
          </el-button>
        </div>
        <div
          v-else-if="row?.status === 'graded' && !editingExisting && !archived"
          class="view-state"
        >
          <b>已评分：{{ row.score ?? '—' }} / {{ assignment.total_score }}</b>
          <p>{{ row.comment || '老师未填写评语。' }}</p>
          <el-button type="primary" color="#15554e" @click="beginEditing">修改评分</el-button>
        </div>
        <div v-else-if="row?.status === 'returned'" class="view-state">
          <b>作业已经退回</b>
          <p>等待学生修改并重新提交。</p>
        </div>
        <p v-if="draftSaved && canEdit" class="hint draft-hint">
          已恢复未保存的批改草稿，保存后才会更新成绩。
        </p>

        <template v-if="canEdit && intent === 'grade'">
          <el-form label-position="top" :disabled="saving">
            <el-form-item :label="`成绩（满分 ${assignment.total_score}）`">
              <el-input-number
                v-model="form.score"
                :min="0"
                :max="assignment.total_score"
                style="width: 100%"
              />
            </el-form-item>
            <el-form-item label="评语（仅教师端保存）">
              <el-input v-model="form.comment" type="textarea" :rows="5" />
            </el-form-item>
          </el-form>
        </template>
        <template v-else-if="canEdit && intent === 'return'">
          <el-form label-position="top" :disabled="saving">
            <el-form-item label="退回原因（学生可见，必填）">
              <el-input
                v-model="form.returned_reason"
                type="textarea"
                :rows="7"
                placeholder="说明需要修改的内容"
              />
            </el-form-item>
          </el-form>
        </template>
        <p v-else-if="archived" class="hint">课程已归档，评分内容只读。</p>
        <p v-else-if="row?.status === 'returned'" class="hint">
          学生重新提交后，这份作业会重新进入待批改。
        </p>

        <div v-if="canEdit" class="grade-actions">
          <el-button :disabled="saving" @click="discardDraft">放弃草稿</el-button>
          <el-button
            v-if="intent === 'return'"
            type="warning"
            :loading="saving"
            @click="submit('return')"
          >
            确认退回
          </el-button>
          <template v-else>
            <el-button type="primary" color="#15554e" :loading="saving" @click="submit('grade')">
              保存评分
            </el-button>
            <el-button
              v-if="row?.status === 'submitted'"
              type="success"
              :loading="saving"
              @click="saveAndNext"
            >
              保存并下一份待批改
            </el-button>
          </template>
        </div>
      </aside>
    </div>
    <template #footer>
      <el-button @click="visible = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.workspace {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(300px, 1fr);
  gap: 20px;
  align-items: start;
}
:global(.grading-workspace-dialog .el-dialog__body) {
  max-height: 82vh;
  overflow-y: auto;
}
.submission-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.answer-content,
.returned-note,
.source-files {
  margin-top: 14px;
  padding: 12px 14px;
  border-radius: 10px;
  background: #f7faf8;
}
.answer-content h3 {
  margin: 0 0 8px;
  font-size: 16px;
}
.submission-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  margin-top: 12px;
}
.returned-note {
  color: #995e1f;
  background: #fff7e9;
}
.returned-note p {
  margin: 6px 0 0;
  white-space: pre-wrap;
}
.source-files {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}
.grade-panel {
  position: sticky;
  top: 0;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: #fbfcfb;
}
.intent-tabs,
.grade-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
.intent-tabs .el-button,
.grade-actions .el-button {
  flex: 1;
  margin-left: 0;
}
.grade-actions {
  margin-top: 14px;
  flex-wrap: wrap;
}
.view-state {
  margin-bottom: 12px;
}
.view-state p {
  white-space: pre-wrap;
  color: #65736f;
}
.draft-hint {
  color: #2f7d5f;
}
@media (max-width: 1000px) {
  .workspace {
    grid-template-columns: 1fr;
  }
  .grade-panel {
    position: static;
  }
}
</style>
