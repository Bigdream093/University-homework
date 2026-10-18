<script setup>
import RichTextEditor from './RichTextEditor.vue'
import RichTextContent from './RichTextContent.vue'
import { contentSummary, editableRichText } from '../utils/richText.js'
import { computed, onUnmounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useUserStore } from '../stores/user.js'
import { useRefresh } from '../composables/useRefresh.js'
import { useAsyncList } from '../composables/useAsyncList.js'
import { useCollapse } from '../composables/useCollapse.js'
import api, { messageOf } from '../api/request.js'
import { readUser } from '../utils/session.js'
const props = defineProps({ courseId: [String, Number], readonly: Boolean })
const isDialogDismissal = (error) =>
  ['cancel', 'close'].includes(error) || ['cancel', 'close'].includes(error?.message)
const userStore = useUserStore()
const teacher = computed(() => userStore.user?.role === 'teacher'),
  tab = ref('private'),
  keyword = ref(''),
  filter = ref(''),
  page = ref(1),
  detail = ref(null),
  dialog = ref(false),
  compose = ref(false),
  editId = ref(null),
  title = ref(''),
  content = ref(''),
  reply = ref(''),
  publication = ref(false),
  summary = ref(''),
  publicReply = ref('')
const composeBusy = ref(false),
  replyBusy = ref(false),
  summaryBusy = ref(false),
  publicReplyBusy = ref(false)
const anyImageBusy = computed(
  () => composeBusy.value || replyBusy.value || summaryBusy.value || publicReplyBusy.value,
)
const publicCard = useCollapse()
const {
  data: rows,
  loading,
  loaded,
  loadError,
  load,
} = useAsyncList(
  async (signal) =>
    (
      await api.get(
        '/courses/' + props.courseId + '/questions' + (tab.value === 'public' ? '/public' : ''),
        {
          params: { keyword: keyword.value, status: filter.value, page: page.value, limit: 20 },
          signal,
        },
      )
    ).data,
)
const savingQuestion = ref(false)
const sendingReply = ref(false)
const replyDraftId = ref('')
const hasPublished = computed(
  () => !!detail.value?.publications.some((publication) => publication.status === 'published'),
)
// 教师删除公开摘要不留记录行，仅以可见性事件留痕；学生端据此显示提示。
const pubDeleted = computed(
  () => !!detail.value?.visibility_events.some((event) => event.event === 'delete_publication'),
)
let composeDraftTimer,
  replyDraftTimer,
  skipComposeCloseDraft = false
function draftKey(kind, id = 'new') {
  return `course-question-draft:${readUser()?.id || 'guest'}:${props.courseId}:${kind}:${id}`
}
function readDraft(kind, id) {
  try {
    return JSON.parse(sessionStorage.getItem(draftKey(kind, id)) || 'null')
  } catch {
    return null
  }
}
function saveDraft(kind, id, value) {
  try {
    const key = draftKey(kind, id)
    if (value && Object.values(value).some((item) => String(item || '').trim()))
      sessionStorage.setItem(key, JSON.stringify(value))
    else sessionStorage.removeItem(key)
  } catch {}
}
async function open(row) {
  try {
    detail.value = (await api.get('/questions/' + row.id)).data
    replyDraftId.value = String(row.id)
    reply.value = teacher.value ? '' : readDraft('reply', replyDraftId.value)?.content || ''
    dialog.value = true
  } catch (error) {
    ElMessage.error(messageOf(error))
  }
}
function openFromPublic(row) {
  open({ id: row.question_id })
}
function newQuestion(row = null) {
  editId.value = row?.id || null
  const saved = readDraft('compose', editId.value || 'new')
  title.value = saved?.title ?? row?.title ?? ''
  content.value = saved?.content ?? editableRichText(row?.content, row?.content_format)
  compose.value = true
}
watch([title, content], () => {
  if (!compose.value || teacher.value) return
  clearTimeout(composeDraftTimer)
  const id = editId.value || 'new',
    value = { title: title.value, content: content.value }
  composeDraftTimer = window.setTimeout(() => saveDraft('compose', id, value), 350)
})
watch(
  compose,
  (opened) => {
    if (opened || teacher.value) return
    clearTimeout(composeDraftTimer)
    if (skipComposeCloseDraft) {
      skipComposeCloseDraft = false
      return
    }
    saveDraft('compose', editId.value || 'new', { title: title.value, content: content.value })
  },
  { flush: 'sync' },
)
watch(reply, () => {
  if (!dialog.value || teacher.value || !replyDraftId.value) return
  clearTimeout(replyDraftTimer)
  const id = replyDraftId.value,
    value = { content: reply.value }
  replyDraftTimer = window.setTimeout(() => saveDraft('reply', id, value), 350)
})
watch(
  dialog,
  (opened) => {
    if (opened || teacher.value || !replyDraftId.value) return
    clearTimeout(replyDraftTimer)
    saveDraft('reply', replyDraftId.value, { content: reply.value })
  },
  { flush: 'sync' },
)
async function save() {
  if (savingQuestion.value) return
  if (composeBusy.value) return ElMessage.warning('请先完成图片上传')
  savingQuestion.value = true
  const savedId = editId.value
  try {
    const body = { title: title.value, content: content.value, content_format: 'html' }
    if (editId.value) await api.put('/questions/' + editId.value, body)
    else await api.post('/courses/' + props.courseId + '/questions', body)
    clearTimeout(composeDraftTimer)
    const changedWhileSaving = title.value !== body.title || content.value !== body.content
    saveDraft(
      'compose',
      savedId || 'new',
      changedWhileSaving ? { title: title.value, content: content.value } : null,
    )
    skipComposeCloseDraft = true
    compose.value = false
    await load()
    if (detail.value && editId.value) await open(detail.value)
  } catch (error) {
    ElMessage.error(messageOf(error))
  } finally {
    savingQuestion.value = false
  }
}
async function action(url, body = {}, method = 'post') {
  if (anyImageBusy.value) return false
  try {
    await api[method]('/questions/' + detail.value.id + url, body)
    await open(detail.value)
    await load()
    ElMessage.success('已保存')
    return true
  } catch (error) {
    ElMessage.error(messageOf(error))
    return false
  }
}
async function publicAction(row, suffix, message) {
  try {
    await api.post('/questions/' + row.question_id + suffix)
    await load()
    ElMessage.success(message)
  } catch (error) {
    ElMessage.error(messageOf(error))
  }
}
async function sendReply() {
  if (sendingReply.value) return
  if (replyBusy.value) return ElMessage.warning('请先完成图片上传')
  sendingReply.value = true
  const questionId = detail.value.id,
    sentContent = reply.value
  try {
    await api.post(`/questions/${questionId}/replies`, {
      content: sentContent,
      content_format: 'html',
    })
    const editedAfterSend = reply.value !== sentContent
    clearTimeout(replyDraftTimer)
    if (editedAfterSend) saveDraft('reply', replyDraftId.value, { content: reply.value })
    else {
      reply.value = ''
      saveDraft('reply', replyDraftId.value, null)
    }
    try {
      detail.value = (await api.get(`/questions/${questionId}`)).data
      await load()
    } catch {
      ElMessage.warning('回复已发送，但页面刷新失败；可稍后重新打开查看。')
      return
    }
    ElMessage.success('回复已发送')
  } catch (error) {
    ElMessage.error(messageOf(error))
  } finally {
    sendingReply.value = false
  }
}
async function remove() {
  try {
    await ElMessageBox.confirm('确定删除尚未得到回复的问题？', '确认')
    await api.delete('/questions/' + detail.value.id)
    dialog.value = false
    await load()
  } catch (error) {
    if (!isDialogDismissal(error)) ElMessage.error(messageOf(error))
  }
}
async function removePublication(publicationRecord) {
  try {
    await ElMessageBox.confirm(
      '删除后学生端立即消失且不可恢复，仅保留教师可见的删除留痕。确定删除这条公开摘要？',
      '删除公开摘要',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
    await api.delete(`/questions/${detail.value.id}/publications/${publicationRecord.id}`)
    await open(detail.value)
    await load()
    ElMessage.success('公开摘要已删除')
  } catch (error) {
    if (!isDialogDismissal(error)) ElMessage.error(messageOf(error))
  }
}
async function removePublicationRow(row) {
  try {
    await ElMessageBox.confirm(
      '删除后学生端立即消失且不可恢复。确定删除这条公开问答？',
      '删除公开问答',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
    await api.delete(`/questions/${row.question_id}/publications/${row.id}`)
    publicCard.expanded.value.delete(row.id)
    await load()
    ElMessage.success('公开问答已删除')
  } catch (error) {
    if (!isDialogDismissal(error)) ElMessage.error(messageOf(error))
  }
}
async function movePublication(row, direction) {
  try {
    await api.post(`/questions/${row.question_id}/publications/${row.id}/move`, { direction })
    await load()
  } catch (error) {
    ElMessage.error(messageOf(error))
  }
}
function publishDialog() {
  summary.value = ''
  publicReply.value = ''
  publication.value = true
}
async function publish() {
  if (summaryBusy.value || publicReplyBusy.value) return ElMessage.warning('请先完成图片上传')
  if (
    await action('/publish', {
      summary: summary.value,
      reply: publicReply.value,
      content_format: 'html',
    })
  )
    publication.value = false
}
function switchTab() {
  page.value = 1
  filter.value = ''
  load()
}
function searchFromFirstPage() {
  page.value = 1
  load()
}
function goToPrevPage() {
  page.value--
  load()
}
function goToNextPage() {
  page.value++
  load()
}
useRefresh(load)
onUnmounted(() => {
  if (compose.value && !teacher.value)
    saveDraft('compose', editId.value || 'new', { title: title.value, content: content.value })
  if (dialog.value && !teacher.value && replyDraftId.value)
    saveDraft('reply', replyDraftId.value, { content: reply.value })
  clearTimeout(composeDraftTimer)
  clearTimeout(replyDraftTimer)
})
</script>
<template>
  <section>
    <div class="toolbar questions-toolbar">
      <el-radio-group v-model="tab" @change="switchTab"
        ><el-radio-button value="private">{{
          teacher ? '学生提问管理' : '我的提问'
        }}</el-radio-button
        ><el-radio-button value="public">全班公开问答</el-radio-button></el-radio-group
      >
      <div class="questions-toolbar-actions">
        <el-button v-if="!teacher && !readonly" @click="newQuestion()">提问</el-button>
        <router-link
          :to="{ path: '/help', hash: teacher ? '#teacher-qa' : '#student-qa' }"
          custom
          v-slot="{ navigate }"
        >
          <el-button size="small" @click="navigate">隐私说明</el-button>
        </router-link>
      </div>
    </div>
    <p class="hint">
      原始问题、追问和师生回复仅提问人和教师可见；教师可另写匿名摘要和答复发布到全班公开区。
    </p>
    <el-alert
      v-if="loadError"
      :title="loadError"
      type="error"
      show-icon
      :closable="false"
      style="margin-bottom: 14px"
      ><el-button size="small" @click="load">重试</el-button></el-alert
    >
    <div v-if="loading && !loaded" class="hint">正在加载问答…</div>
    <div class="toolbar">
      <el-input
        v-model="keyword"
        placeholder="搜索问题"
        style="max-width: 300px"
        @keyup.enter="searchFromFirstPage"
      /><el-select
        v-if="tab === 'private'"
        v-model="filter"
        clearable
        placeholder="所有状态"
        style="width: 140px"
        @change="searchFromFirstPage"
        ><el-option label="待回复" value="open" /><el-option
          label="已回复"
          value="answered" /><el-option label="已解决" value="resolved" /></el-select
      ><el-button @click="searchFromFirstPage">搜索</el-button>
    </div>
    <template v-if="tab === 'public'">
      <article v-for="(row, index) in rows" :key="row.id" class="assignment-card collapsible-card">
        <div class="card-head" @click="publicCard.toggle(row.id)">
          <span v-if="row.pinned" class="badge" style="background: #e6a23c">置顶</span>
          <b class="card-title">{{ contentSummary(row.summary, row.content_format) }}</b>
          <span
            v-if="row.status === 'withdrawn'"
            class="badge"
            style="background: #c0c4cc; color: #fff"
            >已撤回</span
          >
          <span class="hint">{{ row.created_at }}</span>
          <el-button-group v-if="teacher" @click.stop
            ><el-button
              size="small"
              :disabled="
                readonly || (page === 1 && index === 0) || rows[index - 1]?.pinned !== row.pinned
              "
              @click="movePublication(row, 'up')"
              >上移</el-button
            ><el-button
              size="small"
              :disabled="readonly || rows[index + 1]?.pinned !== row.pinned"
              @click="movePublication(row, 'down')"
              >下移</el-button
            ></el-button-group
          >
          <span class="card-chevron">{{ publicCard.isOpen(row.id) ? '收起 ▲' : '展开 ▼' }}</span>
        </div>
        <div v-if="publicCard.isOpen(row.id)" class="card-body">
          <RichTextContent :content="row.summary" :format="row.content_format" /><RichTextContent
            :content="row.reply"
            :format="row.content_format"
          />
          <div v-if="teacher" class="toolbar" style="margin-bottom: 0">
            <el-button @click="openFromPublic(row)">查看原提问</el-button>
            <el-button
              v-if="row.status === 'published'"
              :disabled="readonly"
              @click="publicAction(row, '/withdraw', '公开摘要已撤回')"
              >撤回</el-button
            >
            <el-button type="danger" :disabled="readonly" @click="removePublicationRow(row)"
              >删除</el-button
            >
          </div>
        </div>
      </article>
    </template>
    <template v-else>
      <article v-for="row in rows" :key="row.id" class="assignment-card">
        <el-button link type="primary" @click="open(row)"
          >{{ row.pinned ? '置顶 · ' : '' }}{{ row.title }}</el-button
        >
        <p>
          {{ row.student_name }} ·
          {{ { open: '待回复', answered: '已回复', resolved: '已解决' }[row.status] }}
          {{ row.hidden ? ' · 已隐藏' : '' }}
        </p>
      </article>
    </template>
    <p v-if="loaded && !loading && !rows.length" class="hint">暂无相关问答。</p>
    <div class="toolbar">
      <el-button :disabled="page === 1" @click="goToPrevPage">上一页</el-button>
      <span>第{{ page }}页</span>
      <el-button :disabled="rows.length < 20" @click="goToNextPage">下一页</el-button>
    </div>
    <el-dialog
      v-model="compose"
      :title="editId ? '编辑问题' : '提出问题'"
      width="min(1180px,96vw)"
      top="3vh"
      class="markdown-dialog"
      destroy-on-close
      :close-on-click-modal="false"
      :close-on-press-escape="!composeBusy && !savingQuestion"
      :show-close="!composeBusy && !savingQuestion"
      ><el-input v-model="title" placeholder="标题" maxlength="200" /><RichTextEditor
        v-if="compose"
        v-model="content"
        :course-id="courseId"
        label="问题内容富文本"
        @busy="composeBusy = $event"
      />
      <p class="hint">原始内容不会直接公开；教师可以另行整理匿名摘要和答复。</p>
      <template #footer
        ><el-button
          type="primary"
          :loading="savingQuestion"
          :disabled="composeBusy || savingQuestion"
          @click="save"
          >保存</el-button
        ></template
      ></el-dialog
    >
    <el-dialog
      v-model="dialog"
      :title="detail?.title"
      width="min(1180px,96vw)"
      top="3vh"
      class="markdown-dialog"
      destroy-on-close
      :close-on-click-modal="false"
      :close-on-press-escape="!anyImageBusy && !sendingReply"
      :show-close="!anyImageBusy && !sendingReply"
      ><template v-if="detail"
        ><RichTextContent :content="detail.content" :format="detail.content_format" />
        <p class="hint">原题与对话仅提问人和教师可见；公开区只展示教师另写的匿名摘要。</p>
        <div class="toolbar">
          <template v-if="!teacher"
            ><template v-if="!readonly && !detail.replies.length && !detail.publications.length"
              ><el-button :disabled="sendingReply" @click="newQuestion(detail)">编辑</el-button
              ><el-button type="danger" :disabled="sendingReply" @click="remove"
                >删除</el-button
              ></template
            ></template
          ><template v-else
            ><el-button v-if="!readonly" @click="action('/manage', { status: 'resolved' }, 'put')"
              >标记解决</el-button
            ><el-button
              v-if="!readonly"
              @click="action('/manage', { pinned: !detail.pinned }, 'put')"
              >{{ detail.pinned ? '取消置顶' : '置顶' }}</el-button
            ><el-button
              :disabled="readonly"
              @click="action('/manage', { hidden: !detail.hidden }, 'put')"
              >{{ detail.hidden ? '取消隐藏' : '隐藏并撤回公开' }}</el-button
            ><el-button :disabled="readonly || !!detail.hidden" @click="publishDialog"
              >整理公开摘要</el-button
            ><el-button v-if="hasPublished" :disabled="readonly" @click="action('/withdraw')"
              >撤回公开摘要</el-button
            ></template
          >
        </div>
        <article
          v-for="replyRecord in detail.replies"
          :key="replyRecord.id"
          class="assignment-card"
        >
          <b>{{ replyRecord.author_name }} · {{ replyRecord.created_at }}</b>
          <RichTextContent :content="replyRecord.content" :format="replyRecord.content_format" />
        </article>
        <template v-if="!readonly"
          ><RichTextEditor
            v-if="dialog"
            v-model="reply"
            :course-id="courseId"
            label="私人回复富文本"
            @busy="replyBusy = $event"
          /><el-button
            type="primary"
            style="margin-top: 12px"
            :loading="sendingReply"
            :disabled="replyBusy || sendingReply"
            @click="sendReply"
            >发送私人回复</el-button
          ></template
        >
        <h4 v-if="detail.publications.length || pubDeleted">公开摘要历史</h4>
        <p v-if="pubDeleted" class="hint">部分公开摘要已被教师删除，学生端不再显示。</p>
        <article
          v-for="publicationRecord in detail.publications"
          :key="publicationRecord.id"
          class="assignment-card"
        >
          <div style="display: flex; justify-content: space-between; gap: 14px">
            <div>
              <b
                >{{ publicationRecord.status === 'published' ? '已公开' : '已撤回' }} ·
                {{ publicationRecord.created_at }}</b
              >
              <RichTextContent
                :content="publicationRecord.summary"
                :format="publicationRecord.content_format"
              />
              <RichTextContent
                :content="publicationRecord.reply"
                :format="publicationRecord.content_format"
              />
            </div>
            <el-button
              v-if="teacher"
              type="danger"
              text
              :disabled="readonly"
              @click="removePublication(publicationRecord)"
              >删除</el-button
            >
          </div>
        </article></template
      ></el-dialog
    >
    <el-dialog
      v-model="publication"
      title="另写公开摘要与答复"
      width="min(1180px,96vw)"
      top="3vh"
      class="markdown-dialog"
      destroy-on-close
      :close-on-click-modal="false"
      :close-on-press-escape="!anyImageBusy"
      :show-close="!anyImageBusy"
      ><p>请删除私人信息；公开后已被阅读的内容无法收回。</p>
      <RichTextEditor
        v-if="publication"
        v-model="summary"
        :course-id="courseId"
        label="公开问题摘要富文本"
        @busy="summaryBusy = $event"
      /><RichTextEditor
        v-if="publication"
        v-model="publicReply"
        :course-id="courseId"
        label="公开答复富文本"
        @busy="publicReplyBusy = $event"
      /><template #footer
        ><el-button type="primary" :disabled="summaryBusy || publicReplyBusy" @click="publish"
          >向全班公布</el-button
        ></template
      ></el-dialog
    >
  </section>
</template>

<style scoped>
.questions-toolbar {
  justify-content: space-between;
}
.questions-toolbar-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-left: auto;
}
.questions-toolbar-actions :deep(.el-button) {
  margin: 0;
}
</style>
