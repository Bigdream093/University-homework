<script setup>
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useUserStore } from '../stores/user.js'
import { useRefresh } from '../composables/useRefresh.js'
import { useCollapse } from '../composables/useCollapse.js'
import api, { messageOf } from '../api/request.js'
const props = defineProps({ courseId: [String, Number], readonly: Boolean })
const teacher = computed(() => useUserStore().user?.role === 'teacher'),
  tab = ref('private'),
  keyword = ref(''),
  filter = ref(''),
  page = ref(1),
  rows = ref([]),
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
const publicCard = useCollapse()
const hasPublished = computed(
  () => !!detail.value?.publications.some((publication) => publication.status === 'published'),
)
// 教师删除公开摘要不留记录行，仅以可见性事件留痕；学生端据此显示提示。
const pubDeleted = computed(
  () => !!detail.value?.visibility_events.some((event) => event.event === 'delete_publication'),
)
let loadSequence = 0
async function load() {
  const sequence = ++loadSequence,
    courseId = props.courseId,
    view = tab.value,
    params = { keyword: keyword.value, status: filter.value, page: page.value, limit: 20 }
  try {
    const data = (
      await api.get('/courses/' + courseId + '/questions' + (view === 'public' ? '/public' : ''), {
        params,
      })
    ).data
    if (sequence === loadSequence) rows.value = data
  } catch (error) {
    if (sequence === loadSequence) ElMessage.error(messageOf(error))
  }
}
async function open(row) {
  try {
    detail.value = (await api.get('/questions/' + row.id)).data
    reply.value = ''
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
  title.value = row?.title || ''
  content.value = row?.content || ''
  compose.value = true
}
async function save() {
  try {
    if (editId.value)
      await api.put('/questions/' + editId.value, { title: title.value, content: content.value })
    else
      await api.post('/courses/' + props.courseId + '/questions', {
        title: title.value,
        content: content.value,
      })
    compose.value = false
    await load()
    if (detail.value && editId.value) await open(detail.value)
  } catch (error) {
    ElMessage.error(messageOf(error))
  }
}
async function action(url, body = {}, method = 'post') {
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
  if (await action('/replies', { content: reply.value })) reply.value = ''
}
async function remove() {
  try {
    await ElMessageBox.confirm('确定删除尚未得到回复的问题？', '确认')
    await api.delete('/questions/' + detail.value.id)
    dialog.value = false
    await load()
  } catch (error) {
    if (error !== 'cancel') ElMessage.error(messageOf(error))
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
    if (error !== 'cancel') ElMessage.error(messageOf(error))
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
    if (error !== 'cancel') ElMessage.error(messageOf(error))
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
  if (await action('/publish', { summary: summary.value, reply: publicReply.value }))
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
</script>
<template>
  <section>
    <div class="toolbar">
      <el-radio-group v-model="tab" @change="switchTab"
        ><el-radio-button value="private">{{
          teacher ? '学生提问管理' : '我的提问'
        }}</el-radio-button
        ><el-radio-button value="public">全班公开问答</el-radio-button></el-radio-group
      ><el-button v-if="!teacher && !readonly" @click="newQuestion()">提问</el-button
      ><router-link :to="{ path: '/help', hash: teacher ? '#teacher-notice' : '#student-notice' }"
        >隐私说明</router-link
      >
    </div>
    <p class="hint">
      原始问题、追问和师生回复仅提问人和教师可见；教师可另写匿名摘要和答复发布到全班公开区。
    </p>
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
      <article
        v-for="(row, index) in rows"
        :key="row.id"
        class="assignment-card collapsible-card"
      >
        <div class="card-head" @click="publicCard.toggle(row.id)">
          <span v-if="row.pinned" class="badge" style="background: #e6a23c">置顶</span>
          <b class="card-title">{{ row.summary }}</b>
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
          <p style="white-space: pre-wrap; line-height: 1.8; color: #566e69; margin: 0 0 12px">
            {{ row.reply }}
          </p>
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
    <p v-if="!rows.length" class="hint">暂无相关问答。</p>
    <div class="toolbar">
      <el-button :disabled="page === 1" @click="goToPrevPage">上一页</el-button>
      <span>第{{ page }}页</span>
      <el-button :disabled="rows.length < 20" @click="goToNextPage">下一页</el-button>
    </div>
    <el-dialog v-model="compose" :title="editId ? '编辑问题' : '提出问题'" width="min(640px,94vw)"
      ><el-input v-model="title" placeholder="标题" maxlength="200" /><el-input
        v-model="content"
        type="textarea"
        :rows="6"
        placeholder="问题内容"
        style="margin: 16px 0"
      />
      <p class="hint">原始内容不会直接公开；教师可以另行整理匿名摘要和答复。</p>
      <template #footer
        ><el-button type="primary" @click="save">保存</el-button></template
      ></el-dialog
    >
    <el-dialog v-model="dialog" :title="detail?.title" width="min(760px,94vw)"
      ><template v-if="detail"
        ><p style="white-space: pre-wrap">{{ detail.content }}</p>
        <p class="hint">原题与对话仅提问人和教师可见；公开区只展示教师另写的匿名摘要。</p>
        <div class="toolbar">
          <template v-if="!teacher"
            ><template v-if="!readonly && !detail.replies.length && !detail.publications.length"
              ><el-button @click="newQuestion(detail)">编辑</el-button
              ><el-button type="danger" @click="remove">删除</el-button></template
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
        <article v-for="replyRecord in detail.replies" :key="replyRecord.id" class="assignment-card">
          <b>{{ replyRecord.author_name }} · {{ replyRecord.created_at }}</b>
          <p style="white-space: pre-wrap">{{ replyRecord.content }}</p>
        </article>
        <template v-if="!readonly"
          ><el-input
            v-model="reply"
            type="textarea"
            :rows="3"
            placeholder="私人回复 / 追问"
          /><el-button type="primary" style="margin-top: 12px" @click="sendReply"
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
              <p>{{ publicationRecord.summary }}</p>
              <p>{{ publicationRecord.reply }}</p>
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
    <el-dialog v-model="publication" title="另写公开摘要与答复" width="min(640px,94vw)"
      ><p>请删除私人信息；公开后已被阅读的内容无法收回。</p>
      <el-input v-model="summary" type="textarea" :rows="3" placeholder="公开问题摘要" /><el-input
        v-model="publicReply"
        type="textarea"
        :rows="5"
        placeholder="公开答复"
        style="margin-top: 14px"
      /><template #footer
        ><el-button type="primary" @click="publish">向全班公布</el-button></template
      ></el-dialog
    >
  </section>
</template>
