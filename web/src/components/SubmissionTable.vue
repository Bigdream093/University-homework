<script setup>
import SubmissionPreview from './SubmissionPreview.vue'
import { displayFileName, sourceFilesOf } from '../utils/submissionFiles.js'
defineProps({ rows: { type: Array, required: true }, assignment: { type: Object, required: true } })
const emit = defineEmits(['download-file', 'workspace', 'selection-change'])
function rowClassName({ row }) {
  return row.is_test_student && row.status === 'submitted' ? 'tester-pending-row' : ''
}
function selectable(row) {
  return row.status === 'submitted' && row.is_test_student !== 1 && row.is_test_student !== true
}
function latestFile(row) {
  const files = sourceFilesOf(row)
  return files[files.length - 1]
}
</script>
<template>
  <el-table
    :data="rows"
    stripe
    border
    table-layout="fixed"
    style="width: 100%"
    :row-class-name="rowClassName"
    @selection-change="emit('selection-change', $event)"
  >
    <el-table-column type="selection" width="42" fixed="left" :selectable="selectable" />
    <el-table-column
      prop="username"
      :label="assignment.work_mode === 'group' ? '小组' : '学号'"
      width="110"
      show-overflow-tooltip
    />
    <el-table-column v-if="assignment.work_mode === 'group'" label="固定成员" min-width="160"
      ><template #default="{ row }">{{
        row.members?.map((member) => member.name + '（' + member.username + '）').join('、')
      }}</template></el-table-column
    >
    <el-table-column label="姓名" width="120" show-overflow-tooltip>
      <template #default="{ row }">
        {{ row.name }}
        <el-tag v-if="row.is_test_student" size="small" type="warning">测试账号</el-tag>
      </template>
    </el-table-column>
    <el-table-column label="状态" width="95">
      <template #default="{ row }">
        <el-tag v-if="!row.id" :type="row.absence_graded ? 'warning' : 'info'">
          {{ row.absence_graded ? '未交·0分' : '未交' }}
        </el-tag>
        <el-tag
          v-else
          :type="row.status === 'graded' ? 'success' : row.status === 'returned' ? 'warning' : ''"
        >
          {{ { submitted: '待批改', graded: '已评分', returned: '已退回' }[row.status] }}
        </el-tag>
      </template>
    </el-table-column>
    <el-table-column v-if="assignment.work_mode === 'group'" label="实际提交人" min-width="120"
      ><template #default="{ row }"
        >{{ row.submitted_by_name || '—' }} {{ row.submitted_by_username || '' }}</template
      ></el-table-column
    >
    <el-table-column prop="submit_count" label="次数" width="60" />
    <el-table-column prop="submitted_at" label="提交时间" width="165" show-overflow-tooltip>
      <template #default="{ row }">
        <span :class="{ late: row.is_late && row.status !== 'returned' }"
          >{{ row.submitted_at || '—' }}
          {{ row.is_late && row.status !== 'returned' ? '（迟交）' : '' }}</span
        >
      </template>
    </el-table-column>
    <el-table-column label="文件" min-width="220">
      <template #default="{ row }">
        <SubmissionPreview
          v-if="row.previews?.length"
          :previews="row.previews"
          :title="`${row.name} · 作业图片`"
        />
        <template v-if="sourceFilesOf(row).length">
          <el-button
            link
            type="primary"
            class="submission-file-name"
            :title="displayFileName(row, latestFile(row))"
            @click="emit('download-file', row, latestFile(row))"
          >
            {{ displayFileName(row, latestFile(row)) || '在线作答' }}
          </el-button>
          <div v-if="sourceFilesOf(row).length > 1" class="hint">
            另有 {{ sourceFilesOf(row).length - 1 }} 份历史文件，可在评分界面查看
          </div>
        </template>
        <el-button
          v-else-if="row.content"
          link
          type="primary"
          @click="emit('workspace', row, 'view')"
        >
          查看在线答案
        </el-button>
        <span v-else class="hint">—</span>
      </template>
    </el-table-column>
    <el-table-column label="成绩" width="75">
      <template #default="{ row }">{{ row.absence_graded ? '0' : (row.score ?? '—') }}</template>
    </el-table-column>
    <el-table-column label="操作" width="125">
      <template #default="{ row }">
        <template v-if="row.id && row.status === 'submitted'">
          <el-button
            :disabled="assignment.course_status === 'archived'"
            link
            type="primary"
            @click="emit('workspace', row, 'grade')"
            >评分</el-button
          >
          <el-button
            :disabled="assignment.course_status === 'archived'"
            link
            type="warning"
            @click="emit('workspace', row, 'return')"
            >退回</el-button
          >
        </template>
        <template v-else-if="row.id && row.status === 'graded'">
          <el-button link type="primary" @click="emit('workspace', row, 'view')"
            >查看评分</el-button
          >
        </template>
        <template v-else-if="row.id && row.status === 'returned'">
          <el-button link @click="emit('workspace', row, 'view')">查看作业</el-button>
        </template>
        <span v-else class="hint">{{ row.id ? '状态未知' : '等待提交' }}</span>
      </template>
    </el-table-column>
  </el-table>
</template>
<style>
.el-table .tester-pending-row > td.el-table__cell {
  background: #fff4d8 !important;
}
</style>
<style scoped>
.submission-file-name {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
