<script setup>
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useRefresh } from '../../composables/useRefresh.js'
import { useAsyncList } from '../../composables/useAsyncList.js'
import api, { messageOf } from '../../api/request.js'
const status = ref('active')
const dialog = ref(false),
  code = ref(''),
  router = useRouter(),
  joining = ref(false)
const {
  data: courses,
  loading,
  loaded,
  loadError,
  load,
} = useAsyncList(async (signal) => (await api.get('/my/courses', { signal })).data)
const visibleCourses = computed(() =>
  courses.value.filter((course) => status.value === 'all' || course.status === status.value),
)
function setJoinCode(value) {
  code.value = String(value || '')
    .toUpperCase()
    .replace(/\s/g, '')
    .slice(0, 6)
}
async function join() {
  if (joining.value) return
  const inviteCode = code.value.trim().toUpperCase()
  if (!/^[A-Z0-9]{6}$/.test(inviteCode)) {
    ElMessage.warning('请输入完整的6位邀请码')
    return
  }
  joining.value = true
  try {
    await api.post('/courses/join', { invite_code: inviteCode })
    ElMessage.success('已加入课程')
    dialog.value = false
    code.value = ''
    await load()
  } catch (error) {
    ElMessage.error(messageOf(error))
  } finally {
    joining.value = false
  }
}
useRefresh(load)
</script>
<template>
  <div>
    <div class="page-head">
      <div>
        <h1>我的课程</h1>
        <p>查看进行中的作业与提交记录</p>
      </div>
      <el-button type="primary" color="#15554e" @click="dialog = true">输入邀请码</el-button>
    </div>
    <el-radio-group v-model="status" style="margin-bottom: 20px"
      ><el-radio-button value="active">进行中</el-radio-button
      ><el-radio-button value="archived">已归档</el-radio-button
      ><el-radio-button value="all">全部</el-radio-button></el-radio-group
    >
    <el-alert
      v-if="loadError"
      :title="loadError"
      type="error"
      show-icon
      :closable="false"
      style="margin-bottom: 14px"
      ><el-button size="small" @click="load">重试</el-button></el-alert
    >
    <div v-if="visibleCourses.length" class="course-grid">
      <article
        v-for="course in visibleCourses"
        :key="course.id"
        class="course-card student-course-card"
        @click="router.push(`/student/courses/${course.id}`)"
      >
        <span class="badge">{{
          course.status === 'archived' ? '已归档' : course.code || '课程'
        }}</span
        ><span
          v-if="course.unread_notice_count"
          class="badge"
          style="background: #f56c6c; color: white; margin-left: 6px"
          >{{ course.unread_notice_count }} 条未读通知</span
        >
        <h3>{{ course.name }}</h3>
        <p>{{ course.description || '点击查看课程作业' }}</p>
        <div class="meta-row student-course-meta">
          <span>{{ course.assignment_count }} 项进行中作业</span><span>进入课程 →</span>
        </div>
      </article>
    </div>
    <div v-else-if="loading && !loaded" class="panel empty">正在加载课程…</div>
    <div v-else-if="loaded && courses.length && !visibleCourses.length" class="panel empty">
      当前筛选下没有课程。
    </div>
    <div v-else-if="loaded && !courses.length" class="panel empty">
      <h3>还没有加入课程</h3>
      <p>向老师获取6位邀请码后加入。</p>
    </div>
    <el-dialog v-model="dialog" title="加入课程" width="min(420px,92vw)"
      ><el-input
        :model-value="code"
        @update:model-value="setJoinCode"
        maxlength="6"
        size="large"
        placeholder="请输入6位邀请码"
        style="text-transform: uppercase"
      /><template #footer
        ><el-button @click="dialog = false">取消</el-button
        ><el-button
          type="primary"
          color="#15554e"
          :loading="joining"
          :disabled="code.length !== 6"
          @click="join"
          >加入</el-button
        ></template
      ></el-dialog
    >
  </div>
</template>
