<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from './stores/user.js'
const route = useRoute(),
  router = useRouter(),
  store = useUserStore()
const menuOpen = ref(false)
const showShell = computed(
  () =>
    route.path !== '/login' &&
    !(route.path === '/help' && route.query.scope === 'login') &&
    store.user,
)
function home() {
  router.push(store.user.role === 'teacher' ? '/teacher/courses' : '/student/courses')
}
function logout() {
  store.logout()
  router.push('/login')
}
function syncClearedSession() {
  store.$patch({ token: '', user: null })
}
onMounted(() => window.addEventListener('hw-session-cleared', syncClearedSession))
onUnmounted(() => window.removeEventListener('hw-session-cleared', syncClearedSession))
</script>

<template>
  <div class="app-shell" :class="{ 'no-shell': !showShell }">
    <header v-if="showShell" class="topbar">
      <button class="brand" @click="home">
        <span class="brand-mark">墨</span
        ><span><strong>墨痕</strong><small>高校作业管理</small></span>
      </button>
      <button
        class="mobile-nav-toggle"
        type="button"
        :aria-expanded="menuOpen"
        aria-controls="main-navigation"
        @click="menuOpen = !menuOpen"
      >
        菜单
      </button>
      <nav id="main-navigation" :class="{ 'mobile-open': menuOpen }" @click="menuOpen = false">
        <button @click="home">{{ store.user.role === 'teacher' ? '课程管理' : '我的课程' }}</button
        ><button @click="router.push('/help')">帮助</button
        ><button @click="router.push('/password')">修改密码</button>
      </nav>
      <div class="user-chip">
        <span class="avatar">{{ store.user?.name?.slice(0, 1) || '?' }}</span
        ><span
          ><b>{{ store.user?.name || '用户' }}</b
          ><small>{{ store.user?.role === 'teacher' ? '教师' : store.user?.username }}</small></span
        ><button @click="logout">退出</button>
      </div>
    </header>
    <main :class="{ 'page-wrap': showShell }"><router-view /></main>
  </div>
</template>
<style>
.mobile-nav-toggle {
  display: none;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: white;
  color: var(--green);
  padding: 7px 10px;
}
@media (max-width: 800px) {
  .mobile-nav-toggle {
    display: block;
    margin-left: auto;
  }
  .topbar nav.mobile-open {
    display: flex;
    flex-direction: column;
    position: absolute;
    top: calc(100% + 4px);
    right: 16px;
    min-width: 150px;
    padding: 6px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: white;
    box-shadow: 0 8px 20px #19353212;
  }
  .topbar nav.mobile-open button {
    text-align: left;
  }
}
@media print {
  .topbar {
    display: none !important;
  }
}
</style>
