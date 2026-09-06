<script setup>
import RichTextContent from './RichTextContent.vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api, { messageOf } from '../api/request.js'
import AssignmentGroups from './AssignmentGroups.vue'
import { useCollapse } from '../composables/useCollapse.js'
defineProps({
  assignments: { type: Array, required: true },
  course: { type: Object, required: true },
})
const emit = defineEmits(['edit', 'changed'])
const router = useRouter()
const assignmentCard = useCollapse()
function formatExtensions(value) {
  return String(value || '')
    .split(',')
    .filter(Boolean)
    .map((extension) => '.' + extension)
    .join('、')
}
async function assignmentAction(assignment, action) {
  try {
    if (action === 'delete') {
      await ElMessageBox.confirm('确认删除这项作业？', '确认', { type: 'warning' })
      await api.delete(`/assignments/${assignment.id}`)
    } else await api.post(`/assignments/${assignment.id}/${action}`)
    ElMessage.success(action === 'publish' ? '作业已发布' : '作业已关闭')
    emit('changed')
  } catch (error) {
    if (error !== 'cancel') ElMessage.error(messageOf(error))
  }
}
async function moveAssignment(assignment, direction) {
  try {
    await api.post(`/assignments/${assignment.id}/move`, { direction })
    emit('changed')
  } catch (error) {
    ElMessage.error(messageOf(error))
  }
}
</script>
<template>
  <div class="panel">
    <div v-if="assignments.length">
      <article
        v-for="(assignment, index) in assignments"
        :key="assignment.id"
        class="assignment-card collapsible-card"
      >
        <div class="card-head" @click="assignmentCard.toggle(assignment.id)">
          <span class="badge">{{
            { draft: '草稿', published: '已发布', closed: '已关闭' }[assignment.status]
          }}</span
          ><span v-if="assignment.status !== 'draft'" class="badge"
            >{{ assignment.unsubmitted_count }}/{{ assignment.expected_count }} 未交</span
          ><span v-if="assignment.status !== 'draft'" class="badge"
            >{{ assignment.pending_review_count }}/{{ assignment.expected_count }} 待批改</span
          >
          <h3 class="card-title">{{ assignment.title }}</h3>
          <span class="hint">截止：{{ assignment.deadline || '不限' }}</span
          ><el-button-group @click.stop
            ><el-button
              size="small"
              :disabled="course.status === 'archived' || index === 0"
              @click="moveAssignment(assignment, 'up')"
              >上移</el-button
            ><el-button
              size="small"
              :disabled="course.status === 'archived' || index === assignments.length - 1"
              @click="moveAssignment(assignment, 'down')"
              >下移</el-button
            ></el-button-group
          ><el-button
            size="small"
            type="primary"
            color="#15554e"
            @click.stop="router.push(`/teacher/assignments/${assignment.id}`)"
            >查看提交</el-button
          ><span class="card-chevron">{{
            assignmentCard.isOpen(assignment.id) ? '收起 ▲' : '展开 ▼'
          }}</span>
        </div>
        <div v-if="assignmentCard.isOpen(assignment.id)" class="card-body">
          <RichTextContent :content="assignment.description || '暂无作业说明'" />
          <span class="hint" style="display: block; margin-bottom: 12px"
            >{{ assignment.work_mode === 'group' ? '分组作业' : '个人作业' }} · 满分{{
              assignment.total_score
            }}
            · 可重交{{
              assignment.allow_resubmit_count === -1
                ? '不限'
                : assignment.allow_resubmit_count + '次'
            }}
            · {{ assignment.submission_mode === 'append' ? '追加模式' : '覆盖模式'
            }}<template v-if="assignment.type !== 'online'">
              · 单文件≤{{
                assignment.max_file_mb >= 1024 ? '1G' : assignment.max_file_mb + 'M'
              }}</template
            ><template v-if="assignment.allowed_extensions">
              · 限交后缀：{{ formatExtensions(assignment.allowed_extensions) }}</template
            ><template v-if="Number(assignment.require_preview_image) === 1">
              · 需交预览图 1-{{ assignment.preview_max_count }} 张（jpg/png）</template
            ></span
          >
          <div class="assignment-actions">
            <AssignmentGroups
              v-if="assignment.work_mode === 'group'"
              :assignment="assignment"
              :readonly="course.status === 'archived'"
            /><el-button :disabled="course.status === 'archived'" @click="emit('edit', assignment)"
              >编辑</el-button
            ><el-button
              v-if="assignment.status === 'draft'"
              type="success"
              :disabled="course.status === 'archived'"
              @click="assignmentAction(assignment, 'publish')"
              >发布</el-button
            ><el-button
              v-if="assignment.status === 'published'"
              type="warning"
              :disabled="course.status === 'archived'"
              @click="assignmentAction(assignment, 'close')"
              >关闭</el-button
            ><el-button
              v-if="assignment.status === 'closed'"
              type="success"
              :disabled="course.status === 'archived'"
              @click="assignmentAction(assignment, 'publish')"
              >重新发布</el-button
            ><el-button
              type="primary"
              color="#15554e"
              @click="router.push(`/teacher/assignments/${assignment.id}`)"
              >查看提交</el-button
            ><el-button
              type="danger"
              text
              :disabled="course.status === 'archived'"
              @click="assignmentAction(assignment, 'delete')"
              >删除</el-button
            >
          </div>
        </div>
      </article>
    </div>
    <div v-else class="empty">还没有作业，创建后可发布给学生。</div>
  </div>
</template>
