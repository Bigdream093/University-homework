<script setup>
import { onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import SubmissionTable from '../../components/SubmissionTable.vue'
import SubmissionGradeDialog from '../../components/SubmissionGradeDialog.vue'
import { useSubmissions } from '../../composables/useSubmissions.js'
import { useSubmissionDownloads } from '../../composables/useSubmissionDownloads.js'
import ExtensionsPanel from '../../components/ExtensionsPanel.vue'
import AssignmentGroups from '../../components/AssignmentGroups.vue'
import GradeWorkspace from '../../components/GradeWorkspace.vue'
import DownloadTask from '../../components/DownloadTask.vue'
const route = useRoute(),
  router = useRouter()
const { assignment, allRows, filter, keyword, requirePreview, counts, rows, stats, load } =
  useSubmissions(route)
const { downloadTask, downloadSingle, download, downloadAll, exportExcel } = useSubmissionDownloads(
  route,
  assignment,
)
const gradeDialog = ref(null)
const workspace = ref(false),
  workspaceRow = ref(null)
function open(row, mode) {
  gradeDialog.value?.open(row, mode)
}
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

watch(() => route.params.id, load)
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
        <p>
          截止 {{ assignment.deadline || '不限' }} · 满分 {{ assignment.total_score }} ·
          {{ assignment.submission_mode === 'append' ? '追加模式' : '覆盖模式' }}
        </p>
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

      <SubmissionTable
        :rows="rows"
        :assignment="assignment"
        @download-file="downloadSingle"
        @download="download"
        @download-task="downloadTask.start"
        @workspace="openWorkspace"
        @grade="open"
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
    <SubmissionGradeDialog
      :key="route.params.id"
      ref="gradeDialog"
      :assignment="assignment"
      @saved="load"
    />
    <GradeWorkspace
      v-model="workspace"
      :row="workspaceRow"
      :rows="allRows.filter((row) => row.id)"
      :assignment="assignment"
      @saved="onWorkspaceSaved"
    />
  </div>
</template>
