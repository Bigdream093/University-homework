<script setup>
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useRefresh } from '../../composables/useRefresh.js'
import { useCollapse } from '../../composables/useCollapse.js'
import api, { messageOf } from '../../api/request.js'
import RichTextContent from '../../components/RichTextContent.vue'
const props = defineProps({ courseId: { type: [String, Number], required: true } })
const emit = defineEmits(['read'])
const notices = ref([])
// 学生列表接口只返回 160 字摘要，展开时按需拉取完整正文。
const details = ref({})
const noticeCard = useCollapse()
let loadSequence = 0
// 序号按通知 ID 管理：只取消同一条通知的旧请求，不同通知互不影响。
const readSequences = new Map()
function nextSequence(id) {
  const value = (readSequences.get(id) || 0) + 1
  readSequences.set(id, value)
  return value
}
async function load() {
  const sequence = ++loadSequence,
    courseId = props.courseId
  try {
    const data = (await api.get(`/courses/${courseId}/notices`)).data
    if (sequence === loadSequence) notices.value = data
  } catch (error) {
    if (sequence === loadSequence) ElMessage.error(messageOf(error))
  }
}
// 点击折叠卡片展开正文；首次展开未读通知时记为已读。
async function toggle(notice) {
  const opening = !noticeCard.isOpen(notice.id)
  noticeCard.toggle(notice.id)
  if (!opening) return
  const sequence = nextSequence(notice.id)
  try {
    const detail = (await api.get(`/notices/${notice.id}`)).data
    if (sequence !== readSequences.get(notice.id)) return
    details.value = { ...details.value, [notice.id]: detail }
    if (detail.status !== 'published') return
    await api.post(`/notices/${notice.id}/read`, { revision: detail.content_revision })
    if (sequence !== readSequences.get(notice.id)) return
    await load()
    emit('read')
  } catch (error) {
    if (sequence === readSequences.get(notice.id)) ElMessage.error(messageOf(error))
  }
}
useRefresh(load)
</script>
<template>
  <div>
    <div v-if="notices.length">
      <article v-for="notice in notices" :key="notice.id" class="notice-card collapsible-card">
        <div class="card-head" @click="toggle(notice)">
          <div class="notice-badges">
            <span v-if="notice.pinned" class="badge" style="background: #e6a23c">置顶</span>
            <span v-if="notice.status === 'published' && !notice.is_read" class="badge">未读</span>
            <span v-if="notice.is_updated" class="badge" style="background: #409eff">已更新</span>
            <span
              v-if="notice.status === 'withdrawn'"
              class="badge"
              style="background: #c0c4cc; color: #fff"
              >已撤回</span
            >
          </div>
          <h3 class="card-title">{{ notice.title }}</h3>
          <span class="hint">{{
            notice.status === 'withdrawn'
              ? `撤回于 ${notice.withdrawn_at}`
              : `发布于 ${notice.published_at || notice.created_at}`
          }}</span>
          <span class="card-chevron">{{ noticeCard.isOpen(notice.id) ? '收起 ▲' : '展开 ▼' }}</span>
        </div>
        <div v-if="noticeCard.isOpen(notice.id)" class="card-body">
          <el-alert
            v-if="notice.status === 'withdrawn'"
            title="该通知已被教师撤回"
            type="warning"
            :description="`撤回时间：${notice.withdrawn_at}`"
            show-icon
            :closable="false"
            style="margin-bottom: 12px"
          />
          <RichTextContent v-else-if="details[notice.id]" :content="details[notice.id].content" />
          <p v-else class="notice-content" style="margin: 0">{{ notice.content_preview }}</p>
        </div>
      </article>
    </div>
    <div v-else class="empty">老师还没有发布通知。</div>
  </div>
</template>
<style scoped>
.notice-card {
  border: 1px solid var(--line);
  border-radius: 14px;
  margin-bottom: 12px;
  background: #fff;
  transition: box-shadow 0.2s;
}
.notice-card:hover {
  box-shadow: 0 10px 26px rgba(25, 83, 73, 0.1);
}
.notice-badges {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.notice-card h3 {
  margin: 0;
}
.notice-content {
  white-space: pre-wrap;
  line-height: 1.8;
  color: #566e69;
}
.notice-content :deep(a) {
  color: var(--green);
  text-decoration: underline;
  word-break: break-all;
}
.notice-content :deep(a:hover) {
  color: var(--green2);
}
</style>
