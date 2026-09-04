<script setup>
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { newRequestId, intentSignature } from '../../composables/useUpload.js'
import api, { messageOf } from '../../api/request.js'
const status = ref('active'),
  copyDialog = ref(false),
  copyForm = ref({}),
  copyKey = ref(''),
  copySignature = ref(''),
  copyLoading = ref(false)
function openCopy(course) {
  copyForm.value = {
    source_id: course.id,
    name: course.name + '（副本）',
    code: '',
    include_materials: true,
    include_assignments: true,
  }
  copyKey.value = newRequestId()
  copyDialog.value = true
}
async function copy() {
  const signature = intentSignature(copyForm.value)
  if (copySignature.value !== signature) {
    copySignature.value = signature
    copyKey.value = newRequestId()
  }
  copyLoading.value = true
  try {
    const { data } = await api.post(
      '/courses/' + copyForm.value.source_id + '/copy',
      copyForm.value,
      { timeout: 0, headers: { 'Idempotency-Key': copyKey.value } },
    )
    copyDialog.value = false
    ElMessage.success(data.message)
    await load()
  } catch (error) {
    ElMessage.error(messageOf(error))
  } finally {
    copyLoading.value = false
  }
}
async function archive(course) {
  try {
    await ElMessageBox.confirm(
      course.status === 'active'
        ? '归档后停止提交，取消待审批延期和定时排期。确认归档？'
        : '确认恢复课程？',
      '确认',
    )
    await api.post(
      '/courses/' + course.id + (course.status === 'active' ? '/archive' : '/restore'),
    )
    await load()
  } catch (error) {
    if (error !== 'cancel') ElMessage.error(messageOf(error))
  }
}
const courses = ref([]),
  dialog = ref(false),
  loading = ref(false),
  router = useRouter(),
  form = reactive({ name: '', code: '', description: '' })
async function load() {
  try {
    courses.value = (await api.get('/courses')).data
  } catch (error) {
    ElMessage.error(messageOf(error))
  }
}
async function create() {
  if (!form.name.trim()) return ElMessage.warning('请填写课程名称')
  loading.value = true
  try {
    await api.post('/courses', form)
    ElMessage.success('课程已创建')
    dialog.value = false
    Object.assign(form, { name: '', code: '', description: '' })
    await load()
  } catch (error) {
    ElMessage.error(messageOf(error))
  } finally {
    loading.value = false
  }
}
async function remove(course, event) {
  event.stopPropagation()
  try {
    await ElMessageBox.confirm(
      `确认删除“${course.name}”？相关作业与提交记录也会删除。`,
      '删除课程',
      { type: 'warning' },
    )
    await api.delete(`/courses/${course.id}`)
    ElMessage.success('已删除')
    load()
  } catch (error) {
    if (error !== 'cancel') ElMessage.error(messageOf(error))
  }
}
onMounted(load)
</script>
<template>
  <div>
    <div class="page-head">
      <div>
        <span class="badge">教师工作台</span>
        <h1>课程管理</h1>
        <p>集中管理课程、学生名单与作业进度</p>
      </div>
      <el-button type="primary" size="large" color="#15554e" @click="dialog = true"
        >＋ 新建课程</el-button
      >
    </div>
    <el-radio-group v-model="status" style="margin-bottom: 20px"
      ><el-radio-button value="active">进行中</el-radio-button
      ><el-radio-button value="archived">已归档</el-radio-button
      ><el-radio-button value="all">全部</el-radio-button></el-radio-group
    >
    <div v-if="courses.length" class="course-grid">
      <article
        v-for="course in courses.filter((course) => status === 'all' || course.status === status)"
        :key="course.id"
        class="course-card"
        @click="router.push(`/teacher/courses/${course.id}`)"
      >
        <div style="display: flex; justify-content: space-between">
          <span class="badge">{{ course.code || '未设代码' }}</span>
          <div @click.stop>
            <el-button text @click="openCopy(course)">复制</el-button
            ><el-button text @click="archive(course)">{{
              course.status === 'active' ? '归档' : '恢复'
            }}</el-button
            ><el-button
              :disabled="course.status === 'archived'"
              text
              type="danger"
              @click="remove(course, $event)"
              >删除</el-button
            >
          </div>
        </div>
        <h3>{{ course.name }}</h3>
        <p>{{ course.description || '尚未填写课程说明' }}</p>
        <div class="meta-row">
          <span>{{ course.student_count }} 名学生</span
          ><span>{{ course.assignment_count }} 项作业</span
          ><span>
            {{ course.status === 'archived' ? '已归档' : '邀请码 ' + course.invite_code }}
          </span>
        </div>
      </article>
    </div>
    <div v-else class="panel empty">
      <h3>还没有课程</h3>
      <p>创建第一门课程，然后导入学生名单。</p>
    </div>
    <el-dialog v-model="dialog" title="新建课程" width="min(520px,92vw)"
      ><el-form label-position="top"
        ><el-form-item label="课程名称"
          ><el-input v-model="form.name" placeholder="例如：城乡规划设计（一）" /></el-form-item
        ><el-form-item label="课程代码"
          ><el-input v-model="form.code" placeholder="例如：URP301" /></el-form-item
        ><el-form-item label="课程说明"
          ><el-input v-model="form.description" type="textarea" :rows="3" /></el-form-item></el-form
      ><template #footer
        ><el-button @click="dialog = false">取消</el-button
        ><el-button type="primary" color="#15554e" :loading="loading" @click="create"
          >创建课程</el-button
        ></template
      ></el-dialog
    ><el-dialog v-model="copyDialog" title="复制课程" width="min(520px,94vw)"
      ><el-form label-position="top"
        ><el-form-item label="新课程名称"><el-input v-model="copyForm.name" /></el-form-item
        ><el-form-item label="新代码"><el-input v-model="copyForm.code" /></el-form-item
        ><el-checkbox v-model="copyForm.include_materials">复制资料（独立文件）</el-checkbox
        ><el-checkbox v-model="copyForm.include_assignments"
          >复制作业模板（草稿）</el-checkbox
        ></el-form
      >
      <p>不复制学生、分组、通知、问答、成绩和历史记录。复制可能需要一些时间。</p>
      <template #footer
        ><el-button type="primary" :loading="copyLoading" @click="copy"
          >复制 / 重试</el-button
        ></template
      ></el-dialog
    >
  </div>
</template>
