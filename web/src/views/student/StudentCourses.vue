<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useRefresh } from '../../composables/useRefresh.js'
import api, { messageOf } from '../../api/request.js'
const status = ref('active')
const courses = ref([]),
  dialog = ref(false),
  code = ref(''),
  router = useRouter()
async function load() {
  try {
    courses.value = (await api.get('/my/courses')).data
  } catch (error) {
    ElMessage.error(messageOf(error))
  }
}
async function join() {
  try {
    await api.post('/courses/join', { invite_code: code.value })
    ElMessage.success('已加入课程')
    dialog.value = false
    code.value = ''
    load()
  } catch (error) {
    ElMessage.error(messageOf(error))
  }
}
useRefresh(load)
</script>
<template>
  <div>
    <div class="page-head">
      <div>
        <span class="badge">学生空间</span>
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
    <div v-if="courses.length" class="course-grid">
      <article
        v-for="course in courses.filter((course) => status === 'all' || course.status === status)"
        :key="course.id"
        class="course-card"
        @click="router.push(`/student/courses/${course.id}`)"
      >
        <span class="badge">{{ course.status === 'archived' ? '已归档' : course.code || '课程' }}</span
        ><span
          v-if="course.unread_notice_count"
          class="badge"
          style="background: #f56c6c; color: white; margin-left: 6px"
          >{{ course.unread_notice_count }} 条未读通知</span
        >
        <h3>{{ course.name }}</h3>
        <p>{{ course.description || '点击查看课程作业' }}</p>
        <div class="meta-row">
          <span>{{ course.assignment_count }} 项进行中作业</span><span>进入课程 →</span>
        </div>
      </article>
    </div>
    <div v-else class="panel empty">
      <h3>还没有加入课程</h3>
      <p>向老师获取6位邀请码后加入。</p>
    </div>
    <el-dialog v-model="dialog" title="加入课程" width="min(420px,92vw)"
      ><el-input
        v-model="code"
        maxlength="6"
        size="large"
        placeholder="请输入6位邀请码"
        style="text-transform: uppercase"
      /><template #footer
        ><el-button @click="dialog = false">取消</el-button
        ><el-button type="primary" color="#15554e" @click="join">加入</el-button></template
      ></el-dialog
    >
  </div>
</template>
