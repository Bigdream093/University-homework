<script setup>
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useUserStore } from './stores/user.js';
const route = useRoute(), router = useRouter(), store = useUserStore();
const showShell = computed(() => route.path !== '/login' && store.user);
function home() { router.push(store.user.role === 'teacher' ? '/teacher/courses' : '/student/courses'); }
function logout() { store.logout(); router.push('/login'); }
</script>

<template>
  <div class="app-shell" :class="{ 'no-shell': !showShell }">
    <header v-if="showShell" class="topbar">
      <button class="brand" @click="home"><span class="brand-mark">墨</span><span><strong>墨痕</strong><small>高校作业管理</small></span></button>
      <nav><button @click="home">{{ store.user.role === 'teacher' ? '课程管理' : '我的课程' }}</button><button @click="router.push('/password')">修改密码</button></nav>
      <div class="user-chip"><span class="avatar">{{ store.user.name.slice(0,1) }}</span><span><b>{{ store.user.name }}</b><small>{{ store.user.role === 'teacher' ? '教师' : store.user.username }}</small></span><button @click="logout">退出</button></div>
    </header>
    <main :class="{ 'page-wrap': showShell }"><router-view /></main>
  </div>
</template>
