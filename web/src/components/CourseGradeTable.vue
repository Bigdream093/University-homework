<script setup>
import SubmissionPreview from './SubmissionPreview.vue'
import { round1 } from '@university-homework/domain/numbers'
defineProps({
  tableRows: { type: Array, required: true },
  visibleAssignments: { type: Array, required: true },
  draft: { type: Object, required: true },
  readonly: Boolean,
})
const emit = defineEmits(['workspace'])
const formatScore = (value) =>
  value === null || value === undefined || !Number.isFinite(Number(value))
    ? '—'
    : round1(Number(value)).toFixed(1)

const workspaceLabel = (cell) =>
  ({ submitted: '评分', returned: '查看退回作业', graded: '查看评分' })[cell.status] || '查看作业'

function openWorkspace(row, assignment) {
  const cell = row.cells[assignment.id]
  emit('workspace', row, assignment, cell.status === 'submitted' ? 'grade' : 'view')
}
</script>
<template>
  <el-table :data="tableRows" stripe border size="default" class="summary-table">
    <el-table-column prop="username" label="学号" width="130" fixed="left" />
    <el-table-column prop="name" label="姓名" width="100" fixed="left">
      <template #default="{ row }">
        {{ row.name }}
        <el-tag v-if="row.status !== 'active'" size="small" type="info" style="margin-left: 4px"
          >停用</el-tag
        >
      </template>
    </el-table-column>
    <el-table-column
      v-for="assignment in visibleAssignments"
      :key="assignment.id"
      :label="assignment.title"
      min-width="170"
      align="center"
    >
      <template #header>
        <div class="col-head">
          <span class="col-title">{{ assignment.title }}</span>
          <span class="col-tags">
            <el-tag
              v-if="assignment.id === Number(draft.final_assignment_id)"
              size="small"
              type="danger"
              >期末</el-tag
            >
            <el-tag v-else size="small" type="info"
              >占比 {{ draft.weights?.[assignment.id] ?? 0 }}%</el-tag
            >
            <el-tag v-if="assignment.status === 'draft'" size="small" type="warning">草稿</el-tag>
          </span>
        </div>
      </template>
      <template #default="{ row }">
        <template v-if="row.cells[assignment.id] && row.cells[assignment.id].id">
          <div class="cell-box">
            <el-button link type="primary" @click="openWorkspace(row, assignment)">{{
              workspaceLabel(row.cells[assignment.id])
            }}</el-button>
            <SubmissionPreview
              v-if="row.cells[assignment.id].previews?.length"
              :previews="row.cells[assignment.id].previews"
              :title="`${row.name} · ${assignment.title}`"
            />
            <div v-if="row.cells[assignment.id].status === 'graded'" class="score">
              {{ formatScore(row.cells[assignment.id].score) }} 分
              <span v-if="row.cells[assignment.id].is_late" class="late-mark">迟</span>
            </div>
            <div v-else class="cell-sub hint">
              {{ row.cells[assignment.id].status === 'returned' ? '等待学生修改' : '待批改' }}
            </div>
            <div
              v-if="row.cells[assignment.id].group_name"
              class="cell-sub hint"
              :title="
                (row.cells[assignment.id].members || [])
                  .map((member) => member.name + '（' + member.username + '）')
                  .join('、')
              "
            >
              {{ row.cells[assignment.id].group_name }}
            </div>
          </div>
        </template>
        <span
          v-else-if="row.cells[assignment.id] && row.cells[assignment.id].not_assigned"
          class="cell-empty hint"
          >未安排</span
        >
        <span v-else class="cell-empty hint">未交</span>
      </template>
    </el-table-column>
    <el-table-column label="平时成绩" width="100" fixed="right" align="center">
      <template #default="{ row }"
        ><b>{{ formatScore(row.live.daily) }}</b></template
      >
    </el-table-column>
    <el-table-column label="期末成绩" width="100" fixed="right" align="center">
      <template #default="{ row }"
        ><b>{{ formatScore(row.live.final) }}</b></template
      >
    </el-table-column>
    <el-table-column
      label="总成绩"
      width="100"
      fixed="right"
      align="center"
      class-name="total-score-cell"
      label-class-name="total-score-header"
    >
      <template #default="{ row }"
        ><b class="total">{{ formatScore(row.live.total) }}</b></template
      >
    </el-table-column>
    <template #empty>
      <div class="empty">课程里还没有学生或作业。</div>
    </template>
  </el-table>
</template>
<style scoped>
.summary-table {
  width: 100%;
}
.summary-table :deep(.el-table__header-wrapper th.el-table__cell) {
  background: #f3f8f5;
  color: #47645d;
  font-weight: 600;
}
.summary-table :deep(.el-table__body td.el-table__cell) {
  padding-top: 6px;
  padding-bottom: 6px;
}
.summary-table :deep(.el-table__body tr:hover > td.el-table__cell) {
  background: #f5faf7;
}
.summary-table :deep(.el-table__body td.total-score-cell) {
  background: #f5faf8;
}
.summary-table :deep(.el-table__header th.total-score-header) {
  background: #eaf3ef;
  color: #15554e;
}
.col-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: center;
}
.col-title {
  font-weight: 600;
  line-height: 1.3;
  word-break: break-all;
}
.col-tags {
  display: flex;
  gap: 4px;
}
.cell-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 4px 0;
}
.score {
  color: #15554e;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.late-mark {
  margin-left: 4px;
  font-size: 11px;
  color: #c45656;
  border: 1px solid #c45656;
  border-radius: 4px;
  padding: 0 3px;
  font-weight: 400;
}
.cell-empty {
  display: inline-block;
  padding: 14px 0;
  color: #84958f;
}
.cell-sub {
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.total {
  color: #15554e;
  font-size: 15px;
  font-variant-numeric: tabular-nums;
}
</style>
