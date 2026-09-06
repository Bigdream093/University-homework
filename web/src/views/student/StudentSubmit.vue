<script setup>
import RichTextContent from '../../components/RichTextContent.vue'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api, { messageOf } from '../../api/request.js'
import SubmissionRecords from '../../components/SubmissionRecords.vue'
import ExtensionsPanel from '../../components/ExtensionsPanel.vue'
import FileDropZone from '../../components/FileDropZone.vue'
import PreviewImagePicker from '../../components/PreviewImagePicker.vue'
import { useChunkedUpload } from '../../composables/useChunkedUpload.js'
import { isSubmissionConflict } from '../../composables/useUpload.js'
import { createServerClock, deadlineState } from '../../utils/deadline.js'
import { readUser } from '../../utils/session.js'

const route = useRoute()
const router = useRouter()
const assignment = ref({})
const context = ref({})
const upload = useChunkedUpload()
const {
  busy: uploadBusy,
  percent: uploadPercent,
  state: uploadState,
  loaded: uploadLoaded,
  total: uploadTotal,
} = upload
const canSubmit = computed(
  () =>
    context.value.can_submit &&
    (assignment.value.allow_resubmit_count === -1 ||
      (submission.value?.submit_count || 0) < assignment.value.allow_resubmit_count + 1 ||
      submission.value?.status === 'returned'),
)
const submission = ref(null)
const content = ref('')
const file = ref(null)
const loading = ref(false)
const history = ref([])
const historyDialog = ref(false)
const currentTime = ref(Date.now())
let serverClock = () => Date.now()
let clockTimer
let loadSequence = 0
let contentBaseline = ''
let settingContent = false

const submissionDraftKey = (id) => `draft:submission:${readUser()?.id || 'guest'}:${id}`
const fileDraftKey = (id) => `draft:submission-file:${readUser()?.id || 'guest'}:${id}`

const deadline = computed(() => deadlineState(context.value.effective_deadline, currentTime.value))
const fileSizeLabel = computed(() => {
  const mb = assignment.value.max_file_mb || 200
  return mb >= 1024 ? '1G' : `${mb}M`
})
// 作业级后缀名限制：如 ['dwg','zip']；为空表示不限制。
const allowedExtensions = computed(() =>
  String(assignment.value.allowed_extensions || '')
    .split(',')
    .filter(Boolean),
)
const extensionLabel = computed(() =>
  allowedExtensions.value.map((extension) => '.' + extension).join('、'),
)
const acceptAttribute = computed(() =>
  allowedExtensions.value.length
    ? allowedExtensions.value.map((extension) => '.' + extension).join(',')
    : null,
)
function fileExtension(name) {
  const match = /\.([a-z0-9]+)$/i.exec(name || '')
  return match ? match[1].toLowerCase() : ''
}

async function load() {
  const sequence = ++loadSequence
  const assignmentId = route.params.id
  try {
    const [assignmentResponse, submissionResponse, contextResponse] = await Promise.all([
      api.get(`/assignments/${assignmentId}`),
      api.get(`/assignments/${assignmentId}/my-submission`),
      api.get(`/assignments/${assignmentId}/submission-context`),
    ])
    if (sequence !== loadSequence) return
    assignment.value = assignmentResponse.data
    context.value = contextResponse.data
    submission.value = submissionResponse.data
    contentBaseline = submission.value?.content || ''
    settingContent = true
    content.value = sessionStorage.getItem(submissionDraftKey(assignmentId)) ?? contentBaseline
    settingContent = false
    serverClock = createServerClock(assignment.value.server_now)
    currentTime.value = serverClock()
    const previousFile = sessionStorage.getItem(fileDraftKey(assignmentId))
    if (previousFile && !file.value) {
      sessionStorage.removeItem(fileDraftKey(assignmentId))
      ElMessage.warning(`上次未提交的文件“${previousFile}”需要重新选择，在线文字已为你保留。`)
    }
  } catch (error) {
    if (sequence === loadSequence) ElMessage.error(messageOf(error))
  }
}

watch(
  content,
  (value) => {
    if (settingContent) return
    const key = submissionDraftKey(route.params.id)
    if (value !== contentBaseline) sessionStorage.setItem(key, value)
    else sessionStorage.removeItem(key)
  },
  { flush: 'sync' },
)

function resetFileSelection(clearDraft = false) {
  file.value = null
  if (clearDraft) sessionStorage.removeItem(fileDraftKey(route.params.id))
}

// 点击选择和拖拽 drop 都经 FileDropZone 触发这里，统一做后缀/大小校验。
function acceptFile(selected) {
  if (!selected) return
  if (
    allowedExtensions.value.length &&
    !allowedExtensions.value.includes(fileExtension(selected.name))
  ) {
    ElMessage.warning(`本作业只接受后缀名：${extensionLabel.value}`)
    resetFileSelection(true)
    return
  }
  if (assignment.value.max_file_mb && selected.size > assignment.value.max_file_mb * 1024 * 1024) {
    ElMessage.warning(`该作业限制单文件不超过 ${fileSizeLabel.value}`)
    resetFileSelection(true)
    return
  }
  sessionStorage.setItem(fileDraftKey(route.params.id), selected.name)
}
watch(file, acceptFile)

// 预览图要求（仅文档/文件作业）与双区域状态。
const requirePreview = computed(
  () =>
    assignment.value.type === 'document' && Number(assignment.value.require_preview_image) === 1,
)
const previewMax = computed(() =>
  Math.min(10, Math.max(1, Number(assignment.value.preview_max_count ?? 3))),
)
const previews = ref([])
const receipt = ref(null)
const receiptDialog = ref(false)
const conflict = ref(false)
const checklist = computed(() => {
  const items = []
  if (assignment.value.type !== 'online') {
    items.push({
      ok: !!file.value,
      text: file.value ? `已选择源文件（${file.value.name}）` : '尚未选择源文件',
    })
    if (file.value && allowedExtensions.value.length) {
      const ok = allowedExtensions.value.includes(fileExtension(file.value.name))
      items.push({
        ok,
        text: ok
          ? `源文件后缀符合要求（.${fileExtension(file.value.name)}）`
          : `源文件后缀不符，本作业只接受：${extensionLabel.value}`,
      })
    }
    if (file.value && assignment.value.max_file_mb) {
      const ok = file.value.size <= assignment.value.max_file_mb * 1024 * 1024
      items.push({
        ok,
        text: ok ? `源文件未超过 ${fileSizeLabel.value}` : `源文件超过 ${fileSizeLabel.value} 上限`,
      })
    }
  }
  if (requirePreview.value) {
    const count = previews.value.length
    items.push({
      ok: count >= 1 && count <= previewMax.value,
      text: `已选择 ${count}/${previewMax.value} 张预览图`,
    })
  }
  return items
})

async function confirmSubmission() {
  const isLate = deadline.value.kind === 'late'
  const appendMode = assignment.value.submission_mode === 'append'
  const replacesFile = !appendMode && Boolean(file.value && submission.value?.file_name)
  const replacesAnswer =
    !appendMode &&
    assignment.value.type === 'online' &&
    Boolean(submission.value && content.value.trim())
  const replacesPrevious = replacesFile || replacesAnswer
  if (!isLate && !replacesPrevious) return true

  const replacement = replacesFile
    ? '新文件会替换上一次提交的文件'
    : '新答案会覆盖上一次在线作答内容'
  const message =
    isLate && replacesPrevious
      ? `当前已超过截止时间，并且${replacement}。本次提交会被标记为“迟交”，老师可以看到。`
      : isLate && appendMode
        ? '当前已超过作业截止时间。本次重新提交的文件会作为补充保留，不会被覆盖。提交会被标记为“迟交”，老师可以看到。'
        : isLate
          ? '当前已超过作业截止时间。本次提交仍会被接收，但系统会明确标记为“迟交”，老师可以看到该状态。'
          : appendMode
            ? '本次重新提交的文件会作为补充保留，不会覆盖原文件，老师下载时会统一打包。'
            : replacesFile
              ? '本次重新提交会替换上一次提交的文件，旧文件将不再保留。'
              : '本次重新提交会覆盖上一次在线作答内容，提交历史仍会保留。'
  const title = isLate ? '迟交提醒' : '提交方式确认'

  try {
    await ElMessageBox.confirm(message, title, {
      type: 'warning',
      confirmButtonText: isLate ? '仍要提交' : '确认替换',
      cancelButtonText: '暂不提交',
    })
    return true
  } catch {
    return false
  }
}

async function submit() {
  if (!file.value && !content.value.trim()) {
    ElMessage.warning('请选择文件或填写在线作答内容')
    return
  }
  const failing = checklist.value.find((item) => !item.ok)
  if (failing) {
    ElMessage.warning(failing.text)
    return
  }
  if (!(await confirmSubmission())) return

  if (
    file.value &&
    assignment.value.max_file_mb &&
    file.value.size > assignment.value.max_file_mb * 1024 * 1024
  ) {
    ElMessage.warning(`该作业限制单文件不超过 ${fileSizeLabel.value}`)
    return
  }

  loading.value = true
  try {
    const baseVersion = submission.value?.submit_count || 0
    const response = {
      data: await upload.run({
        kind: 'submission',
        target: { assignment_id: Number(route.params.id) },
        metadata: { content: content.value },
        baseVersion,
        files: [
          { role: 'source', file: file.value, order: 0 },
          ...previews.value.map((preview, index) => ({
            role: 'preview',
            file: preview,
            order: index + 1,
          })),
        ],
        legacy: {
          url: `/assignments/${route.params.id}/submit`,
          statusUrl: `/assignments/${route.params.id}/upload-status/`,
          fields: { content: content.value, base_version: baseVersion },
          file: file.value,
          extraFiles: previews.value,
        },
      }),
    }
    receipt.value = response.data
    receiptDialog.value = true
    conflict.value = false
    sessionStorage.removeItem(submissionDraftKey(route.params.id))
    resetFileSelection(true)
    previews.value = []
    await load()
  } catch (error) {
    if (['UPLOAD_PAUSED', 'UPLOAD_CANCELLED'].includes(error.code)) {
      // Upload controls already display pause/cancellation state.
    } else if (isSubmissionConflict(error)) conflict.value = true
    else ElMessage.error(messageOf(error))
  } finally {
    loading.value = false
  }
}

// 冲突后不自动重试：重新拉取最新提交状态，学生已选文件与文字保留，确认后再提交。
async function refreshAfterConflict() {
  conflict.value = false
  await load()
}

async function showHistory() {
  if (!submission.value) return
  try {
    history.value = (await api.get(submission.value.api_base + '/history')).data
    historyDialog.value = true
  } catch (error) {
    ElMessage.error(messageOf(error))
  }
}

function closeReceiptAndShowHistory() {
  receiptDialog.value = false
  showHistory()
}

function closeReceiptAndReturn() {
  receiptDialog.value = false
  router.push(`/student/courses/${assignment.value.course_id || ''}`)
}

function protectUnsavedWork(event) {
  if (!file.value && content.value === contentBaseline) return
  event.preventDefault()
  event.returnValue = ''
}

watch(
  () => route.params.id,
  () => {
    resetFileSelection(false)
    previews.value = []
    receipt.value = null
    load()
  },
)

onMounted(() => {
  load()
  window.addEventListener('beforeunload', protectUnsavedWork)
  clockTimer = window.setInterval(() => {
    currentTime.value = serverClock()
  }, 60_000)
})

onUnmounted(() => {
  window.clearInterval(clockTimer)
  window.removeEventListener('beforeunload', protectUnsavedWork)
})
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <el-button text @click="router.push(`/student/courses/${assignment.course_id || ''}`)"
          >← 课程作业</el-button
        >
        <h1>{{ assignment.title || '作业详情' }}</h1>
        <p>{{ assignment.course_name }} · 有效截止 {{ context.effective_deadline || '不限' }}</p>
      </div>
      <SubmissionRecords v-if="submission" :api-base="submission.api_base" />
    </div>

    <el-alert
      v-if="deadline.kind === 'warning'"
      :title="deadline.text"
      description="请尽快完成并提交，避免网络或文件上传耗时造成迟交。"
      type="warning"
      show-icon
      :closable="false"
      style="margin-bottom: 18px"
    />
    <el-alert
      v-else-if="deadline.kind === 'late'"
      title="作业已超过截止时间"
      description="你仍然可以提交，但本次提交会被标记为迟交，老师可以看到。"
      type="error"
      show-icon
      :closable="false"
      style="margin-bottom: 18px"
    />

    <el-alert
      v-if="!context.can_submit"
      :title="
        context.not_assigned
          ? '本次作业未安排你参与'
          : assignment.course_status === 'archived'
            ? '课程已归档，只可查看历史'
            : assignment.status !== 'published'
              ? '作业已关闭'
              : '本组由指定成员提交，你可以查看本组历史与回执'
      "
      type="info"
      :closable="false"
    />
    <section v-if="context.group" class="panel" style="margin: 16px 0">
      <h3>本次作业小组：{{ context.group.name }}</h3>
      <p>
        {{
          context.members?.map((member) => member.name + '（' + member.username + '）').join('、')
        }}
      </p>
      <p>全组共用提交次数和成果。</p>
    </section>
    <div class="detail-grid">
      <section class="panel">
        <span class="badge">{{ assignment.type === 'online' ? '在线作答' : '文件作业' }}</span>
        <h2>作业要求</h2>
        <RichTextContent
          :content="assignment.description || '老师暂未填写详细要求。'"
          :format="assignment.description_format"
        />
        <el-divider />
        <p class="hint">
          满分 {{ assignment.total_score }} · 允许重交
          {{
            assignment.allow_resubmit_count === -1 ? '不限' : `${assignment.allow_resubmit_count}次`
          }}
          <template v-if="assignment.type !== 'online'">
            · 单文件不超过 {{ fileSizeLabel }}</template
          >
        </p>
      </section>

      <aside class="panel" :class="{ 'late-submit-panel': deadline.kind === 'late' }">
        <template v-if="submission">
          <el-alert
            v-if="submission.status === 'returned'"
            title="作业被退回"
            type="warning"
            :description="submission.returned_reason"
            show-icon
            :closable="false"
          />
          <el-alert
            v-else
            :title="submission.status === 'graded' ? '老师已完成批改' : '已成功提交'"
            :type="submission.status === 'graded' ? 'success' : 'info'"
            :closable="false"
          />
          <div style="margin: 16px 0" class="hint">
            最近提交：{{ submission.submitted_at }}<br /><template v-if="context.group"
              >实际提交人：{{ submission.submitted_by_name }}（{{
                submission.submitted_by_username
              }}）<br
            /></template>
            文件：{{ submission.file_name || '在线作答' }}<br />
            提交次数：{{ submission.submit_count }}
            <span v-if="submission.is_late" class="late"> · 迟交</span>
          </div>
        </template>

        <h3>{{ submission ? '重新提交' : '提交作业' }}</h3>
        <p v-if="!canSubmit" class="hint">当前不可提交：请检查权限、作业开放状态和剩余次数。</p>
        <el-alert
          v-if="submission?.file_name && assignment.type !== 'online'"
          :title="
            assignment.submission_mode === 'append'
              ? '重新提交的文件会作为补充保留，不会覆盖原文件'
              : '重新提交的新文件会替换上一次文件'
          "
          type="warning"
          show-icon
          :closable="false"
          style="margin-bottom: 14px"
        />
        <el-input
          v-if="assignment.type === 'online'"
          v-model="content"
          :disabled="loading || !canSubmit"
          type="textarea"
          :rows="8"
          placeholder="在此输入作答内容"
        />
        <template v-else>
          <p class="hint" style="margin: 0 0 6px"><b>① 文件区域</b>（源文件）</p>
          <FileDropZone v-model="file" :disabled="loading || !canSubmit" :accept="acceptAttribute">
            <br />
            <span v-if="allowedExtensions.length" class="hint"
              >本作业只接受后缀名：{{ extensionLabel }}</span
            >
            <br v-if="allowedExtensions.length" />
            <span class="hint"
              >单文件不超过 {{ fileSizeLabel
              }}<template v-if="!allowedExtensions.length"
                >，支持文档、图片、视频、设计源文件和压缩包</template
              ></span
            ><br />
            <span class="hint">提交后将自动规范命名为：姓名_学号_提交时间_准时或迟交.扩展名</span>
          </FileDropZone>
          <template v-if="requirePreview">
            <p class="hint" style="margin: 16px 0 6px">
              <b>② 图片区域</b>（预览图，老师评分时直接查看）
            </p>
            <PreviewImagePicker
              v-model="previews"
              :max="previewMax"
              :disabled="loading || !canSubmit"
            />
          </template>
        </template>

        <div v-if="checklist.length" class="submit-checklist">
          <p
            v-for="item in checklist"
            :key="item.text"
            class="hint"
            :class="item.ok ? 'check-ok' : 'check-fail'"
          >
            {{ item.ok ? '✓' : '✗' }} {{ item.text }}
          </p>
        </div>

        <el-alert
          v-if="conflict"
          title="提交冲突：服务器上已有更新的提交记录"
          type="error"
          show-icon
          :closable="false"
          style="margin-top: 14px"
        >
          <p style="margin: 0 0 8px">
            你已选择的文件和填写的内容都已保留。请先获取最新提交状态并确认，再决定是否提交；不同内容会互相覆盖。
          </p>
          <el-button size="small" type="primary" @click="refreshAfterConflict"
            >获取最新状态</el-button
          >
        </el-alert>

        <div v-if="uploadState" style="margin: 14px 0 4px">
          <el-progress :percentage="uploadPercent" :indeterminate="!uploadTotal && uploadBusy" />
          <p class="hint" style="margin: 6px 0 0">
            已传 {{ (uploadLoaded / 1024 / 1024).toFixed(1) }} MB /
            {{ uploadTotal ? (uploadTotal / 1024 / 1024).toFixed(1) + ' MB' : '总大小待确认' }}
          </p>
          <p role="status" style="margin: 4px 0 0">{{ uploadState }}</p>
          <el-button v-if="uploadBusy" size="small" style="margin-top: 8px" @click="upload.pause"
            >暂停</el-button
          >
          <el-button
            v-if="uploadState && !uploadState.includes('已保存')"
            size="small"
            type="danger"
            plain
            style="margin-top: 8px"
            @click="upload.cancel"
            >取消上传</el-button
          >
        </div>
        <el-button
          :type="deadline.kind === 'late' ? 'danger' : 'primary'"
          :color="deadline.kind === 'late' ? '' : '#15554e'"
          size="large"
          style="width: 100%; margin-top: 16px"
          :loading="loading"
          :disabled="!canSubmit || checklist.some((item) => !item.ok)"
          @click="submit"
        >
          {{
            uploadState.includes('暂停') || uploadState.includes('保留')
              ? '继续上传'
              : uploadState.includes('失败') || uploadState.includes('待确认')
                ? '查询 / 重试'
                : deadline.kind === 'late'
                  ? '仍要迟交'
                  : '确认提交'
          }}
        </el-button>
        <p class="hint">
          提交时间和迟交状态以服务器记录为准。上传100%后仍须等待保存。断网或刷新后重新选择相同文件，可从已上传位置继续。
        </p>
      </aside>
    </div>

    <ExtensionsPanel
      :key="route.params.id"
      :assignment-id="route.params.id"
      :can-apply="context.can_submit && !!assignment.deadline"
      :readonly="assignment.course_status === 'archived' || assignment.status !== 'published'"
      @changed="load"
    />
    <router-link to="/help#student-submit">提交、重试与回执说明</router-link>
    <el-dialog v-model="historyDialog" title="提交历史" width="min(620px,94vw)">
      <el-timeline>
        <el-timeline-item
          v-for="item in history"
          :key="item.id"
          :timestamp="item.submitted_at"
          placement="top"
        >
          <b>{{ item.file_name || '在线作答' }}</b>
          <span v-if="item.is_late" class="late"> · 迟交</span>
          <p v-if="item.content" class="hint">{{ item.content }}</p>
        </el-timeline-item>
      </el-timeline>
    </el-dialog>
    <el-dialog v-model="receiptDialog" title="提交成功" width="min(480px,92vw)">
      <template v-if="receipt">
        <p class="hint" style="margin-top: 0">回执编号：{{ receipt.receipt_no }}</p>
        <div class="receipt-grid">
          <span>提交时间</span><b>{{ receipt.submitted_at }}</b> <span>状态</span
          ><b :class="receipt.is_late ? 'late' : ''">{{
            receipt.is_late ? '迟交（老师可见）' : '准时'
          }}</b>
          <span>源文件</span><b>{{ receipt.file_name || '在线作答' }}</b>
          <template v-if="requirePreview"
            ><span>预览图</span><b>{{ receipt.preview_count }} 张</b></template
          >
          <span>提交次数</span><b>第 {{ receipt.submit_count }} 次</b>
        </div>
        <el-alert
          v-if="receipt.is_late"
          title="本次提交已超过截止时间，系统已标记为迟交，老师可以看到。"
          type="warning"
          show-icon
          :closable="false"
          style="margin-top: 12px"
        />
        <p class="hint" style="margin-bottom: 0">
          可在"历史与回执"中查看本次回执；如作业被退回，可查看退回原因。
        </p>
      </template>
      <template #footer>
        <el-button @click="receiptDialog = false">关闭</el-button>
        <el-button @click="closeReceiptAndShowHistory">查看本次提交</el-button>
        <el-button type="primary" color="#15554e" @click="closeReceiptAndReturn"
          >返回课程</el-button
        >
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.submit-checklist {
  margin-top: 14px;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px 14px;
  background: #f7fbf9;
}
.submit-checklist p {
  margin: 4px 0;
}
.check-ok {
  color: #2f7d5f;
}
.check-fail {
  color: #bb5a40;
}
.receipt-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 8px 18px;
  margin: 12px 0;
}
.receipt-grid span {
  color: #7d8d89;
}
</style>
