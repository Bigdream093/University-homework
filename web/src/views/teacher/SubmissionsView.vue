<script setup>
import { computed, h, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRoute, useRouter } from 'vue-router'
import SubmissionTable from '../../components/SubmissionTable.vue'
import api, { messageOf } from '../../api/request.js'
import { gradingItem } from '../../api/grading.js'
import { useSubmissions } from '../../composables/useSubmissions.js'
import { useSubmissionDownloads } from '../../composables/useSubmissionDownloads.js'
import ExtensionsPanel from '../../components/ExtensionsPanel.vue'
import AssignmentGroups from '../../components/AssignmentGroups.vue'
import GradeWorkspace from '../../components/GradeWorkspace.vue'
import DownloadTask from '../../components/DownloadTask.vue'
import { parseGradeScore } from '../../utils/grading.js'
const route = useRoute(),
  router = useRouter()
const {
  assignment,
  allRows,
  filter,
  lateOnly,
  keyword,
  loadError,
  counts,
  rows,
  stats,
  page,
  pageSize,
  total,
  findNextPending,
  load,
  refreshPreviewTickets,
} = useSubmissions(route)
const { downloadTask, downloadSingle, downloadAll, exportExcel } = useSubmissionDownloads(
  route,
  assignment,
)
const workspace = ref(false),
  workspaceRow = ref(null),
  workspaceIntent = ref('grade')
const selectedRows = ref([])
const submittedSelection = computed(() =>
  selectedRows.value.filter((row) => row.id && row.status === 'submitted'),
)
async function openWorkspace(row, intent = 'grade') {
  const assignmentId = route.params.id
  await refreshPreviewTickets(row)
  if (String(route.params.id) !== String(assignmentId)) return
  workspaceRow.value = allRows.value.find((candidate) => candidate.api_base === row.api_base) || row
  workspaceIntent.value = intent
  workspace.value = true
}
async function onWorkspaceSaved(row, advance, nextRow) {
  await load()
  if (advance) {
    let next = nextRow
    if (!next) {
      try {
        next = await findNextPending(row)
      } catch (error) {
        ElMessage.error(`已保存本份作业，但未能载入下一份：${messageOf(error)}`)
      }
    }
    if (next) {
      await refreshPreviewTickets(next)
      workspaceRow.value =
        allRows.value.find((candidate) => candidate.api_base === next.api_base) || next
      workspaceIntent.value = 'grade'
      workspace.value = true
    } else {
      workspace.value = false
    }
  } else if (workspace.value || row?.api_base) {
    const fresh = allRows.value.find((candidate) => candidate.api_base === row.api_base)
    if (fresh) workspaceRow.value = fresh
  }
}

function batchItems(rows) {
  return rows.map((row) =>
    row.id
      ? gradingItem(row)
      : {
          kind: row.kind || (row.assignment_group_id ? 'group' : 'individual'),
          student_id: row.student_id,
          assignment_group_id: row.assignment_group_id,
        },
  )
}

async function showBatchResults(action, rows) {
  try {
    const { data } = await api.post(`/assignments/${route.params.id}/batch-${action}`, {
      items: batchItems(rows),
      ...batchPayload.value,
    })
    const details = data.results.map((result) => {
      const row = rows.find((candidate) =>
        result.id
          ? candidate.id === result.id && candidate.kind === result.kind
          : !candidate.id &&
            candidate.kind === result.kind &&
            candidate.student_id === result.student_id &&
            candidate.assignment_group_id === result.assignment_group_id,
      )
      const name = row?.name || row?.username || '记录'
      return { ...result, label: `${name}：${result.success ? '成功' : '失败'}，${result.message}` }
    })
    await ElMessageBox.alert(
      h(
        'div',
        { class: 'batch-result-list' },
        details.map((result) =>
          h(
            'p',
            { class: result.success ? 'batch-result-ok' : 'batch-result-error' },
            result.label,
          ),
        ),
      ),
      `批量操作完成：成功 ${data.success_count} 条，失败 ${data.failure_count} 条`,
      { confirmButtonText: '完成', customClass: 'batch-result-dialog' },
    )
    await load()
    selectedRows.value = []
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(messageOf(error))
  }
}

const batchPayload = ref({})
async function batchGrade() {
  if (!submittedSelection.value.length) return
  try {
    const { value } = await ElMessageBox.prompt(
      `将对选中的 ${submittedSelection.value.length} 份已提交作业设置相同成绩（满分 ${assignment.value.total_score}）。`,
      '批量评分',
      {
        inputType: 'number',
        inputValue: '0',
        inputPattern: new RegExp(`^(?:\\d+(?:\\.\\d+)?|\\.\\d+)$`),
        inputErrorMessage: `请输入 0 到 ${assignment.value.total_score} 之间的成绩`,
      },
    )
    const score = parseGradeScore(value, assignment.value.total_score)
    if (score === null) {
      ElMessage.warning(`成绩必须在 0 到 ${assignment.value.total_score} 之间`)
      return
    }
    batchPayload.value = { score }
    await showBatchResults('grade', submittedSelection.value.slice())
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(messageOf(error))
  }
}

async function batchReturn() {
  if (!submittedSelection.value.length) return
  try {
    const { value } = await ElMessageBox.prompt(
      `将退回选中的 ${submittedSelection.value.length} 份已提交作业。`,
      '批量退回',
      { inputType: 'textarea', inputPlaceholder: '填写退回原因' },
    )
    if (!String(value || '').trim()) {
      ElMessage.warning('请填写退回原因')
      return
    }
    batchPayload.value = { returned_reason: value }
    await showBatchResults('return', submittedSelection.value.slice())
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(messageOf(error))
  }
}

watch(
  () => route.params.id,
  () => {
    selectedRows.value = []
    load()
  },
)
watch([filter, keyword, page, pageSize], () => {
  selectedRows.value = []
})
watch(
  () => [route.query?.review, allRows.value],
  async () => {
    const reviewId = Number(route.query?.review)
    if (!reviewId) return
    const kind = route.query?.review_kind === 'group' ? 'group' : 'individual'
    const row = allRows.value.find(
      (candidate) => candidate.id === reviewId && candidate.kind === kind,
    )
    if (!row) return
    openWorkspace(row, 'grade')
    const query = { ...(route.query || {}) }
    delete query.review
    delete query.review_kind
    await router.replace({ query })
  },
)
onMounted(load)
</script>
<template>
  <div>
    <div class="page-head">
      <div>
        <el-button text @click="router.push(`/teacher/courses/${assignment.course_id || ''}`)"
          >← 返回课程</el-button
        >
        <h1>{{ assignment.title || '提交管理' }}</h1>
        <p>截止 {{ assignment.deadline || '不限' }}</p>
      </div>
      <div class="assignment-actions">
        <el-button @click="exportExcel">导出成绩表</el-button>
        <el-button type="primary" color="#15554e" @click="downloadAll">
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
    <el-alert
      v-if="loadError"
      :title="loadError"
      type="error"
      show-icon
      :closable="false"
      style="margin-bottom: 18px"
      ><el-button @click="load">重新加载</el-button></el-alert
    >
    <div v-if="!loadError" class="stat-strip">
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

    <div v-if="!loadError" class="panel">
      <div class="toolbar">
        <el-radio-group v-model="filter">
          <el-radio-button value="unsubmitted">未交（{{ counts.unsubmitted }}）</el-radio-button>
          <el-radio-button value="submitted">待批改（{{ counts.submitted }}）</el-radio-button>
          <el-radio-button value="returned">已退回（{{ counts.returned }}）</el-radio-button>
          <el-radio-button value="graded">已经评分（{{ counts.graded }}）</el-radio-button>
        </el-radio-group>
        <el-checkbox v-model="lateOnly" v-if="['submitted', 'graded'].includes(filter)">
          只看迟交
        </el-checkbox>
        <el-input v-model="keyword" clearable placeholder="搜索学号或姓名" style="width: 220px" />
      </div>

      <div v-if="assignment.course_status !== 'archived'" class="toolbar batch-toolbar">
        <span class="hint">已选 {{ selectedRows.length }} 条</span>
        <el-button :disabled="!submittedSelection.length" @click="batchGrade"
          >评分（{{ submittedSelection.length }}）</el-button
        >
        <el-button type="warning" :disabled="!submittedSelection.length" @click="batchReturn"
          >退回（{{ submittedSelection.length }}）</el-button
        >
      </div>

      <SubmissionTable
        :rows="rows"
        :assignment="assignment"
        @download-file="downloadSingle"
        @workspace="openWorkspace"
        @selection-change="(selection) => (selectedRows = selection)"
      />
      <el-pagination
        v-if="total > 0"
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :page-sizes="[25, 50, 100]"
        :total="total"
        background
        layout="total, sizes, prev, pager, next, jumper"
        style="justify-content: flex-end; margin-top: 14px"
      />
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
    <GradeWorkspace
      v-model="workspace"
      :row="workspaceRow"
      :rows="allRows.filter((row) => row.id)"
      :assignment="assignment"
      :initial-intent="workspaceIntent"
      :readonly="assignment.course_status === 'archived'"
      @saved="onWorkspaceSaved"
      @download-file="downloadSingle"
    />
  </div>
</template>

<style scoped>
.batch-toolbar {
  margin: 10px 0;
  justify-content: flex-end;
}
</style>
