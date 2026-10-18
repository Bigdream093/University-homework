<script setup>
import { ref } from 'vue'
import GradeWorkspace from './GradeWorkspace.vue'
import CourseGradeTable from './CourseGradeTable.vue'
import CourseGradeSettings from './CourseGradeSettings.vue'
import DownloadTask from './DownloadTask.vue'
import { useDownload } from '../composables/useDownload.js'
import { fileNameFor } from '../utils/submissionFiles.js'
import { useCourseSummary } from '../composables/useCourseSummary.js'
import { useSummaryWorkspace } from '../composables/useSummaryWorkspace.js'
const props = defineProps({
  courseId: { type: [String, Number], required: true },
  courseName: { type: String, default: '' },
  readonly: Boolean,
})
const {
  loading,
  loadError,
  load,
  assignments,
  students,
  draft,
  dirty,
  keyword,
  showDraftColumns,
  saving,
  exporting,
  visibleAssignments,
  tableRows,
  finalCandidates,
  weightRows,
  weightSum,
  dailyTarget,
  weightsMatch,
  finalAssignment,
  distributeEvenly,
  saveConfig,
  exportExcel,
  redeemTickets,
  applyTickets,
} = useCourseSummary(props)
const {
  workspace,
  workspaceRow,
  workspaceRows,
  workspaceAssignment,
  workspaceIntent,
  openWorkspace,
  onWorkspaceSaved,
} = useSummaryWorkspace(students, assignments, redeemTickets, applyTickets, () => props.courseId)
const showWeights = ref(false)
const downloadTask = useDownload()
function downloadWorkspaceFile(row, file) {
  const group = String(row.api_base || '').startsWith('/group-submissions/')
  downloadTask.start({
    endpoint: `/api${file.history_id ? `${row.api_base}/file?history_id=${file.history_id}` : `${row.api_base}/file`}`,
    ticket: {
      kind: 'submission-file',
      id: row.id,
      group,
      historyId: file.history_id,
    },
    fileName: fileNameFor(row, file),
    fileSize: file.file_size || 0,
  })
}
function updateWeight(id, value) {
  draft.weights[id] = value
}
</script>
<template>
  <div v-loading="loading">
    <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" show-icon>
      <el-button @click="load">重新加载</el-button>
    </el-alert>
    <template v-else>
      <div class="toolbar summary-toolbar">
        <div class="config-group summary-config-row">
          <span class="label">期末作业</span>
          <el-select
            v-model="draft.final_assignment_id"
            clearable
            placeholder="未指定"
            style="width: 200px"
            :disabled="readonly"
          >
            <el-option
              v-for="assignment in finalCandidates"
              :key="assignment.id"
              :label="assignment.title"
              :value="assignment.id"
            />
          </el-select>
          <span class="label">平时占比</span>
          <el-input-number
            v-model="draft.daily_ratio"
            :min="0"
            :max="100"
            :step="5"
            :disabled="readonly"
            style="width: 110px"
          />
          <span class="hint">%</span>
          <span class="hint">期末 {{ draft.final_ratio }}%</span>
          <el-select v-model="draft.grade_absent_mode" style="width: 210px" :disabled="readonly">
            <el-option label="未交、未评均按 0 分计入" value="zero" />
            <el-option label="未评不计入，未交按 0 分计入" value="skip_ungraded" />
          </el-select>
          <el-button :disabled="readonly" @click="showWeights = true">占比设置</el-button>
        </div>
        <div class="summary-action-row">
          <div class="config-group summary-filters">
            <el-input
              v-model="keyword"
              clearable
              placeholder="搜索学号或姓名"
              style="width: 220px"
            />
            <el-checkbox v-model="showDraftColumns">显示草稿作业</el-checkbox>
          </div>
          <div class="config-group summary-actions">
            <el-button
              type="primary"
              color="#15554e"
              :disabled="!dirty || readonly || !weightsMatch"
              :loading="saving"
              @click="saveConfig()"
              >保存设置</el-button
            >
            <el-button :loading="exporting" @click="exportExcel">导出成绩表</el-button>
          </div>
        </div>
      </div>
      <el-alert
        v-if="dirty && !readonly"
        title="成绩设置已修改但尚未保存：三栏成绩为按当前设置的预览值，导出前会自动保存。"
        type="warning"
        show-icon
        :closable="false"
        style="margin-bottom: 12px"
      />
      <div class="summary-hint hint">
        点击预览图可直接放大；点击评分入口可查看答案和源文件并批改。三栏均为百分制，保留 1
        位小数<span v-if="!finalAssignment">；尚未指定期末作业，总成绩暂按平时成绩</span
        ><span v-else>；期末未评分的学生总成绩暂按平时成绩</span>。
      </div>

      <CourseGradeTable
        :table-rows="tableRows"
        :visible-assignments="visibleAssignments"
        :draft="draft"
        :readonly="readonly"
        @workspace="openWorkspace"
      />
      <CourseGradeSettings
        v-model="showWeights"
        :draft="draft"
        :weight-rows="weightRows"
        :weight-sum="weightSum"
        :daily-target="dailyTarget"
        :weights-match="weightsMatch"
        :final-assignment="finalAssignment"
        :readonly="readonly"
        @weight="updateWeight"
        @distribute="distributeEvenly"
      />
      <GradeWorkspace
        v-model="workspace"
        :row="workspaceRow"
        :rows="workspaceRows"
        :assignment="workspaceAssignment"
        :initial-intent="workspaceIntent"
        :readonly="readonly"
        @saved="onWorkspaceSaved"
        @download-file="downloadWorkspaceFile"
      />
      <DownloadTask
        :tasks="downloadTask.tasks.value"
        @pause="downloadTask.pause"
        @resume="downloadTask.resume"
        @cancel="downloadTask.cancel"
        @open-folder="downloadTask.openFolder"
        @dismiss="downloadTask.dismiss"
      />
    </template>
  </div>
</template>

<style scoped>
.summary-toolbar {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  margin-bottom: 12px;
}
.config-group {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.summary-config-row {
  padding: 10px 12px;
  border: 1px solid #e1ebe7;
  border-radius: 10px;
  background: #f7faf8;
}
.config-group .label {
  color: #40605a;
  font-size: 13px;
  font-weight: 600;
}
.summary-action-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.summary-filters,
.summary-actions {
  flex-wrap: wrap;
}
.summary-hint {
  margin: 0 0 10px;
  padding: 8px 12px;
  border-left: 3px solid #91b7ad;
  border-radius: 0 8px 8px 0;
  background: #f7faf8;
  color: #637d76;
  font-size: 13px;
  line-height: 1.6;
}
@media (max-width: 760px) {
  .summary-action-row {
    align-items: stretch;
    flex-direction: column;
  }
  .summary-actions {
    justify-content: flex-start;
  }
}
</style>
