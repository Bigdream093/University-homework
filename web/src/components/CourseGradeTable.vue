<script setup>
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import api, { messageOf } from '../api/request.js'
const props = defineProps({
  tableRows: { type: Array, required: true },
  visibleAssignments: { type: Array, required: true },
  draft: { type: Object, required: true },
  readonly: Boolean,
})
const emit = defineEmits(['workspace', 'graded'])
const editingKey = ref(''),
  editValue = ref(null)
const formatScore = (value) =>
  value === null || value === undefined || !Number.isFinite(Number(value))
    ? '—'
    : (Math.round(Number(value) * 10) / 10).toFixed(1)

function startEdit(student, assignment) {
  const cell = student.cells?.[assignment.id]
  if (!cell || cell.not_assigned || !cell.id || props.readonly) return
  editingKey.value = `${student.id}:${assignment.id}`
  editValue.value = cell.status === 'graded' ? cell.score : null
}
async function confirmEdit(student, assignment) {
  const key = `${student.id}:${assignment.id}`
  if (editingKey.value !== key) return
  editingKey.value = ''
  const cell = student.cells?.[assignment.id]
  if (!cell || !cell.id) return
  const score = Number(editValue.value)
  if (
    editValue.value === null ||
    editValue.value === '' ||
    !Number.isFinite(score) ||
    score < 0 ||
    score > Number(assignment.total_score)
  ) {
    ElMessage.warning(`成绩必须在 0 到 ${assignment.total_score} 之间`)
    return
  }
  try {
    await api.post(cell.api_base + '/grade', { score, comment: cell.comment || '' })
    emit('graded', { studentId: student.id, assignmentId: assignment.id, score })
    ElMessage.success('成绩已保存')
  } catch (error) {
    ElMessage.error(messageOf(error))
  }
}

const statusLabel = (cell) => ({ submitted: '待批改', returned: '已退回' })[cell.status] || '未评分'
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
            <div
              v-if="row.cells[assignment.id].previews?.length"
              class="thumb-wrap"
              title="点击打开看图评分"
              @click="emit('workspace', row, assignment)"
            >
              <img
                :src="
                  row.cells[assignment.id].previews[0].thumbnail ||
                  row.cells[assignment.id].previews[0].preview
                "
                class="cell-thumb"
                alt=""
                loading="lazy"
              />
              <span v-if="row.cells[assignment.id].preview_count > 1" class="thumb-badge"
                >{{ row.cells[assignment.id].preview_count }}张</span
              >
            </div>
            <el-button v-else link type="primary" @click="emit('workspace', row, assignment)">{{
              row.cells[assignment.id].file_name || '在线作答'
            }}</el-button>
            <div class="score-line">
              <template v-if="editingKey === `${row.id}:${assignment.id}`">
                <el-input-number
                  v-model="editValue"
                  :min="0"
                  :max="assignment.total_score"
                  size="small"
                  style="width: 110px"
                  @keyup.enter="confirmEdit(row, assignment)"
                  @blur="confirmEdit(row, assignment)"
                />
              </template>
              <template v-else>
                <span
                  v-if="row.cells[assignment.id].status === 'graded'"
                  class="score"
                  :title="readonly ? '' : '点击修改成绩'"
                  @click="startEdit(row, assignment)"
                  >{{ row.cells[assignment.id].score
                  }}<span v-if="row.cells[assignment.id].is_late" class="late-mark">迟</span></span
                >
                <span
                  v-else
                  class="score pending"
                  :title="readonly ? '' : '点击直接评分'"
                  @click="startEdit(row, assignment)"
                  >{{ statusLabel(row.cells[assignment.id]) }}</span
                >
              </template>
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
    <el-table-column label="总成绩" width="100" fixed="right" align="center">
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
  gap: 6px;
  padding: 6px 0;
}
.thumb-wrap {
  position: relative;
  cursor: zoom-in;
  line-height: 0;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--line);
}
.cell-thumb {
  width: 88px;
  height: 64px;
  object-fit: cover;
  display: block;
}
.thumb-badge {
  position: absolute;
  right: 4px;
  bottom: 4px;
  background: rgba(21, 85, 78, 0.85);
  color: #fff;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 8px;
  line-height: 1.5;
}
.score {
  cursor: pointer;
  color: #15554e;
  font-weight: 600;
  border-bottom: 1px dashed #9ab8b2;
}
.score:hover {
  color: #0d3b36;
}
.score.pending {
  color: #b58a2a;
  font-weight: 400;
  border-bottom: none;
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
  padding: 24px 0;
}
.cell-sub {
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.total {
  color: #15554e;
}
</style>
