<script setup>
import { ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRefresh } from '../../composables/useRefresh.js'
import { useCollapse } from '../../composables/useCollapse.js'
import api, { messageOf } from '../../api/request.js'
import linkify from '../../utils/linkify.js'
const originalStatus = ref('draft'),
  historyDialog = ref(false),
  revisionDetail = ref(null)
const noticeCard = useCollapse()
// 折叠态一行摘要：草稿/定时/撤回各显示关键时间，已发布显示发布时间。
function brief(notice) {
  return notice.status === 'draft'
    ? '未发布'
    : notice.status === 'scheduled'
      ? `定时 ${notice.scheduled_at || '—'}`
      : notice.status === 'withdrawn'
        ? `撤回于 ${notice.withdrawn_at || '—'}`
        : `发布于 ${notice.published_at || notice.created_at}`
}
async function showHistory(notice) {
  try {
    revisionDetail.value = (await api.get('/notices/' + notice.id)).data
    historyDialog.value = true
  } catch (error) {
    ElMessage.error(messageOf(error))
  }
}
const props = defineProps({
  courseId: { type: [String, Number], required: true },
  readonly: Boolean,
})
const notices = ref([]),
  dialog = ref(false),
  readersDialog = ref(false),
  readers = ref([]),
  editId = ref(null),
  form = ref({ title: '', content: '', pinned: false, status: 'draft', scheduled_at: '' })
async function load() {
  try {
    notices.value = (await api.get(`/courses/${props.courseId}/notices`)).data
  } catch (error) {
    ElMessage.error(messageOf(error))
  }
}
function open(notice) {
  originalStatus.value = notice?.status || 'draft'
  editId.value = notice?.id || null
  form.value = notice
    ? {
        title: notice.title,
        content: notice.content,
        pinned: Boolean(notice.pinned),
        status:
          notice.status === 'scheduled'
            ? 'scheduled'
            : notice.status === 'published'
              ? 'published'
              : 'draft',
        scheduled_at: notice.scheduled_at || '',
      }
    : { title: '', content: '', pinned: false, status: 'draft', scheduled_at: '' }
  dialog.value = true
}
async function save() {
  if (!form.value.title.trim()) return ElMessage.warning('请填写通知标题')
  try {
    if (editId.value) await api.put(`/notices/${editId.value}`, form.value)
    else await api.post(`/courses/${props.courseId}/notices`, form.value)
    dialog.value = false
    ElMessage.success('通知已保存')
    load()
  } catch (error) {
    ElMessage.error(messageOf(error))
  }
}
async function withdraw(notice) {
  try {
    const { value } = await ElMessageBox.prompt(
      '撤回后学生只能看到撤回提示，历史保留。可填写撤回原因：',
      '撤回通知',
      { inputType: 'textarea' },
    )
    await api.post(`/notices/${notice.id}/withdraw`, { reason: value || '' })
    ElMessage.success('通知已撤回')
    load()
  } catch (error) {
    if (error !== 'cancel') ElMessage.error(messageOf(error))
  }
}
async function remove(notice) {
  try {
    await ElMessageBox.confirm('确定删除这条未发布通知？', '确认', { type: 'warning' })
    await api.delete(`/notices/${notice.id}`)
    load()
  } catch (error) {
    if (error !== 'cancel') ElMessage.error(messageOf(error))
  }
}
async function showReaders(notice) {
  try {
    readers.value = (await api.get(`/notices/${notice.id}/readers`)).data
    readersDialog.value = true
  } catch (error) {
    ElMessage.error(messageOf(error))
  }
}
async function move(notice, direction) {
  try {
    await api.post(`/notices/${notice.id}/move`, { direction })
    await load()
  } catch (error) {
    ElMessage.error(messageOf(error))
  }
}
useRefresh(load)
</script>
<template>
  <div>
    <div class="toolbar">
      <el-button type="primary" color="#15554e" :disabled="readonly" @click="open()"
        >发布通知</el-button
      ><span class="hint">已发布通知可修正或撤回，不能回到草稿。点击卡片展开正文和操作。</span>
    </div>
    <div v-if="notices.length">
      <article
        v-for="(notice, index) in notices"
        :key="notice.id"
        class="assignment-card collapsible-card"
      >
        <div class="card-head" @click="noticeCard.toggle(notice.id)">
          <span class="badge">{{
            { draft: '草稿', scheduled: '定时发布', published: '已发布', withdrawn: '已撤回' }[
              notice.status
            ]
          }}</span
          ><span v-if="notice.pinned" class="badge" style="background: #e6a23c">置顶</span>
          <h3 class="card-title">{{ notice.title }}</h3>
          <span class="hint">{{ brief(notice) }}</span
          ><el-button-group @click.stop
            ><el-button
              size="small"
              :disabled="readonly || index === 0 || notices[index - 1]?.pinned !== notice.pinned"
              @click="move(notice, 'up')"
              >上移</el-button
            ><el-button
              size="small"
              :disabled="
                readonly ||
                index === notices.length - 1 ||
                notices[index + 1]?.pinned !== notice.pinned
              "
              @click="move(notice, 'down')"
              >下移</el-button
            ></el-button-group
          ><span class="card-chevron">{{
            noticeCard.isOpen(notice.id) ? '收起 ▲' : '展开 ▼'
          }}</span>
        </div>
        <div v-if="noticeCard.isOpen(notice.id)" class="card-body">
          <p
            style="white-space: pre-wrap; line-height: 1.8; color: #566e69; margin: 0 0 14px"
            v-html="linkify(notice.content)"
          ></p>
          <div class="assignment-actions">
            <el-button @click="showHistory(notice)">历史</el-button
            ><el-button @click="showReaders(notice)">已读名单</el-button
            ><el-button
              v-if="notice.status !== 'withdrawn'"
              :disabled="readonly"
              @click="open(notice)"
              >编辑</el-button
            ><el-button
              v-if="notice.status === 'published'"
              type="warning"
              :disabled="readonly"
              @click="withdraw(notice)"
              >撤回</el-button
            ><el-button
              v-if="notice.status === 'draft'"
              type="danger"
              text
              :disabled="readonly"
              @click="remove(notice)"
              >删除</el-button
            >
          </div>
          <span class="hint" style="display: block; margin-top: 12px"
            >计划 {{ notice.scheduled_at || '—' }} · 实际发布 {{ notice.published_at || '—' }} ·
            修改 {{ notice.updated_at }} · 撤回 {{ notice.withdrawn_at || '—' }} · 已读
            {{ notice.read_count || 0 }} 人 · 修订 {{ notice.content_revision }}</span
          >
        </div>
      </article>
    </div>
    <div v-else class="empty">还没有通知。</div>
    <el-dialog v-model="dialog" :title="editId ? '编辑通知' : '发布通知'" width="min(560px,92vw)"
      ><el-form label-position="top"
        ><el-form-item label="标题"><el-input v-model="form.title" /></el-form-item
        ><el-form-item label="内容"
          ><el-input v-model="form.content" type="textarea" :rows="6" /></el-form-item
        ><el-form-item v-if="originalStatus !== 'published'" label="发布方式"
          ><el-radio-group v-model="form.status"
            ><el-radio value="draft">草稿</el-radio><el-radio value="published">立即发布</el-radio
            ><el-radio value="scheduled">定时发布</el-radio></el-radio-group
          ></el-form-item
        ><el-form-item v-if="form.status === 'scheduled'" label="发布时间"
          ><el-date-picker
            v-model="form.scheduled_at"
            type="datetime"
            value-format="YYYY-MM-DD HH:mm:ss" /></el-form-item
        ><el-checkbox v-model="form.pinned">置顶显示</el-checkbox></el-form
      ><template #footer
        ><el-button @click="dialog = false">取消</el-button
        ><el-button type="primary" color="#15554e" @click="save">保存</el-button></template
      ></el-dialog
    ><el-dialog v-model="readersDialog" title="已读学生" width="min(520px,92vw)"
      ><el-table :data="readers"
        ><el-table-column prop="username" label="学号" /><el-table-column
          prop="name"
          label="姓名" /><el-table-column prop="first_read_at" label="首次查看" /><el-table-column
          prop="last_read_at"
          label="最近查看" /><el-table-column
          prop="last_seen_revision"
          label="已读版本" /></el-table></el-dialog
    ><el-dialog v-model="historyDialog" title="通知历史" width="min(760px,94vw)"
      ><template v-if="revisionDetail"
        ><p>
          首次发布：{{ revisionDetail.published_at || '未发布' }} · 撤回：{{
            revisionDetail.withdrawn_at || '—'
          }}
        </p>
        <p v-if="revisionDetail.withdrawn_reason">
          撤回原因：{{ revisionDetail.withdrawn_reason }}
        </p>
        <article
          v-for="revision in revisionDetail.revisions"
          :key="revision.revision"
          class="assignment-card"
        >
          <b>版本{{ revision.revision }} · {{ revision.changed_at }} · {{ revision.title }}</b>
          <p
            style="white-space: pre-wrap"
            v-html="linkify(revision.content)"
          ></p></article></template
    ></el-dialog>
  </div>
</template>
<style scoped>
article p :deep(a),
p :deep(a) {
  color: var(--green);
  text-decoration: underline;
  word-break: break-all;
}
article p :deep(a:hover),
p :deep(a:hover) {
  color: var(--green2);
}
</style>
