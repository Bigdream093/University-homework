<script setup>
import { reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api, { messageOf } from '../api/request.js'
const props = defineProps({
  visible: Boolean,
  courseId: { type: [String, Number], required: true },
  course: { type: Object, required: true },
  students: { type: Array, required: true },
})
const emit = defineEmits(['changed'])
const studentDialog = ref(false)
const studentForm = reactive({ username: '', name: '' })
function open() {
  studentDialog.value = true
}
defineExpose({ open })
async function addStudent() {
  try {
    await api.post(`/courses/${props.courseId}/students`, studentForm)
    studentDialog.value = false
    Object.assign(studentForm, { username: '', name: '' })
    ElMessage.success('学生已加入')
    emit('changed')
  } catch (error) {
    ElMessage.error(messageOf(error))
  }
}
async function importFile(options) {
  const formData = new FormData()
  formData.append('file', options.file)
  try {
    const { data } = await api.post(`/courses/${props.courseId}/students/import`, formData)
    ElMessage.success(
      `新增账号${data.created}人，加入课程${data.joined}人，重复${data.duplicated}人`,
    )
    options.onSuccess()
    emit('changed')
  } catch (error) {
    options.onError(error)
    ElMessage.error(messageOf(error))
  }
}
async function studentAction(student, action) {
  try {
    if (action === 'remove') {
      const { data } = await api.get(
        `/courses/${props.courseId}/students/${student.id}/removal-impact`,
      )
      const summary = `将永久删除该生在本课程中的 ${data.submissions} 份提交、${data.history} 个历史版本、${data.previews} 张照片、${data.questions} 条提问及相关活动记录。共享小组作业会保留并移除其身份。请输入学号 ${student.username} 确认。`
      await ElMessageBox.prompt(summary, '移除并清理资料', {
        type: 'warning',
        confirmButtonText: '永久删除',
        cancelButtonText: '取消',
        inputValidator: (value) => value === student.username || '输入的学号不正确',
      })
      await api.delete(`/courses/${props.courseId}/students/${student.id}`)
      ElMessage.success('学生及其课程资料已删除')
    } else if (action === 'reset') {
      await api.post(`/students/${student.id}/reset-password`)
      ElMessage.success('密码已重置为123456')
    } else
      await api.put(`/students/${student.id}/status`, {
        status: student.status === 'active' ? 'disabled' : 'active',
      })
    emit('changed')
  } catch (error) {
    if (error !== 'cancel') ElMessage.error(messageOf(error))
  }
}
</script>
<template>
  <div v-show="visible" class="panel">
    <div class="toolbar">
      <el-button :disabled="course.status === 'archived'" @click="studentDialog = true"
        >手动添加</el-button
      ><el-upload
        :show-file-list="false"
        accept=".xlsx,.xls"
        :disabled="course.status === 'archived'"
        :http-request="importFile"
        ><el-button type="primary" plain>导入Excel名单</el-button></el-upload
      ><span class="hint">A列学号，B列姓名，首行为表头</span>
    </div>
    <el-table :data="students" stripe
      ><el-table-column prop="username" label="学号" /><el-table-column
        prop="name"
        label="姓名"
      /><el-table-column prop="submission_count" label="已交作业" /><el-table-column label="状态"
        ><template #default="{ row }"
          ><el-tag :type="row.status === 'active' ? 'success' : 'info'">{{
            row.status === 'active' ? '正常' : '停用'
          }}</el-tag></template
        ></el-table-column
      ><el-table-column label="操作" width="250"
        ><template #default="{ row }"
          ><el-button
            link
            :disabled="course.status === 'archived'"
            @click="studentAction(row, 'reset')"
            >重置密码</el-button
          ><el-button
            link
            :disabled="course.status === 'archived'"
            @click="studentAction(row, 'status')"
            >{{ row.status === 'active' ? '停用' : '启用' }}</el-button
          ><el-button
            link
            type="danger"
            :disabled="course.status === 'archived'"
            @click="studentAction(row, 'remove')"
            >移除并清理</el-button
          ></template
        ></el-table-column
      ></el-table
    >
  </div>
  <el-dialog v-model="studentDialog" title="添加学生" width="min(460px,92vw)"
    ><el-form label-position="top"
      ><el-form-item label="学号"><el-input v-model="studentForm.username" /></el-form-item
      ><el-form-item label="姓名"><el-input v-model="studentForm.name" /></el-form-item></el-form
    ><template #footer
      ><el-button @click="studentDialog = false">取消</el-button
      ><el-button type="primary" color="#15554e" @click="addStudent">添加</el-button></template
    ></el-dialog
  >
</template>
