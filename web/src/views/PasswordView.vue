<script setup>
import { reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import api, { messageOf } from '../api/request.js'
import { useUserStore } from '../stores/user.js'
const form = reactive({ oldPassword: '', newPassword: '', confirm: '' }),
  loading = ref(false),
  route = useRoute(),
  router = useRouter(),
  store = useUserStore()
async function save() {
  if (form.newPassword !== form.confirm) return ElMessage.warning('两次输入的新密码不一致')
  loading.value = true
  try {
    await api.put('/auth/password', form)
    const rememberPreference = sessionStorage.getItem('hw_remember_password_after_change')
    sessionStorage.removeItem('hw_remember_password_after_change')
    if (window.kexuDesktop?.saveCredentials && store.user?.username) {
      try {
        let rememberAfterChange = rememberPreference === '1'
        if (rememberPreference === null && window.kexuDesktop.getSavedCredentials) {
          const saved = await window.kexuDesktop.getSavedCredentials()
          rememberAfterChange =
            !!saved.credentials &&
            saved.credentials.username?.trim().toLowerCase() ===
              store.user.username.trim().toLowerCase()
        }
        if (rememberAfterChange)
          await window.kexuDesktop.saveCredentials({
            username: store.user.username,
            password: form.newPassword,
            remember: true,
          })
        else await window.kexuDesktop.clearCredentials()
      } catch {
        // 密码修改成功不依赖本地密码存储。
      }
    }
    ElMessage.success('密码已修改，请重新登录')
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : ''
    store.logout()
    router.push({ path: '/login', query: redirect ? { redirect } : {} })
  } catch (error) {
    ElMessage.error(messageOf(error))
  } finally {
    loading.value = false
  }
}
</script>
<template>
  <div>
    <div class="page-head">
      <div>
        <h1>修改密码</h1>
        <p>建议使用至少8位且不易猜测的密码</p>
      </div>
    </div>
    <div class="panel" style="max-width: 520px">
      <el-form label-position="top"
        ><el-form-item label="原密码"
          ><el-input
            v-model="form.oldPassword"
            type="password"
            show-password
            autocomplete="current-password" /></el-form-item
        ><el-form-item label="新密码"
          ><el-input
            v-model="form.newPassword"
            type="password"
            show-password
            autocomplete="new-password" /></el-form-item
        ><el-form-item label="确认新密码"
          ><el-input
            v-model="form.confirm"
            type="password"
            show-password
            autocomplete="new-password" /></el-form-item
        ><el-button type="primary" color="#15554e" :loading="loading" @click="save"
          >保存新密码</el-button
        ></el-form
      >
    </div>
  </div>
</template>
