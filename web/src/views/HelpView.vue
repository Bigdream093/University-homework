<script setup>
import { onMounted, ref, computed, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import api, { messageOf } from '../api/request.js'
import { readUser } from '../utils/session.js'
import { downloadBlob } from '../utils/files.js'
const desktop = Boolean(window.mohenDesktop)
const items = ref([]),
  keyword = ref(''),
  route = useRoute(),
  user = readUser()
const visible = computed(() =>
  items.value.filter((item) => (item.title + ' ' + item.body).includes(keyword.value)),
)
async function download() {
  try {
    const { data } = await api.get('/help/download', { responseType: 'blob' })
    downloadBlob(data, '墨痕-' + user.role + '-使用手册.md')
  } catch (error) {
    ElMessage.error(messageOf(error))
  }
}
function print() {
  window.print()
}
onMounted(async () => {
  try {
    items.value = (await api.get(user ? '/help' : '/help/public')).data
    await nextTick()
    if (route.hash) document.getElementById(route.hash.slice(1))?.scrollIntoView()
  } catch (error) {
    ElMessage.error(messageOf(error))
  }
})
</script>
<template>
  <div class="help-page">
    <div class="page-head">
      <div>
        <el-button @click="$router.back()">返回上一页</el-button>
        <h1>墨痕使用说明书</h1>
        <p>
          1.6.5 测试加固版 ·
          {{ user?.role === 'teacher' ? '教师手册' : user ? '学生手册' : '登录帮助' }}
        </p>
      </div>
      <div class="help-actions">
        <el-button v-if="user" @click="download">下载完整手册</el-button
        ><el-button v-if="!desktop" @click="print">打印 / 保存PDF</el-button
        ><span v-else class="hint">桌面端请下载手册；打印请在浏览器打开同一网站。</span
        ><router-link v-if="!user" to="/login">返回登录</router-link>
      </div>
    </div>
    <el-input
      v-model="keyword"
      placeholder="搜索全文：回执、延期、分组、NAS、重试"
      class="help-search"
    />
    <nav class="help-index">
      <a v-for="item in visible" :key="item.id" :href="'#' + item.id">{{ item.title }}</a>
    </nav>
    <article v-for="item in visible" :id="item.id" :key="item.id" class="panel help-chapter">
      <h2>{{ item.title }}</h2>
      <pre>{{ item.body }}</pre>
    </article>
    <p v-if="!visible.length">没有找到匹配章节。</p>
  </div>
</template>
<style scoped>
.help-search {
  max-width: 600px;
  margin-bottom: 20px;
}
.help-index {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}
.help-chapter {
  margin-bottom: 20px;
  scroll-margin-top: 30px;
}
.help-chapter pre {
  font: inherit;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.9;
}
.help-page {
  max-width: 1100px;
  margin: auto;
  padding: 20px;
}
@media print {
  .help-search,
  .help-actions,
  .help-index {
    display: none;
  }
  .help-chapter {
    break-inside: auto;
    box-shadow: none;
    border: 0;
  }
}
</style>
