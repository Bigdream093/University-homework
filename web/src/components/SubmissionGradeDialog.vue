<script setup>
import { onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import api, { messageOf } from '../api/request.js'
import { readUser } from '../utils/session.js'
const props = defineProps({ assignment: { type: Object, required: true } })
const emit = defineEmits(['saved'])
const dialog = ref(false),
  mode = ref('grade'),
  current = ref({}),
  saving = ref(false)
const form = reactive({ score: null, comment: '', returned_reason: '' })
const editDraftSaved = ref(false)
let settingEditForm = false
let editBaseline = ''
const editDraftKey = () =>
  `draft:grading:${readUser()?.id || 'guest'}:${props.assignment.id}:${current.value.api_base || 'none'}:${mode.value}`
const editSnapshot = () =>
  JSON.stringify({
    score: form.score,
    comment: form.comment,
    returned_reason: form.returned_reason,
  })

function open(row, type) {
  current.value = row
  mode.value = type
  const initial = {
    score: row.score,
    comment: row.comment || '',
    returned_reason: row.returned_reason || '',
  }
  editBaseline = JSON.stringify(initial)
  let saved
  try {
    saved = JSON.parse(sessionStorage.getItem(editDraftKey()) || 'null')
  } catch {
    saved = null
  }
  settingEditForm = true
  Object.assign(form, saved || initial)
  settingEditForm = false
  editDraftSaved.value = !!saved && JSON.stringify(saved) !== editBaseline
  dialog.value = true
}

watch(
  [dialog, () => form.score, () => form.comment, () => form.returned_reason],
  () => {
    if (!dialog.value || settingEditForm) return
    const snapshot = editSnapshot()
    if (snapshot === editBaseline) {
      sessionStorage.removeItem(editDraftKey())
      editDraftSaved.value = false
    } else {
      sessionStorage.setItem(editDraftKey(), snapshot)
      editDraftSaved.value = true
    }
  },
  { flush: 'sync' },
)

function discardEdit() {
  if (current.value.api_base) sessionStorage.removeItem(editDraftKey())
  dialog.value = false
}

async function save() {
  if (saving.value) return
  if (mode.value === 'grade') {
    const score = Number(form.score)
    if (
      form.score === null ||
      form.score === '' ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > Number(props.assignment.total_score)
    ) {
      ElMessage.warning(`成绩必须在 0 到 ${props.assignment.total_score} 之间`)
      return
    }
  }
  saving.value = true
  try {
    if (mode.value === 'grade') {
      await api.post(current.value.api_base + '/grade', {
        score: form.score,
        comment: form.comment,
      })
    } else {
      await api.post(current.value.api_base + '/return', { returned_reason: form.returned_reason })
    }
    ElMessage.success(mode.value === 'grade' ? '批改已保存' : '作业已退回')
    sessionStorage.removeItem(editDraftKey())
    dialog.value = false
    emit('saved')
  } catch (error) {
    ElMessage.error(messageOf(error))
  } finally {
    saving.value = false
  }
}

function protectUnsavedGrade(event) {
  if (!dialog.value || editSnapshot() === editBaseline) return
  event.preventDefault()
  event.returnValue = ''
}

function resetDraft() {
  sessionStorage.removeItem(editDraftKey())
  open(current.value, mode.value)
}
onMounted(() => window.addEventListener('beforeunload', protectUnsavedGrade))
onUnmounted(() => window.removeEventListener('beforeunload', protectUnsavedGrade))
defineExpose({ open })
</script>
<template>
  <el-dialog
    v-model="dialog"
    :title="mode === 'grade' ? `批改 · ${current.name}` : `退回 · ${current.name}`"
    width="min(520px, 92vw)"
    :close-on-click-modal="!saving"
    @closed="discardEdit"
  >
    <p v-if="editDraftSaved" class="hint" style="margin-top: 0; color: #2f7d5f">
      检测到未保存的评分草稿，已自动恢复；确认后请点击保存。
    </p>
    <el-form label-position="top" :disabled="saving">
      <template v-if="mode === 'grade'">
        <el-form-item :label="`成绩（满分 ${assignment.total_score}）`">
          <el-input-number v-model="form.score" :min="0" :max="assignment.total_score" />
        </el-form-item>
        <el-form-item label="评语（仅教师端保存）">
          <el-input v-model="form.comment" type="textarea" :rows="4" />
        </el-form-item>
      </template>
      <el-form-item v-else label="退回原因（学生可见）">
        <el-input v-model="form.returned_reason" type="textarea" :rows="4" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button :disabled="saving" @click="discardEdit">取消</el-button>
      <el-button v-if="editDraftSaved" :disabled="saving" @click="resetDraft">放弃草稿</el-button>
      <el-button
        :type="mode === 'grade' ? 'primary' : 'warning'"
        :color="mode === 'grade' ? '#15554e' : ''"
        :loading="saving"
        @click="save"
        >确认</el-button
      >
    </template>
  </el-dialog>
</template>
