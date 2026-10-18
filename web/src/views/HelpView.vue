<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api, { messageOf } from '../api/request.js'
import { useUserStore } from '../stores/user.js'
const route = useRoute()
const router = useRouter()
const store = useUserStore()
const user = computed(() => (route.query.scope === 'login' ? null : store.user))
const desktopRole = /KexuTeacher/i.test(navigator.userAgent)
  ? 'teacher'
  : /KexuStudent/i.test(navigator.userAgent)
    ? 'student'
    : ''
const selectedRole = ref(route.query.role === 'teacher' ? 'teacher' : 'student')
const role = computed(() => user.value?.role || desktopRole || selectedRole.value)
const teacherManual = computed(() => role.value === 'teacher')
let loadSequence = 0
function selectRole(value) {
  router.replace({ query: { ...route.query, role: value }, hash: '' })
}
const items = ref([])
const activeId = ref('')
const loading = ref(true)
const error = ref('')
const activeChapter = computed(
  () => items.value.find((item) => item.id === activeId.value) || items.value[0],
)
const blocks = computed(() => {
  const body = (activeChapter.value?.body || '').replace(/^# [^\n]+\r?\n+/, '').trim()
  return body
    .split(/\r?\n\s*\r?\n/)
    .filter(Boolean)
    .map((text) => {
      if (/^### /.test(text)) return { type: 'heading', text: text.slice(4) }
      const lines = text.split(/\r?\n/)
      if (lines.every((line) => /^\d+\. /.test(line)))
        return { type: 'list', items: lines.map((line) => line.replace(/^\d+\. /, '')) }
      return { type: 'paragraph', text }
    })
})
function textParts(text) {
  return text
    .split(/(`[^`]+`)/)
    .filter(Boolean)
    .map((part) => ({
      code: part.startsWith('`') && part.endsWith('`'),
      text: part.startsWith('`') && part.endsWith('`') ? part.slice(1, -1) : part,
    }))
}
function selectFromHash() {
  const id = route.hash.slice(1)
  activeId.value =
    items.value.find((item) => item.id === id || item.aliases?.includes(id))?.id ||
    items.value[0]?.id ||
    ''
}
function selectChapter(id) {
  activeId.value = id
  router.replace({ hash: '#' + id })
}
async function load() {
  const sequence = ++loadSequence
  loading.value = true
  error.value = ''
  try {
    const { data } = await api.get(user.value ? '/help' : '/help/public', {
      params: user.value ? {} : { role: role.value },
    })
    if (sequence !== loadSequence) return
    if (!Array.isArray(data)) throw new Error('帮助接口返回格式异常，请更新服务器后重试')
    items.value = user.value
      ? data
      : data.filter(
          (chapter) =>
            chapter.id === role.value + '-login' ||
            (role.value === 'student' && chapter.id === 'student-course'),
        )
    if (!items.value.length) throw new Error('服务器尚未提供对应身份的登录帮助，请更新服务器后重试')
    selectFromHash()
  } catch (cause) {
    if (sequence === loadSequence) error.value = messageOf(cause)
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}
watch(() => route.hash, selectFromHash)
watch(
  () => [route.query.role, user.value],
  ([value]) => {
    selectedRole.value = value === 'teacher' ? 'teacher' : 'student'
    load()
  },
)
onMounted(load)
</script>
<template>
  <div class="help-page" :class="{ 'login-help-page': !user }">
    <header class="help-header">
      <div>
        <h1>
          {{ !user ? '登录帮助' : teacherManual ? '墨痕教师端使用说明书' : '墨痕学生端使用说明书' }}
        </h1>
        <p v-if="!user" class="help-role">{{ teacherManual ? '教师端' : '学生端' }}</p>
      </div>
      <el-button v-if="!user" @click="$router.push('/login')">返回登录</el-button>
    </header>
    <el-radio-group
      v-if="!user && !desktopRole"
      class="help-role-switch"
      :model-value="selectedRole"
      aria-label="登录帮助身份"
      @update:model-value="selectRole"
    >
      <el-radio-button value="student">学生端</el-radio-button>
      <el-radio-button value="teacher">教师端</el-radio-button>
    </el-radio-group>
    <div v-if="loading" class="help-state" role="status">正在加载说明书…</div>
    <div v-else-if="error" class="help-state" role="alert">
      <p>{{ error }}</p>
      <el-button @click="load">重试</el-button>
    </div>
    <div v-else-if="activeChapter" class="help-layout" :class="{ 'login-help-layout': !user }">
      <nav v-if="user" class="help-nav" aria-label="说明书章节">
        <a
          v-for="item in items"
          :key="item.id"
          :href="'#' + item.id"
          :aria-current="activeChapter.id === item.id ? 'location' : undefined"
          :aria-controls="activeChapter.id === item.id ? item.id : undefined"
          @click.prevent="selectChapter(item.id)"
        >
          <span>{{ item.nav_title || item.title.replace(/^(学生|教师)：/, '') }}</span>
        </a>
      </nav>
      <article :id="activeChapter.id" class="help-chapter" aria-live="polite">
        <h2>{{ activeChapter.title }}</h2>
        <div
          v-if="
            activeChapter.format === 'student-manual' || activeChapter.format === 'teacher-manual'
          "
          class="help-copy"
        >
          <template v-for="(block, index) in blocks" :key="index">
            <h3 v-if="block.type === 'heading'">{{ block.text }}</h3>
            <ol v-else-if="block.type === 'list'">
              <li v-for="(text, line) in block.items" :key="line">
                <component
                  :is="part.code ? 'code' : 'span'"
                  v-for="(part, position) in textParts(text)"
                  :key="position"
                  >{{ part.text }}</component
                >
              </li>
            </ol>
            <p v-else>
              <component
                :is="part.code ? 'code' : 'span'"
                v-for="(part, position) in textParts(block.text)"
                :key="position"
                >{{ part.text }}</component
              >
            </p>
          </template>
        </div>
        <pre v-else>{{ activeChapter.body }}</pre>
      </article>
    </div>
  </div>
</template>
<style scoped>
.help-page {
  max-width: 1200px;
  margin: 0 auto;
  padding: 12px 0 24px;
}
.login-help-page {
  max-width: 900px;
  padding: 48px 24px 28px;
}
.help-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin-bottom: 24px;
}
.help-header h1 {
  margin: 0;
  color: var(--ink);
  font-family: 'Noto Serif SC', 'Songti SC', serif;
  font-size: clamp(25px, 2.5vw, 32px);
  line-height: 1.4;
}
.help-header > .el-button {
  flex: none;
}
.help-role {
  margin: 8px 0 0;
  color: #70847b;
  font-size: 14px;
}
.help-role-switch {
  margin-bottom: 20px;
}
.help-layout {
  display: grid;
  grid-template-columns: 184px minmax(0, 1fr);
  align-items: start;
  gap: 24px;
}
.help-layout.login-help-layout {
  grid-template-columns: minmax(0, 1fr);
}
.help-nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  position: sticky;
  top: 94px;
}
.help-nav a {
  display: flex;
  align-items: center;
  min-height: 44px;
  padding: 10px 14px;
  border-left: 3px solid transparent;
  border-radius: 0 5px 5px 0;
  color: #526b64;
  font-size: 14px;
  line-height: 1.5;
  text-decoration: none;
}
.help-nav a:hover {
  background: #f0f5f2;
}
.help-nav a[aria-current='location'] {
  border-left-color: var(--green);
  background: #e8f1ec;
  color: var(--green);
  font-weight: 600;
}
.help-nav a:focus-visible {
  outline: 2px solid #84b9ad;
  outline-offset: 2px;
}
.help-chapter {
  min-width: 0;
  padding: 24px 28px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: #fff;
}
.help-chapter h2 {
  margin: 0 0 20px;
  color: var(--ink);
  font-size: 21px;
  line-height: 1.5;
}
.help-chapter pre {
  margin: 0;
  font: inherit;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.9;
}
.help-copy {
  color: #344c45;
  font-size: 15px;
  line-height: 1.85;
  overflow-wrap: anywhere;
}
.help-copy h3 {
  margin: 24px 0 12px;
  font-size: 17px;
  color: var(--ink);
}
.help-copy > :first-child {
  margin-top: 0;
}
.help-copy > :last-child {
  margin-bottom: 0;
}
.help-copy ol {
  margin: 0 0 18px;
  padding-left: 24px;
}
.help-copy li {
  padding-left: 4px;
  margin-bottom: 12px;
}
.help-copy li:last-child {
  margin-bottom: 0;
}
.help-copy li::marker {
  color: #7c9389;
}
.help-copy p {
  margin: 16px 0;
}
.help-copy code {
  padding: 2px 6px;
  border-radius: 4px;
  background: #edf3ef;
  font: inherit;
  font-variant-numeric: tabular-nums;
}
.help-state {
  padding: 24px;
  color: #6d817b;
}
@media (max-width: 800px) {
  .help-page {
    padding: 8px 0 20px;
  }
  .login-help-page {
    padding: 32px 16px 20px;
  }
  .help-header {
    gap: 12px;
    margin-bottom: 20px;
  }
  .help-layout {
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
  }
  .help-nav {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    position: static;
    gap: 4px;
  }
  .help-nav a {
    padding: 8px 10px;
    font-size: 13px;
  }
  .help-chapter {
    padding: 20px 16px;
  }
  .help-chapter h2 {
    font-size: 19px;
  }
}
</style>
