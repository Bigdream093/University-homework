<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import api, { messageOf } from '../api/request.js'
import { readUser } from '../utils/session.js'

// 看图评分工作区：左侧图片查看（顺序=学生提交顺序），右侧固定评分区。
const props = defineProps({
  modelValue: Boolean,
  row: { type: Object, default: null },
  rows: { type: Array, default: () => [] },
  assignment: { type: Object, default: () => ({}) },
})
const emit = defineEmits(['update:modelValue', 'saved'])

const form = reactive({ score: null, comment: '', returned_reason: '' })
const saving = ref(false)
const imageIndex = ref(0)
const draftSaved = ref(false)
let settingForm = false
let baseline = ''

const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value),
})
const previews = computed(() => props.row?.previews || [])
const currentPreview = computed(() => previews.value[imageIndex.value] || null)
const draftKey = () =>
  `draft:grading:${readUser()?.id || 'guest'}:${props.assignment?.id || ''}:${props.row?.api_base || 'none'}:workspace`
const formSnapshot = () =>
  JSON.stringify({
    score: form.score,
    comment: form.comment,
    returned_reason: form.returned_reason,
  })

function openRow(row) {
  if (!row) return
  const initial = {
    score: row.score,
    comment: row.comment || '',
    returned_reason: row.returned_reason || '',
  }
  baseline = JSON.stringify(initial)
  let saved
  try {
    saved = JSON.parse(sessionStorage.getItem(draftKey()) || 'null')
  } catch {
    saved = null
  }
  settingForm = true
  Object.assign(form, saved || initial)
  settingForm = false
  draftSaved.value = !!saved && JSON.stringify(saved) !== baseline
  imageIndex.value = 0
}
watch(
  () => props.row,
  (row) => {
    if (row && visible.value) openRow(row)
  },
  { immediate: true },
)
watch(
  [visible, () => form.score, () => form.comment, () => form.returned_reason],
  () => {
    if (!visible.value || settingForm || !props.row) return
    const snapshot = formSnapshot()
    if (snapshot === baseline) {
      sessionStorage.removeItem(draftKey())
      draftSaved.value = false
    } else {
      sessionStorage.setItem(draftKey(), snapshot)
      draftSaved.value = true
    }
  },
  { flush: 'sync' },
)

function discardDraft() {
  if (props.row) sessionStorage.removeItem(draftKey())
  openRow(props.row)
}

async function persist(kind) {
  if (kind === 'grade') {
    const score = Number(form.score)
    if (
      form.score === null ||
      form.score === '' ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > Number(props.assignment.total_score)
    ) {
      ElMessage.warning(`成绩必须在 0 到 ${props.assignment.total_score} 之间`)
      return false
    }
  }
  saving.value = true
  try {
    if (kind === 'grade')
      await api.post(props.row.api_base + '/grade', { score: form.score, comment: form.comment })
    else await api.post(props.row.api_base + '/return', { returned_reason: form.returned_reason })
    sessionStorage.removeItem(draftKey())
    draftSaved.value = false
    ElMessage.success(kind === 'grade' ? '批改已保存' : '作业已退回')
    return true
  } catch (error) {
    ElMessage.error(messageOf(error))
    return false
  } finally {
    saving.value = false
  }
}
async function saveAndNext() {
  if (!(await persist('grade'))) return
  const list = props.rows.filter((row) => row.id)
  const position = list.findIndex((row) => row.api_base === props.row.api_base)
  const next =
    list.slice(position + 1).find((row) => row.status === 'submitted') || list[position + 1] || null
  emit('saved', props.row)
  if (next) emit('saved', next, true)
  else visible.value = false
}
async function submitGrade() {
  if (await persist('grade')) {
    emit('saved', props.row)
    visible.value = false
  }
}
async function submitReturn() {
  if (await persist('return')) {
    emit('saved', props.row)
    visible.value = false
  }
}
function stepImage(delta) {
  const total = previews.value.length
  if (!total) return
  imageIndex.value = (imageIndex.value + delta + total) % total
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="`看图评分 · ${row?.name || row?.name_snapshot || ''}`"
    width="min(1200px,96vw)"
    top="4vh"
    :close-on-click-modal="false"
  >
    <div class="workspace">
      <div class="viewer">
        <template v-if="previews.length">
          <div class="viewer-stage">
            <el-image
              v-if="currentPreview"
              :key="currentPreview.id"
              :src="currentPreview.thumbnail || currentPreview.preview"
              :preview-src-list="[currentPreview.preview]"
              :initial-index="0"
              fit="contain"
              class="viewer-image"
              hide-on-click-modal
            />
            <div class="viewer-nav">
              <el-button size="small" :disabled="previews.length < 2" @click="stepImage(-1)"
                >← 上一张</el-button
              >
              <span class="hint"
                >第 {{ imageIndex + 1 }}/{{ previews.length }} 张 · {{ currentPreview?.name }} ·
                点击图片可放大/缩放/1:1</span
              >
              <el-button size="small" :disabled="previews.length < 2" @click="stepImage(1)"
                >下一张 →</el-button
              >
            </div>
          </div>
        </template>
        <div v-else class="viewer-empty hint">该提交没有预览图，请使用"文件"列下载源文件查看。</div>
        <div class="viewer-meta hint">
          提交时间：{{ row?.submitted_at || '—' }}
          <span v-if="row?.is_late" class="late">· 迟交</span> · 第
          {{ row?.submit_count || 1 }} 次提交 · 源文件：{{ row?.file_name || '在线作答' }}
        </div>
      </div>
      <div class="grade-panel">
        <p class="hint" style="margin-top: 0">
          {{ row?.username }} {{ row?.name
          }}<template v-if="row?.members"
            >（{{ row.members.map((member) => member.name).join('、') }}）</template
          >
        </p>
        <p v-if="draftSaved" class="hint draft-hint">草稿已自动保存，重新打开自动恢复</p>
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
            <el-input v-model="form.comment" type="textarea" :rows="4" />
          </el-form-item>
          <el-form-item label="退回原因（如需退回重做，学生可见）">
            <el-input v-model="form.returned_reason" type="textarea" :rows="2" />
          </el-form-item>
        </el-form>
        <div class="grade-actions">
          <el-button :disabled="saving" @click="discardDraft">放弃草稿</el-button>
          <el-button type="warning" :disabled="saving" :loading="saving" @click="submitReturn"
            >退回重做</el-button
          >
        </div>
        <div class="grade-actions" style="margin-top: 10px">
          <el-button
            type="primary"
            color="#15554e"
            :disabled="saving"
            :loading="saving"
            @click="submitGrade"
            >保存成绩</el-button
          >
          <el-button type="success" :disabled="saving" :loading="saving" @click="saveAndNext"
            >保存并下一份未评分</el-button
          >
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<style scoped>
.workspace {
  display: grid;
  grid-template-columns: 1fr 320px;
  gap: 18px;
  align-items: start;
}
.viewer-stage {
  border: 1px solid var(--line);
  border-radius: 12px;
  background: #f2f6f4;
  padding: 10px;
  text-align: center;
}
.viewer-image {
  width: 100%;
  max-height: 56vh;
  cursor: zoom-in;
}
.viewer-nav {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
}
.viewer-empty {
  border: 1px dashed var(--line);
  border-radius: 12px;
  padding: 60px 20px;
  text-align: center;
}
.viewer-meta {
  margin-top: 8px;
}
.grade-panel {
  position: sticky;
  top: 0;
}
.grade-actions {
  display: flex;
  gap: 10px;
}
.grade-actions .el-button {
  flex: 1;
  margin-left: 0;
}
.draft-hint {
  color: #2f7d5f;
}
@media (max-width: 900px) {
  .workspace {
    grid-template-columns: 1fr;
  }
  .grade-panel {
    position: static;
  }
}
</style>
