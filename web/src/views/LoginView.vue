<script setup>
import { computed, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useUserStore } from '../stores/user.js'
import { messageOf } from '../api/request.js'

const form = reactive({ username: '', password: '' })
const loading = ref(false)
const router = useRouter()
const route = useRoute()
const store = useUserStore()
const clientRole = /KexuTeacher/i.test(navigator.userAgent)
  ? 'teacher'
  : /KexuStudent/i.test(navigator.userAgent)
    ? 'student'
    : ''
const clientName = computed(() =>
  clientRole === 'teacher' ? '教师端' : clientRole === 'student' ? '学生端' : '',
)
const accountHint = computed(() =>
  clientRole === 'teacher'
    ? '请使用教师账号登录'
    : clientRole === 'student'
      ? '请使用学生学号登录'
      : '请使用教师工号或学生学号登录',
)

async function login() {
  loading.value = true
  try {
    const user = await store.login(form)
    if (clientRole && user.role !== clientRole) {
      store.logout()
      ElMessage.error(`该账号不能登录墨痕${clientName.value}`)
      return
    }
    const requested =
      typeof route.query.redirect === 'string' &&
      route.query.redirect.startsWith('/') &&
      !route.query.redirect.startsWith('//') &&
      !route.query.redirect.startsWith('/login')
        ? route.query.redirect
        : ''
    if (user.must_change_password)
      router.push({ path: '/password', query: requested ? { redirect: requested } : {} })
    else
      router.push(requested || (user.role === 'teacher' ? '/teacher/courses' : '/student/courses'))
  } catch (error) {
    ElMessage.error(messageOf(error))
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-page">
    <section class="login-hero">
      <div class="brand">
        <span class="brand-mark" style="background: #fff; color: #15554e">墨</span
        ><span
          ><strong style="color: white">墨痕{{ clientName }}</strong
          ><small style="color: #bcd5d0">高校作业管理</small></span
        >
      </div>
      <div class="hero-copy">
        <span class="badge" style="background: #2c6c65; color: #dcece9">轻量 · 清晰 · 可归档</span>
        <h1><span>让每一次布置与提交，</span><span>都有序可循。</span></h1>
        <p>面向高校课程的轻量作业管理系统。从学生名单、作业发布到提交批改和成绩归档。</p>
      </div>
    </section>
    <section class="login-card">
      <div class="login-form">
        <h2>欢迎回来</h2>
        <p>{{ accountHint }}</p>
        <el-form label-position="top" @submit.prevent="login">
          <el-form-item label="账号"
            ><el-input
              v-model="form.username"
              size="large"
              :placeholder="
                clientRole === 'student'
                  ? '学生学号'
                  : clientRole === 'teacher'
                    ? '教师工号'
                    : '教师工号 / 学生学号'
              "
              autocomplete="username"
          /></el-form-item>
          <el-form-item label="密码"
            ><el-input
              v-model="form.password"
              size="large"
              type="password"
              show-password
              placeholder="请输入密码"
              autocomplete="current-password"
          /></el-form-item>
          <el-button
            native-type="submit"
            type="primary"
            size="large"
            :loading="loading"
            color="#15554e"
            >进入墨痕</el-button
          >
        </el-form>
        <div class="demo-box">首次运行可使用：<br />密码：123456</div>
      </div>
    </section>
  </div>
  <router-link to="/help" style="position: fixed; bottom: 20px; right: 24px; color: #15554e"
    >登录帮助</router-link
  >
</template>
