<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useUserStore } from '../stores/user.js'
import { messageOf } from '../api/request.js'

const form = reactive({ username: '', password: '' })
const loading = ref(false)
const rememberPassword = ref(true)
const savedCredentialAvailable = ref(false)
const savedCredentialUsername = ref('')
const credentialStorageAvailable = ref(false)
const router = useRouter()
const route = useRoute()
const store = useUserStore()
const clientRole = /KexuTeacher/i.test(navigator.userAgent)
  ? 'teacher'
  : /KexuStudent/i.test(navigator.userAgent)
    ? 'student'
    : ''
const desktopCredentialSupported = Boolean(
  clientRole && window.kexuDesktop?.getSavedCredentials && window.kexuDesktop?.saveCredentials,
)
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

onMounted(async () => {
  if (!desktopCredentialSupported) return
  try {
    const result = await window.kexuDesktop.getSavedCredentials()
    credentialStorageAvailable.value = !!result.available
    if (result.available && result.credentials) {
      form.username = result.credentials.username || ''
      form.password = result.credentials.password || ''
      savedCredentialUsername.value = result.credentials.username || ''
      rememberPassword.value = true
      savedCredentialAvailable.value = true
    }
  } catch {
    // 密码记忆不可用时仍可手动登录。
  }
})

async function clearSavedCredentials() {
  if (!desktopCredentialSupported) return
  try {
    await window.kexuDesktop.clearCredentials()
    savedCredentialAvailable.value = false
    savedCredentialUsername.value = ''
    rememberPassword.value = false
    form.password = ''
    ElMessage.success('已清除保存的密码')
  } catch {
    ElMessage.warning('清除保存的密码失败，请重试')
  }
}

async function toggleRememberPassword() {
  if (!rememberPassword.value && savedCredentialAvailable.value) {
    try {
      await window.kexuDesktop.clearCredentials()
      savedCredentialAvailable.value = false
      savedCredentialUsername.value = ''
    } catch {
      ElMessage.warning('清除保存的密码失败，请重试')
    }
  }
}

async function persistCredentials(user) {
  if (!desktopCredentialSupported || !credentialStorageAvailable.value) return
  try {
    if (user.must_change_password) {
      sessionStorage.setItem(
        'hw_remember_password_after_change',
        rememberPassword.value ? '1' : '0',
      )
      await window.kexuDesktop.clearCredentials()
      savedCredentialAvailable.value = false
      savedCredentialUsername.value = ''
      return
    }
    if (rememberPassword.value) {
      await window.kexuDesktop.saveCredentials({
        username: user.username,
        password: form.password,
        remember: true,
      })
      savedCredentialAvailable.value = true
      savedCredentialUsername.value = user.username
    } else {
      await window.kexuDesktop.clearCredentials()
      savedCredentialAvailable.value = false
      savedCredentialUsername.value = ''
    }
  } catch {
    ElMessage.warning('登录成功，但保存密码失败')
  }
}

async function login() {
  loading.value = true
  try {
    const user = await store.login({ username: form.username, password: form.password })
    if (clientRole && user.role !== clientRole) {
      store.logout()
      ElMessage.error(`该账号不能登录墨痕${clientName.value}`)
      return
    }
    await persistCredentials(user)
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
    if (
      savedCredentialAvailable.value &&
      error?.response?.status === 401 &&
      savedCredentialUsername.value.trim().toLowerCase() === form.username.trim().toLowerCase()
    ) {
      try {
        await window.kexuDesktop.clearCredentials()
        savedCredentialAvailable.value = false
        savedCredentialUsername.value = ''
        form.password = ''
      } catch {
        // Keep the login error visible even if a stale credential cannot be removed.
      }
    }
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
          ><strong style="color: white">墨痕{{ clientName ? ' · ' + clientName : '' }}</strong
          ><small style="color: #bcd5d0">高校课程作业管理</small></span
        >
      </div>
      <div class="hero-copy">
        <span class="badge" style="background: #2c6c65; color: #dcece9"
          >布置有序 · 批改清晰 · 成绩可查</span
        >
        <h1><span>从布置到评分，</span><span>管好每次作业</span></h1>
        <p>
          作业发布、提交与批改集中管理，<br />
          课程成绩统一归档，让日常教学更有条理。
        </p>
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
          <div
            v-if="desktopCredentialSupported && credentialStorageAvailable"
            class="credential-controls"
          >
            <el-checkbox v-model="rememberPassword" @change="toggleRememberPassword">
              记住账号和密码
            </el-checkbox>
            <el-button
              v-if="savedCredentialAvailable"
              class="credential-clear-button"
              plain
              size="small"
              @click="clearSavedCredentials"
              >清除已保存密码</el-button
            >
          </div>
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
    <router-link
      :to="{
        path: '/help',
        query: { scope: 'login', ...(clientRole ? { role: clientRole } : {}) },
      }"
      class="login-help-button"
      >登录帮助</router-link
    >
  </div>
</template>

<style scoped>
.login-help-button {
  display: inline-flex;
  position: fixed;
  right: 22px;
  bottom: 22px;
  z-index: 5;
  min-height: 40px;
  align-items: center;
  justify-content: center;
  padding: 0 14px;
  border: 1px solid #d5e0da;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.92);
  color: var(--green);
  font-size: inherit;
  line-height: 1;
  text-decoration: none;
  transition:
    background-color 0.18s ease,
    border-color 0.18s ease,
    box-shadow 0.18s ease;
}

.login-help-button:hover {
  border-color: #a9c7be;
  background: #f2f8f5;
}

.login-help-button:focus-visible {
  outline: 2px solid #84b9ad;
  outline-offset: 2px;
}

.login-hero .brand,
.login-hero .hero-copy {
  position: relative;
  z-index: 1;
}

.login-hero .hero-copy {
  margin: auto 0;
}

.login-hero .hero-copy .badge {
  margin-bottom: 30px;
}

.login-hero h1 {
  font-size: clamp(40px, 3.2vw, 52px);
  line-height: 1.18;
  letter-spacing: -1.5px;
  margin-bottom: 28px;
}

.login-hero .hero-copy p {
  margin: 0;
}

.login-hero h1 span {
  display: block;
  white-space: nowrap;
}

.credential-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 38px;
  padding: 0;
  flex-wrap: wrap;
  margin: 2px 0 18px;
  background: transparent;
  border: 0;
}

.credential-controls .el-checkbox {
  flex: 1;
  min-width: 0;
  margin: 0;
}

.credential-controls :deep(.el-checkbox__label) {
  padding-left: 8px;
  color: #526a65;
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
}

.credential-controls :deep(.el-checkbox__input.is-checked .el-checkbox__inner) {
  background-color: var(--green);
  border-color: var(--green);
}

.credential-controls :deep(.el-checkbox__input.is-checked + .el-checkbox__label) {
  color: var(--ink);
}

.credential-controls :deep(.credential-clear-button.el-button) {
  flex: none;
  width: auto;
  margin: 0;
  padding: 0 10px;
  color: #647a74;
  background: #fff;
  border-color: #dbe6e1;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}

.credential-controls :deep(.credential-clear-button.el-button:hover) {
  color: var(--green);
  background: #f2f8f5;
  border-color: #a9c7be;
}

.credential-controls :deep(.credential-clear-button.el-button:focus-visible) {
  outline: 2px solid #84b9ad;
  outline-offset: 2px;
}

@media (max-width: 420px) {
  .credential-controls {
    gap: 6px;
    padding: 0;
  }

  .credential-controls :deep(.el-checkbox__label) {
    padding-left: 6px;
    font-size: 12px;
  }

  .credential-controls :deep(.credential-clear-button.el-button) {
    padding: 0 7px;
  }
}

@media (max-width: 800px) {
  .login-hero h1 {
    font-size: clamp(30px, 9vw, 40px);
  }

  .login-hero h1 span {
    white-space: normal;
  }
}
</style>
