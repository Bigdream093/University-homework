<script setup>
import { ref } from 'vue'
import GradeWorkspace from './GradeWorkspace.vue'
import CourseGradeTable from './CourseGradeTable.vue'
import CourseGradeSettings from './CourseGradeSettings.vue'
import { useCourseSummary } from '../composables/useCourseSummary.js'
import { useSummaryWorkspace } from '../composables/useSummaryWorkspace.js'
const props = defineProps({
  courseId: { type: [String, Number], required: true },
  courseName: { type: String, default: '' },
  readonly: Boolean,
})
const {
  loading,
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
  load,
  saveConfig,
  exportExcel,
  redeemTickets,
  applyTickets,
  onGraded,
} = useCourseSummary(props)
const {
  workspace,
  workspaceRow,
  workspaceRows,
  workspaceAssignment,
  openWorkspace,
  onWorkspaceSaved,
} = useSummaryWorkspace(students, assignments, load, redeemTickets, applyTickets)
const showWeights = ref(false)
function updateWeight(id, value) {
  draft.weights[id] = value
}
</script>
<template>
  <div v-loading="loading">
    <div class="toolbar summary-toolbar">
      <div class="config-group">
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
      <div class="config-group">
        <el-input v-model="keyword" clearable placeholder="搜索学号或姓名" style="width: 200px" />
        <el-checkbox v-model="showDraftColumns">显示草稿作业</el-checkbox>
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
    <el-alert
      v-if="dirty && !readonly"
      title="成绩设置已修改但尚未保存：三栏成绩为按当前设置的预览值，导出前会自动保存。"
      type="warning"
      show-icon
      :closable="false"
      style="margin-bottom: 12px"
    />
    <div class="summary-hint hint">
      点击图片打开看图评分（可翻看全部图片、改分、评语、退回）；点击分数可直接修改。三栏均为百分制，保留
      1 位小数<span v-if="!finalAssignment">；尚未指定期末作业，总成绩暂按平时成绩</span
      ><span v-else>；期末未评分的学生总成绩暂按平时成绩</span>。
    </div>

    <CourseGradeTable
      :table-rows="tableRows"
      :visible-assignments="visibleAssignments"
      :draft="draft"
      :readonly="readonly"
      @workspace="openWorkspace"
      @graded="onGraded"
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
      @saved="onWorkspaceSaved"
    />
  </div>
</template>

<style scoped>
.summary-toolbar {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}
.config-group {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.config-group .label {
  color: #40605a;
  font-size: 13px;
}
.summary-hint {
  margin: 0 0 12px;
}
</style>
