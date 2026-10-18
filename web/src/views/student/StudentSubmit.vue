<script setup>
import RichTextContent from '../../components/RichTextContent.vue'
import StudentDeadlineCard from '../../components/StudentDeadlineCard.vue'
import StudentSubmissionStatus from '../../components/student/StudentSubmissionStatus.vue'
import StudentSubmissionEditor from '../../components/student/StudentSubmissionEditor.vue'
import StudentSubmissionReceipt from '../../components/student/StudentSubmissionReceipt.vue'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api, { messageOf } from '../../api/request.js'
import { validateStudentPage, validateSubmissionPolicy } from '../../api/contracts.js'
import SubmissionRecords from '../../components/SubmissionRecords.vue'
import DownloadTask from '../../components/DownloadTask.vue'
import ExtensionsPanel from '../../components/ExtensionsPanel.vue'
import { useChunkedUpload } from '../../composables/useChunkedUpload.js'
import { useDownload } from '../../composables/useDownload.js'
import { intentSignature, isSubmissionConflict, newRequestId } from '../../composables/useUpload.js'
import { createServerClock, deadlineState } from '../../utils/deadline.js'
import { readUser } from '../../utils/session.js'
import { DEFAULT_ASSIGNMENT_FILE_MAX_MB } from '@university-homework/domain/limits'
import {
  requiredQuestions,
  requiredAnswerValues,
  serializeRequiredAnswers,
  requiredAnswerError,
} from '@university-homework/domain/requiredAnswers'

const route = useRoute()
const router = useRouter()
const assignment = ref({})
const context = ref({})
const upload = useChunkedUpload()
const downloadTask = useDownload()
const {
  busy: uploadBusy,
  percent: uploadPercent,
  state: uploadState,
  phase: uploadPhase,
  canPause: uploadCanPause,
  canCancel: uploadCanCancel,
  loaded: uploadLoaded,
  total: uploadTotal,
} = upload
const canSubmit = computed(
  () =>
    context.value.can_submit &&
    submission.value?.status !== 'graded' &&
    (!submission.value ||
      assignment.value.allow_resubmit_count === -1 ||
      (submission.value?.resubmit_count || 0) < assignment.value.allow_resubmit_count ||
      submission.value?.status === 'returned'),
)
const submission = ref(null)
const content = ref('')
const answerValues = ref({})
const questions = computed(() => requiredQuestions(assignment.value.required_answer))
const answers = computed(() => answerValues.value)
const pageLoading = ref(true)
const pageLoaded = ref(false)
const pageError = ref('')
const submissionState = ref({ kind: 'idle' })
const submissionUncertain = computed(() => submissionState.value.kind === 'uncertain')
const editingSubmission = ref(true)
const requestReference = ref('')
const submissionLocked = ref(false)
const confirming = ref(false)
const recordsRef = ref(null)
const file = ref(null)
const loading = ref(false)
const currentTime = ref(Date.now())
let serverClock = () => Date.now()
let clockTimer,
  loadSequence = 0,
  loadController,
  answerSyncTimer,
  draftTimer
let contentBaseline = ''
let settingContent = false
let confirmedIntent = null

const submissionDraftKey = (id) => `draft:submission:${readUser()?.id || 'guest'}:${id}`
const fileDraftKey = (id) => `draft:submission-file:${readUser()?.id || 'guest'}:${id}`
function readDraft(key) {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}
function writeDraft(key, value) {
  try {
    if (value) sessionStorage.setItem(key, value)
    else sessionStorage.removeItem(key)
  } catch {}
}
function flushAnswerDraft(assignmentId = String(route.params.id)) {
  clearTimeout(answerSyncTimer)
  clearTimeout(draftTimer)
  if (questions.value.length)
    content.value = serializeRequiredAnswers(assignment.value.required_answer, answerValues.value)
  writeDraft(
    submissionDraftKey(assignmentId),
    content.value === contentBaseline ? '' : content.value,
  )
}
function setRequiredAnswer(id, value) {
  answerValues.value = { ...answerValues.value, [id]: value }
  clearTimeout(answerSyncTimer)
  answerSyncTimer = window.setTimeout(() => flushAnswerDraft(), 350)
}

const deadline = computed(() => deadlineState(context.value.effective_deadline, currentTime.value))
const serverLate = ref(null)
const deadlineView = computed(() => {
  if (serverLate.value === true) return { ...deadline.value, kind: 'late' }
  if (serverLate.value === false && deadline.value.kind === 'late')
    return { ...deadline.value, kind: 'normal', text: `截止：${context.value.effective_deadline}` }
  return deadline.value
})
const submissionStateTitle = computed(
  () =>
    ({ uncertain: '提交结果待确认', conflict: '提交状态冲突', failed: '提交未完成' })[
      submissionState.value.kind
    ] || '',
)
const submissionBlockReason = computed(() => {
  if (context.value.not_assigned) return '本次作业未安排你参与。'
  if (assignment.value.course_status === 'archived') return '课程已归档，只能查看提交记录。'
  if (assignment.value.status !== 'published') return '作业已关闭，暂时不能提交修改。'
  if (!context.value.can_submit) return '当前账号暂时没有提交权限。'
  if (submission.value?.status === 'graded') return '作业已完成批改，提交已完成。'
  if (submission.value?.status !== 'returned')
    return '已达到允许的自行重交次数；如需修改请联系老师退回。'
  return '当前暂时不能重新提交，请联系老师确认。'
})
const fileSizeLabel = computed(() => {
  const mb = assignment.value.max_file_mb || DEFAULT_ASSIGNMENT_FILE_MAX_MB
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
function validateSubmissionFile(selected) {
  const extension = fileExtension(selected?.name)
  const extensionValid =
    !selected || !allowedExtensions.value.length || allowedExtensions.value.includes(extension)
  const sizeValid =
    !selected ||
    !assignment.value.max_file_mb ||
    selected.size <= assignment.value.max_file_mb * 1024 * 1024
  return { extension, extensionValid, sizeValid }
}

async function load() {
  const sequence = ++loadSequence,
    assignmentId = String(route.params.id)
  loadController?.abort()
  loadController = new AbortController()
  pageLoading.value = true
  pageError.value = ''
  try {
    const { data } = await api.get(`/assignments/${assignmentId}/student-page`, {
      signal: loadController.signal,
    })
    if (sequence !== loadSequence) return
    validateStudentPage(data)
    const previousSubmission = submission.value
    const hadLoadedPage = pageLoaded.value
    assignment.value = data.assignment
    context.value = data.context
    submission.value = data.submission
    if (!submission.value) editingSubmission.value = true
    else if (
      !hadLoadedPage ||
      !previousSubmission ||
      previousSubmission.status !== submission.value.status ||
      previousSubmission.submit_count !== submission.value.submit_count
    )
      editingSubmission.value = false
    contentBaseline = submission.value?.content || ''
    settingContent = true
    content.value = readDraft(submissionDraftKey(assignmentId)) ?? contentBaseline
    answerValues.value = requiredAnswerValues(assignment.value.required_answer, content.value)
    settingContent = false
    serverClock = createServerClock(assignment.value.server_now)
    currentTime.value = serverClock()
    serverLate.value = null
    pageLoaded.value = true
    submissionState.value = { kind: 'idle' }
    requestReference.value = ''
    confirmedIntent = null
    const previousFile = readDraft(fileDraftKey(assignmentId))
    if (previousFile && !file.value) {
      writeDraft(fileDraftKey(assignmentId), '')
      ElMessage.warning(`上次未提交的文件“${previousFile}”需要重新选择，在线文字已为你保留。`)
    }
  } catch (error) {
    if (sequence === loadSequence && error.name !== 'CanceledError')
      pageError.value = messageOf(error)
  } finally {
    if (sequence === loadSequence) pageLoading.value = false
  }
}

watch(content, (value) => {
  if (settingContent || questions.value.length) return
  clearTimeout(draftTimer)
  const key = submissionDraftKey(route.params.id)
  const draft = value === contentBaseline ? '' : value
  draftTimer = window.setTimeout(() => {
    writeDraft(key, draft)
  }, 350)
})

function resetFileSelection(clearDraft = false, assignmentId = String(route.params.id)) {
  file.value = null
  if (clearDraft) writeDraft(fileDraftKey(assignmentId), '')
}

// 点击选择和拖拽 drop 都经 FileDropZone 触发这里，统一做后缀/大小校验。
function acceptFile(selected) {
  if (!selected) return
  const validation = validateSubmissionFile(selected)
  if (!validation.extensionValid) {
    ElMessage.warning(`本作业只接受后缀名：${extensionLabel.value}`)
    resetFileSelection(true)
    return
  }
  if (!validation.sizeValid) {
    ElMessage.warning(`该作业限制单文件不超过 ${fileSizeLabel.value}`)
    resetFileSelection(true)
    return
  }
  writeDraft(fileDraftKey(route.params.id), selected.name)
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
const checklist = computed(() => {
  const items = []
  for (const [index, question] of questions.value.entries()) {
    const filled = !!String(answers.value[question.id] || '').trim()
    items.push({
      ok: filled,
      text: filled ? `第${index + 1}道必答题目已填写` : `尚未回答第${index + 1}道必答题目`,
    })
  }
  if (assignment.value.type !== 'online') {
    const validation = file.value ? validateSubmissionFile(file.value) : null
    const error = !file.value
      ? '尚未选择源文件'
      : !validation.extensionValid
        ? `源文件后缀不符，本作业只接受：${extensionLabel.value}`
        : !validation.sizeValid
          ? `源文件超过 ${fileSizeLabel.value} 上限`
          : ''
    items.push({
      ok: !error,
      text: error || '源文件已上传并符合要求',
    })
  }
  if (requirePreview.value) {
    const count = previews.value.length
    items.push({
      ok: count >= 1 && count <= previewMax.value,
      text:
        count === 0
          ? `尚未选择预览图（最多 ${previewMax.value} 张）`
          : count > previewMax.value
            ? `预览图超过最多 ${previewMax.value} 张`
            : '预览图上传并符合要求',
    })
  }
  return items
})

function submissionIntentSignature(assignmentId) {
  const identify = (selected) =>
    selected ? { name: selected.name, size: selected.size, modified: selected.lastModified } : null
  return intentSignature({
    assignmentId,
    baseVersion: submission.value?.submit_count || 0,
    content: content.value,
    requiredAnswer: assignment.value.required_answer || '',
    file: identify(file.value),
    previews: previews.value.map(identify),
  })
}

async function refreshSubmissionPolicy(assignmentId, reference) {
  try {
    const { data } = await api.get(`/assignments/${assignmentId}/submission-policy`, {
      headers: { 'X-Client-Reference': reference },
    })
    if (String(route.params.id) !== assignmentId) return false
    validateSubmissionPolicy(data)
    context.value = {
      ...context.value,
      can_submit: data.can_submit,
      effective_deadline: data.effective_deadline,
    }
    serverClock = createServerClock(data.server_now)
    currentTime.value = serverClock()
    serverLate.value = Boolean(data.is_late)
    return Boolean(data.can_submit)
  } catch (error) {
    // Older servers can still accept submissions; their transaction remains authoritative.
    if (![404, 405].includes(error.response?.status)) throw error
    serverLate.value = deadline.value.kind === 'late'
    return canSubmit.value
  }
}

function failureCategory(error, uncertain) {
  if (uncertain) return '服务器保存状态尚未确认'
  const status = error.response?.status
  if (!status) return '网络连接中断'
  if (status === 413) return '文件超过作业限制'
  if (status === 409) return '提交版本冲突'
  if (status >= 500) return '服务器处理异常'
  return '提交校验未通过'
}

async function confirmSubmission(isLate) {
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
  if (submission.value && !editingSubmission.value) return
  if (submissionLocked.value || submissionState.value.kind === 'conflict') return
  const targetAssignmentId = String(route.params.id)
  flushAnswerDraft(targetAssignmentId)
  const answerError = requiredAnswerError(assignment.value.required_answer, content.value)
  if (answerError) {
    ElMessage.warning(answerError)
    return
  }
  if (!file.value && !content.value.trim()) {
    ElMessage.warning('请选择文件或填写在线作答内容')
    return
  }
  const failing = checklist.value.find((item) => !item.ok)
  if (failing) {
    ElMessage.warning(failing.text)
    return
  }
  submissionLocked.value = true
  confirming.value = true
  const previousState = submissionState.value.kind
  let reference = ''
  try {
    const signature = submissionIntentSignature(targetAssignmentId)
    const sameIntent = confirmedIntent?.signature === signature
    reference = sameIntent ? confirmedIntent.reference : newRequestId()
    requestReference.value = reference
    if (!(await refreshSubmissionPolicy(targetAssignmentId, reference))) {
      submissionState.value = { kind: 'idle' }
      await load()
      ElMessage.warning('作业状态已变化，页面已刷新，请确认当前提交权限。')
      return
    }
    if (String(route.params.id) !== targetAssignmentId) return
    const isLate = serverLate.value ?? deadline.value.kind === 'late'
    const skipConfirmation =
      sameIntent &&
      (previousState === 'uncertain' ||
        Boolean(confirmedIntent && confirmedIntent.isLate === isLate))
    if (!skipConfirmation && !(await confirmSubmission(isLate))) return
    confirmedIntent = { signature, isLate, reference }
    const fileValidation = validateSubmissionFile(file.value)
    if (!fileValidation.extensionValid || !fileValidation.sizeValid) {
      ElMessage.warning(
        !fileValidation.extensionValid
          ? `本作业只接受后缀名：${extensionLabel.value}`
          : `该作业限制单文件不超过 ${fileSizeLabel.value}`,
      )
      return
    }
    confirming.value = false
    loading.value = true
    submissionState.value = { kind: 'idle' }
    const baseVersion = submission.value?.submit_count || 0
    const metadata = {
      content: content.value,
      answer_question: assignment.value.required_answer || '',
    }
    const sourceFile = file.value
    const previewFiles = previews.value
    const result = await upload.run({
      kind: 'submission',
      target: { assignment_id: Number(targetAssignmentId) },
      metadata,
      baseVersion,
      clientReference: reference,
      onRequestId: (value) => {
        requestReference.value = value
      },
      files: [
        { role: 'source', file: sourceFile, order: 0 },
        ...previewFiles.map((preview, index) => ({
          role: 'preview',
          file: preview,
          order: index + 1,
        })),
      ],
      fallback: {
        url: `/assignments/${targetAssignmentId}/submit`,
        statusUrl: `/assignments/${targetAssignmentId}/upload-status/`,
        fields: { ...metadata, base_version: baseVersion },
        file: sourceFile,
        extraFiles: previewFiles,
      },
    })
    submissionState.value = { kind: 'idle' }
    confirmedIntent = null
    requestReference.value = ''
    writeDraft(submissionDraftKey(targetAssignmentId), '')
    writeDraft(fileDraftKey(targetAssignmentId), '')
    if (String(route.params.id) === targetAssignmentId) {
      receipt.value = result
      receiptDialog.value = true
      resetFileSelection(false, targetAssignmentId)
      previews.value = []
      await load()
    }
  } catch (error) {
    if (['UPLOAD_PAUSED', 'UPLOAD_CANCELLED'].includes(error.code)) {
      submissionState.value = { kind: 'idle' }
    } else if (isSubmissionConflict(error)) {
      submissionState.value = {
        kind: 'conflict',
        category: failureCategory(error, false),
        message: messageOf(error),
        reference: requestReference.value || reference,
      }
    } else {
      const uncertain = uploadPhase.value === 'uncertain'
      const requestId = requestReference.value || reference || newRequestId()
      requestReference.value = requestId
      submissionState.value = {
        kind: uncertain ? 'uncertain' : 'failed',
        category: failureCategory(error, uncertain),
        message: uncertain ? uploadState.value : messageOf(error),
        reference: requestId,
      }
    }
  } finally {
    loading.value = false
    confirming.value = false
    submissionLocked.value = false
  }
}

async function copyProblemReference() {
  if (!requestReference.value) return
  try {
    await navigator.clipboard.writeText(requestReference.value)
    ElMessage.success('编号已复制')
  } catch {
    ElMessage.warning('复制失败，请手动选择编号')
  }
}

// 冲突后先刷新服务器状态，保留学生已选择的文件和文字。
async function refreshAfterConflict() {
  submissionState.value = { kind: 'idle' }
  confirmedIntent = null
  await load()
}

function startHistoryDownload(payload) {
  downloadTask.start(payload)
}

function closeReceiptAndShowHistory() {
  receiptDialog.value = false
  recordsRef.value?.open()
}

function closeReceiptAndReturn() {
  receiptDialog.value = false
  router.push(`/student/courses/${assignment.value.course_id || ''}`)
}

function startEditingSubmission() {
  if (!canSubmit.value || !submission.value) return
  submissionState.value = { kind: 'idle' }
  editingSubmission.value = true
  file.value = null
  previews.value = []
}

async function cancelEditingSubmission() {
  if (!submission.value) return
  if (hasUnsavedWork()) {
    try {
      await ElMessageBox.confirm('放弃这次修改并返回已提交状态？', '取消修改', {
        confirmButtonText: '放弃修改',
        cancelButtonText: '继续编辑',
        type: 'warning',
      })
    } catch {
      return
    }
  }
  const assignmentId = String(route.params.id)
  writeDraft(submissionDraftKey(assignmentId), '')
  writeDraft(fileDraftKey(assignmentId), '')
  resetFileSelection(false, assignmentId)
  previews.value = []
  content.value = submission.value.content || ''
  answerValues.value = requiredAnswerValues(assignment.value.required_answer, content.value)
  contentBaseline = content.value
  submissionState.value = { kind: 'idle' }
  confirmedIntent = null
  editingSubmission.value = false
}

function hasUnsavedWork() {
  const currentContent = questions.value.length
    ? serializeRequiredAnswers(assignment.value.required_answer, answerValues.value)
    : content.value
  return !!file.value || previews.value.length > 0 || currentContent !== contentBaseline
}

async function allowRouteChange() {
  if (submissionUncertain.value) {
    ElMessage.warning('请先查询提交结果，确认服务器是否已保存。')
    return false
  }
  if (submissionLocked.value || uploadBusy.value) {
    ElMessage.warning('提交正在进行，请等待上传或保存完成。')
    return false
  }
  if (!hasUnsavedWork()) return true
  flushAnswerDraft()
  try {
    await ElMessageBox.confirm(
      '文字草稿会保留；已选文件和预览图离开后需要重新选择。确定离开？',
      '离开提交页面',
      { confirmButtonText: '保留草稿并离开', cancelButtonText: '继续填写', type: 'warning' },
    )
    return true
  } catch {
    return false
  }
}

function protectUnsavedWork(event) {
  if (!hasUnsavedWork() && !submissionLocked.value && !submissionUncertain.value) return
  flushAnswerDraft()
  event.preventDefault()
  event.returnValue = ''
}

onBeforeRouteLeave(allowRouteChange)
onBeforeRouteUpdate((to, from) => (to.params.id === from.params.id ? true : allowRouteChange()))

watch(
  () => route.params.id,
  () => {
    pageLoaded.value = false
    submissionState.value = { kind: 'idle' }
    requestReference.value = ''
    confirmedIntent = null
    assignment.value = {}
    context.value = {}
    submission.value = null
    resetFileSelection(false)
    previews.value = []
    receipt.value = null
    answerValues.value = {}
    load()
  },
)

onMounted(() => {
  load()
  window.addEventListener('beforeunload', protectUnsavedWork)
  clockTimer = window.setInterval(() => {
    currentTime.value = serverClock()
    serverLate.value = null
  }, 60_000)
})

onUnmounted(() => {
  window.clearInterval(clockTimer)
  clearTimeout(answerSyncTimer)
  clearTimeout(draftTimer)
  loadSequence += 1
  loadController?.abort()
  if (uploadBusy.value) upload.pause()
  window.removeEventListener('beforeunload', protectUnsavedWork)
})
</script>

<template>
  <div>
    <div class="assignment-header">
      <div class="page-head assignment-heading">
        <div>
          <el-button text @click="router.push(`/student/courses/${assignment.course_id || ''}`)"
            >← 课程作业</el-button
          >
          <h1>{{ assignment.title || '作业详情' }}</h1>
          <p>{{ assignment.course_name }}</p>
        </div>
      </div>
      <StudentDeadlineCard
        v-if="pageLoaded && !pageError"
        class="assignment-deadline"
        label="截止时间"
        :deadline="context.effective_deadline || ''"
      />
      <div class="assignment-header-tools">
        <SubmissionRecords
          v-if="pageLoaded && !pageError"
          ref="recordsRef"
          :api-base="submission?.api_base || ''"
          @download="startHistoryDownload"
        />
      </div>
    </div>

    <el-skeleton v-if="pageLoading && !pageLoaded" :rows="8" animated />
    <el-alert
      v-if="pageError"
      :title="pageError"
      type="error"
      show-icon
      :closable="false"
      style="margin-bottom: 14px"
      ><el-button size="small" @click="load">重试</el-button></el-alert
    >

    <el-alert
      v-if="pageLoaded && deadlineView.kind === 'warning'"
      :title="deadlineView.text"
      description="请尽快完成并提交，避免网络或文件上传耗时造成迟交。"
      type="warning"
      show-icon
      :closable="false"
      style="margin-bottom: 18px"
    />
    <el-alert
      v-else-if="pageLoaded && deadlineView.kind === 'late'"
      title="作业已超过截止时间"
      description="你仍然可以提交，但本次提交会被标记为迟交，老师可以看到。"
      type="error"
      show-icon
      :closable="false"
      style="margin-bottom: 18px"
    />

    <el-alert
      v-if="pageLoaded && !context.can_submit"
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
    <div v-if="pageLoaded" class="detail-grid">
      <section class="panel">
        <h2>作业要求</h2>
        <RichTextContent
          :content="assignment.description || '老师暂未填写详细要求。'"
          :format="assignment.description_format"
        />
        <p v-if="questions.length" class="hint">
          本作业设有
          {{ questions.length }} 道必答题目，请在“提交作业”区域查看题目与答题规范，并逐题填写答案。
        </p>
        <el-divider />
        <p class="hint">
          满分 {{ assignment.total_score }} · 允许自行重交
          {{
            assignment.allow_resubmit_count === -1 ? '不限' : `${assignment.allow_resubmit_count}次`
          }}
          （不含首次提交，教师退回重做另计）
          <template v-if="assignment.type !== 'online'">
            · 单文件不超过 {{ fileSizeLabel }}</template
          >
        </p>
      </section>

      <aside class="panel" :class="{ 'late-submit-panel': deadlineView.kind === 'late' }">
        <StudentSubmissionStatus
          v-if="submission && !editingSubmission"
          :submission="submission"
          :context="context"
          :can-submit="canSubmit"
          :block-reason="submissionBlockReason"
          @edit="startEditingSubmission"
        />
        <StudentSubmissionEditor
          v-else
          :assignment="assignment"
          :submission="submission"
          :questions="questions"
          :answers="answers"
          :content="content"
          :file="file"
          :previews="previews"
          :require-preview="requirePreview"
          :preview-max="previewMax"
          :accept-attribute="acceptAttribute"
          :allowed-extensions="allowedExtensions"
          :extension-label="extensionLabel"
          :file-size-label="fileSizeLabel"
          :checklist="checklist"
          :submission-state="submissionState"
          :submission-state-title="submissionStateTitle"
          :submission-locked="submissionLocked"
          :submission-uncertain="submissionUncertain"
          :can-submit="canSubmit"
          :submission-block-reason="submissionBlockReason"
          :upload-state="uploadState"
          :upload-percent="uploadPercent"
          :upload-total="uploadTotal"
          :upload-busy="uploadBusy"
          :upload-can-pause="uploadCanPause"
          :upload-can-cancel="uploadCanCancel"
          :upload-loaded="uploadLoaded"
          :upload-phase="uploadPhase"
          :loading="loading"
          :confirming="confirming"
          :deadline-view="deadlineView"
          @update:content="content = $event"
          @update:file="file = $event"
          @update:previews="previews = $event"
          @set-answer="setRequiredAnswer"
          @cancel-edit="cancelEditingSubmission"
          @submit="submit"
          @copy-reference="copyProblemReference"
          @refresh-conflict="refreshAfterConflict"
          @pause-upload="upload.pause"
          @cancel-upload="upload.cancel"
        />
      </aside>
    </div>

    <ExtensionsPanel
      v-if="pageLoaded"
      :key="route.params.id"
      :assignment-id="route.params.id"
      :can-apply="!submissionUncertain && context.can_submit && !!assignment.deadline"
      :readonly="assignment.course_status === 'archived' || assignment.status !== 'published'"
      @changed="load"
    />
    <div class="submission-help-actions">
      <router-link class="el-button" to="/help#student-submit"
        ><span>提交、重试与回执说明</span></router-link
      >
    </div>
    <StudentSubmissionReceipt
      v-model="receiptDialog"
      :receipt="receipt"
      :require-preview="requirePreview"
      @show-history="closeReceiptAndShowHistory"
      @return-to-course="closeReceiptAndReturn"
    />
    <DownloadTask
      :tasks="downloadTask.tasks.value"
      @pause="downloadTask.pause"
      @resume="downloadTask.resume"
      @cancel="downloadTask.cancel"
      @open-folder="downloadTask.openFolder"
      @dismiss="downloadTask.dismiss"
    />
  </div>
</template>

<style scoped>
.assignment-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 24px;
  margin-bottom: 26px;
}
.assignment-heading {
  flex: 1;
  min-width: 0;
  margin-bottom: 0;
}
.assignment-heading h1 {
  overflow-wrap: anywhere;
}
.assignment-header-tools {
  grid-column: 3;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 12px;
  max-width: 100%;
}
.assignment-deadline {
  grid-column: 2;
  grid-row: 1;
  justify-self: center;
  margin-bottom: 0;
}
.submission-help-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 16px;
}
.submission-help-actions .el-button {
  margin: 0;
  text-decoration: none;
}
.detail-grid {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}
@media (max-width: 800px) {
  .assignment-header {
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
  }
  .assignment-deadline,
  .assignment-header-tools {
    grid-column: 1;
    grid-row: auto;
  }
  .assignment-header-tools {
    align-items: center;
  }
  .detail-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
