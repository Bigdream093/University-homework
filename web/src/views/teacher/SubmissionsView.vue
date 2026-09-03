<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import api, { messageOf } from '../../api/request.js'
import { downloadBlob } from '../../utils/files.js'
import SubmissionRecords from '../../components/SubmissionRecords.vue'
import ExtensionsPanel from '../../components/ExtensionsPanel.vue'
import AssignmentGroups from '../../components/AssignmentGroups.vue'
import GradeWorkspace from '../../components/GradeWorkspace.vue'
import DownloadTask from '../../components/DownloadTask.vue'
import { useDownload } from '../../composables/useDownload.js'
import { readUser } from '../../utils/session.js'

const route = useRoute()
const router = useRouter()
const assignment = ref({})
const allRows = ref([])
const filter = ref('all')
const keyword = ref('')
const dialog = ref(false)
const mode = ref('grade')
const current = ref({})
const saving = ref(false)
const form = reactive({ score: null, comment: '', returned_reason: '' })
const workspace = ref(false)
const workspaceRow = ref(null)
const editDraftSaved = ref(false)
let loadSequence = 0
let settingEditForm = false
let editBaseline = ''
const downloadTask = useDownload()

const requirePreview = computed(() => Number(assignment.value.require_preview_image) === 1)
const counts = computed(() => ({
  all: allRows.value.length,
  unsubmitted: allRows.value.filter((row) => !row.id).length,
  submitted: allRows.value.filter((row) => row.id && row.status === 'submitted').length,
  late: allRows.value.filter((row) => row.id && row.is_late === 1).length,
  returned: allRows.value.filter((row) => row.status === 'returned').length,
  graded: allRows.value.filter((row) => row.status === 'graded').length,
  missingPreview: allRows.value.filter((row) => row.id && !(row.preview_count > 0)).length,
}))

const rows = computed(() => {
  const search = keyword.value.trim().toLowerCase()
  return allRows.value.filter((row) => {
    const matchesSearch =
      !search ||
      row.username.toLowerCase().includes(search) ||
      row.name.toLowerCase().includes(search) ||
      row.members?.some((member) =>
        (member.name + ' ' + member.username).toLowerCase().includes(search),
      )
    if (!matchesSearch) return false
    if (filter.value === 'unsubmitted') return !row.id
    if (filter.value === 'submitted') return row.id && row.status === 'submitted'
    if (filter.value === 'late') return row.is_late === 1
    if (filter.value === 'returned') return row.status === 'returned'
    if (filter.value === 'graded') return row.status === 'graded'
    if (filter.value === 'missingPreview') return row.id && !(row.preview_count > 0)
    return true
  })
})

const stats = computed(() => ({
  all: allRows.value.length,
  submitted: allRows.value.filter((row) => row.id).length,
  unsubmitted: allRows.value.filter((row) => !row.id).length,
  graded: allRows.value.filter((row) => row.status === 'graded').length,
}))

async function load() {
  const sequence = ++loadSequence
  const assignmentId = route.params.id
  try {
    const [assignmentResponse, submissionResponse] = await Promise.all([
      api.get(`/assignments/${assignmentId}`),
      api.get(`/assignments/${assignmentId}/submissions`),
    ])
    if (sequence !== loadSequence) return
    assignment.value = assignmentResponse.data
    allRows.value = submissionResponse.data
    await redeemPreviewTickets()
  } catch (error) {
    if (sequence === loadSequence) ElMessage.error(messageOf(error))
  }
}

// <img> 不携带登录头：批量换取短期票据 URL 供缩略图/大图加载。
async function redeemPreviewTickets() {
  const all = allRows.value.flatMap((row) => row.previews || [])
  if (!all.length) return
  try {
    const { data } = await api.post('/previews/view-ticket', {
      ids: all.map((preview) => preview.id),
    })
    for (const row of allRows.value) {
      for (const preview of row.previews || []) {
        const ticket = data.tickets[preview.id]
        if (ticket) {
          preview.thumbnail = ticket.thumbnail
          preview.preview = ticket.file
        }
      }
    }
  } catch {
    /* 票据失败时列表仍可见，点开单图走带登录头的接口 */
  }
}

const editDraftKey = () =>
  `draft:grading:${readUser()?.id || 'guest'}:${route.params.id}:${current.value.api_base || 'none'}:${mode.value}`
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

function openWorkspace(row) {
  workspaceRow.value = row
  workspace.value = true
}
async function onWorkspaceSaved(row, advance) {
  await load()
  if (advance) {
    const fresh = allRows.value.find((candidate) => candidate.api_base === row.api_base)
    if (fresh) workspaceRow.value = fresh
  } else if (workspace.value) {
    const fresh = allRows.value.find((candidate) => candidate.api_base === row.api_base)
    if (fresh) workspaceRow.value = fresh
  }
}

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
      score > Number(assignment.value.total_score)
    ) {
      ElMessage.warning(`成绩必须在 0 到 ${assignment.value.total_score} 之间`)
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
    await load()
  } catch (error) {
    ElMessage.error(messageOf(error))
  } finally {
    saving.value = false
  }
}

function safeName(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .trim()
}

function fileNameFor(row, source) {
  const [datePart = '', timePart = ''] = String(source.submitted_at || '').split(' ')
  const [, month = '', day = ''] = datePart.split('-')
  const [hour = '', minute = ''] = timePart.split(':')
  const timestamp = `${month}-${day}-${hour}-${minute}`
  const rawName = source.file_name || ''
  const dot = rawName.lastIndexOf('.')
  const extension = dot > 0 ? rawName.slice(dot + 1) || 'bin' : 'txt'
  return `${safeName(row.name)}_${safeName(row.username)}_${timestamp}_${source.is_late ? '迟交' : '准时'}.${extension}`
}

function rowFiles(row) {
  if (row.files?.length) return row.files
  if (row.file_name)
    return [
      {
        history_id: null,
        file_name: row.file_name,
        file_size: row.file_size,
        is_late: row.is_late,
        submitted_at: row.submitted_at,
      },
    ]
  return row.content
    ? [
        {
          history_id: null,
          file_name: null,
          content: row.content,
          is_late: row.is_late,
          submitted_at: row.submitted_at,
        },
      ]
    : []
}

async function downloadSingle(row, file) {
  const url = file.history_id
    ? `${row.api_base}/file?history_id=${file.history_id}`
    : `${row.api_base}/file`
  const group = row.api_base.startsWith('/group-submissions/')
  await downloadTask.start({
    endpoint: `/api${url}`,
    ticket: { kind: 'submission-file', id: row.id, group, historyId: file.history_id },
    fileName: fileNameFor(row, file),
    fileSize: file.file_size || 0,
  })
}

async function download(row) {
  const group = row.api_base.startsWith('/group-submissions/')
  await downloadTask.start({
    endpoint: `/api${row.api_base}/package`,
    ticket: { kind: 'submission-package', id: row.id, group },
    fileName: `${assignment.value.title}-${row.name}.zip`,
  })
}

async function downloadAll() {
  await downloadTask.start({
    endpoint: `/api/assignments/${route.params.id}/package`,
    ticket: { kind: 'assignment-package', id: Number(route.params.id) },
    fileName: `${assignment.value.title}-全部作业.zip`,
  })
}

async function exportExcel() {
  try {
    const response = await api.get(`/assignments/${route.params.id}/export`, {
      responseType: 'blob',
      timeout: 0,
    })
    downloadBlob(response.data, `${assignment.value.title}-成绩表.xlsx`)
  } catch (error) {
    ElMessage.error(messageOf(error))
  }
}

function protectUnsavedGrade(event) {
  if (!dialog.value || editSnapshot() === editBaseline) return
  event.preventDefault()
  event.returnValue = ''
}

watch(
  () => route.params.id,
  () => {
    dialog.value = false
    load()
  },
)
onMounted(() => {
  load()
  window.addEventListener('beforeunload', protectUnsavedGrade)
})
onUnmounted(() => window.removeEventListener('beforeunload', protectUnsavedGrade))
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <el-button text @click="router.push(`/teacher/courses/${assignment.course_id || ''}`)"
          >← 返回课程</el-button
        >
        <h1>{{ assignment.title || '提交管理' }}</h1>
        <p>
          截止 {{ assignment.deadline || '不限' }} · 满分 {{ assignment.total_score }} ·
          {{ assignment.submission_mode === 'append' ? '追加模式' : '覆盖模式' }}
        </p>
      </div>
      <div class="assignment-actions">
        <el-button @click="exportExcel">导出成绩表</el-button>
        <el-button
          type="primary"
          color="#15554e"
          @click="downloadAll"
        >
          一键下载全部作业
        </el-button>
      </div>
    </div>

    <el-alert
      v-if="stats.unsubmitted > 0"
      :title="`还有 ${stats.unsubmitted} ${assignment.work_mode === 'group' ? '组' : '名学生'}未提交`"
      type="warning"
      show-icon
      :closable="false"
      style="margin-bottom: 18px"
    />

    <p v-if="assignment.work_mode === 'group'" class="hint">
      成员覆盖：{{
        allRows.reduce((sum, submissionRow) => sum + (submissionRow.members?.length || 0), 0)
      }}人。以下提交统计以组为单位。
    </p>
    <div class="stat-strip">
      <div class="stat">
        <b>{{ stats.all }}</b
        ><span>{{ assignment.work_mode === 'group' ? '应交组数' : '应交人数' }}</span>
      </div>
      <div class="stat">
        <b>{{ stats.submitted }}</b
        ><span>已提交</span>
      </div>
      <div class="stat">
        <b>{{ stats.unsubmitted }}</b
        ><span>未提交</span>
      </div>
      <div class="stat">
        <b>{{ stats.graded }}</b
        ><span>已评分</span>
      </div>
    </div>

    <div class="panel">
      <div class="toolbar">
        <el-radio-group v-model="filter">
          <el-radio-button value="all">全部（{{ counts.all }}）</el-radio-button>
          <el-radio-button value="unsubmitted">未交（{{ counts.unsubmitted }}）</el-radio-button>
          <el-radio-button value="submitted">待批改（{{ counts.submitted }}）</el-radio-button>
          <el-radio-button v-if="requirePreview" value="missingPreview"
            >缺预览（{{ counts.missingPreview }}）</el-radio-button
          >
          <el-radio-button value="late">迟交（{{ counts.late }}）</el-radio-button>
          <el-radio-button value="returned">已退回（{{ counts.returned }}）</el-radio-button>
          <el-radio-button value="graded">已评分（{{ counts.graded }}）</el-radio-button>
        </el-radio-group>
        <el-input v-model="keyword" clearable placeholder="搜索学号或姓名" style="width: 220px" />
      </div>

      <el-table :data="rows" stripe border>
        <el-table-column
          prop="username"
          :label="assignment.work_mode === 'group' ? '小组' : '学号'"
          width="150"
        />
        <el-table-column v-if="assignment.work_mode === 'group'" label="固定成员" min-width="180"
          ><template #default="{ row }">{{
            row.members
              ?.map((member) => member.name + '（' + member.username + '）')
              .join('、')
          }}</template></el-table-column
        >
        <el-table-column prop="name" label="姓名" width="110" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag v-if="!row.id" type="info">未交</el-tag>
            <el-tag
              v-else
              :type="
                row.status === 'graded' ? 'success' : row.status === 'returned' ? 'warning' : ''
              "
            >
              {{ { submitted: '待批改', graded: '已评分', returned: '已退回' }[row.status] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column v-if="assignment.work_mode === 'group'" label="实际提交人" min-width="150"
          ><template #default="{ row }"
            >{{ row.submitted_by_name || '—' }} {{ row.submitted_by_username || '' }}</template
          ></el-table-column
        >
        <el-table-column prop="submit_count" label="次数" width="70" />
        <el-table-column prop="submitted_at" label="提交时间" min-width="190">
          <template #default="{ row }">
            <span :class="{ late: row.is_late }"
              >{{ row.submitted_at || '—' }} {{ row.is_late ? '（迟交）' : '' }}</span
            >
          </template>
        </el-table-column>
        <el-table-column label="文件" min-width="260">
          <template #default="{ row }">
            <div v-if="row.previews?.length" class="preview-strip">
              <el-image
                v-for="preview in row.previews"
                :key="preview.id"
                :src="preview.thumbnail || preview.preview"
                :preview-src-list="row.previews.map((item) => item.preview)"
                :initial-index="row.previews.indexOf(preview)"
                fit="cover"
                class="preview-thumb"
                hide-on-click-modal
                :preview-teleported="true"
              />
              <span class="hint">{{ row.preview_count }} 张预览图，点击放大查看</span>
            </div>
            <template v-if="rowFiles(row).length">
              <div
                v-for="file in rowFiles(row)"
                :key="file.history_id || 'latest'"
                class="file-cell"
              >
                <el-button
                  link
                  type="primary"
                  @click="downloadSingle(row, file)"
                  >{{ file.file_name || '在线作答' }}</el-button
                >
                <span v-if="file.is_late" class="late"> · 迟交</span>
              </div>
            </template>
            <span v-else class="hint">—</span>
          </template>
        </el-table-column>
        <el-table-column prop="score" label="成绩" width="80" />
        <el-table-column label="操作" width="230">
          <template #default="{ row }">
            <template v-if="row.id">
              <el-button v-if="row.previews?.length" link type="success" @click="openWorkspace(row)"
                >看图评分</el-button
              >
              <el-button
                v-if="rowFiles(row).length"
                link
                @click="download(row)"
                >下载</el-button
              >
              <SubmissionRecords
                :api-base="row.api_base"
                @download="downloadTask.start"
              /><el-button
                :disabled="assignment.course_status === 'archived'"
                link
                type="primary"
                @click="open(row, 'grade')"
                >评分</el-button
              >
              <el-button
                :disabled="assignment.course_status === 'archived'"
                link
                type="warning"
                @click="open(row, 'return')"
                >退回</el-button
              >
            </template>
            <span v-else class="hint">等待提交</span>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <AssignmentGroups
      v-if="assignment.work_mode === 'group'"
      :key="`groups-${route.params.id}`"
      :assignment="assignment"
      :readonly="assignment.course_status === 'archived'"
    />
    <ExtensionsPanel
      :key="`extensions-${route.params.id}`"
      :assignment-id="route.params.id"
      :readonly="assignment.course_status === 'archived' || assignment.status !== 'published'"
      @changed="load"
    />
    <DownloadTask
      :tasks="downloadTask.tasks.value"
      @pause="downloadTask.pause"
      @resume="downloadTask.resume"
      @cancel="downloadTask.cancel"
      @open-folder="downloadTask.openFolder"
      @dismiss="downloadTask.dismiss"
    />
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
        <el-button v-if="editDraftSaved" :disabled="saving" @click="open(current, mode)"
          >放弃草稿</el-button
        >
        <el-button
          :type="mode === 'grade' ? 'primary' : 'warning'"
          :color="mode === 'grade' ? '#15554e' : ''"
          :loading="saving"
          @click="save"
          >确认</el-button
        >
      </template>
    </el-dialog>
    <GradeWorkspace
      v-model="workspace"
      :row="workspaceRow"
      :rows="allRows.filter((row) => row.id)"
      :assignment="assignment"
      @saved="onWorkspaceSaved"
    />
  </div>
</template>

<style scoped>
.file-cell + .file-cell {
  margin-top: 4px;
}
.preview-strip {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.preview-thumb {
  width: 56px;
  height: 42px;
  border-radius: 6px;
  border: 1px solid var(--line);
  cursor: zoom-in;
}
</style>
