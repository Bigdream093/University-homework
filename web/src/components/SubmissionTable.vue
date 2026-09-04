<script setup>
import SubmissionRecords from './SubmissionRecords.vue'
import { rowFiles } from '../utils/submissionFiles.js'
defineProps({ rows: { type: Array, required: true }, assignment: { type: Object, required: true } })
const emit = defineEmits(['download-file', 'download', 'download-task', 'workspace', 'grade'])
</script>
<template>
  <el-table :data="rows" stripe border>
    <el-table-column
      prop="username"
      :label="assignment.work_mode === 'group' ? '小组' : '学号'"
      width="150"
    />
    <el-table-column v-if="assignment.work_mode === 'group'" label="固定成员" min-width="180"
      ><template #default="{ row }">{{
        row.members?.map((member) => member.name + '（' + member.username + '）').join('、')
      }}</template></el-table-column
    >
    <el-table-column prop="name" label="姓名" width="110" />
    <el-table-column label="状态" width="100">
      <template #default="{ row }">
        <el-tag v-if="!row.id" type="info">未交</el-tag>
        <el-tag
          v-else
          :type="row.status === 'graded' ? 'success' : row.status === 'returned' ? 'warning' : ''"
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
          <div v-for="file in rowFiles(row)" :key="file.history_id || 'latest'" class="file-cell">
            <el-button link type="primary" @click="emit('download-file', row, file)">{{
              file.file_name || '在线作答'
            }}</el-button>
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
          <el-button v-if="row.previews?.length" link type="success" @click="emit('workspace', row)"
            >看图评分</el-button
          >
          <el-button v-if="rowFiles(row).length" link @click="emit('download', row)"
            >下载</el-button
          >
          <SubmissionRecords
            :api-base="row.api_base"
            @download="(payload) => emit('download-task', payload)"
          /><el-button
            :disabled="assignment.course_status === 'archived'"
            link
            type="primary"
            @click="emit('grade', row, 'grade')"
            >评分</el-button
          >
          <el-button
            :disabled="assignment.course_status === 'archived'"
            link
            type="warning"
            @click="emit('grade', row, 'return')"
            >退回</el-button
          >
        </template>
        <span v-else class="hint">等待提交</span>
      </template>
    </el-table-column>
  </el-table>
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
