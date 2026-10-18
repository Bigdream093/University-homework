<script setup>
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import api, { messageOf } from '../api/request.js'
import RequiredAnswerContent from './RequiredAnswerContent.vue'
import { normalizeSubmissionFileName } from '../utils/submissionFiles.js'
const props = defineProps({ apiBase: String })
const emit = defineEmits(['download'])
const visible = ref(false),
  history = ref([]),
  receipts = ref([])
const states = {
  available: '文件仍可下载',
  online: '在线作答',
  replaced: '原文件已替换',
  legacy_unknown: '旧记录状态未知',
  missing: '实体文件缺失',
}
async function open() {
  if (!props.apiBase) {
    history.value = []
    receipts.value = []
    visible.value = true
    return
  }
  try {
    const [historyResponse, receiptsResponse] = await Promise.all([
      api.get(props.apiBase + '/history'),
      api.get(props.apiBase + '/receipts'),
    ])
    history.value = historyResponse.data
    receipts.value = receiptsResponse.data
    visible.value = true
  } catch (error) {
    ElMessage.error(messageOf(error))
  }
}
function download(url, name, kind, extra = {}) {
  const group = props.apiBase.startsWith('/group-submissions/'),
    id = Number(props.apiBase.split('/').pop())
  emit('download', {
    endpoint: '/api' + url,
    ticket: { kind, id, group, ...extra },
    fileName: name,
  })
}
defineExpose({ open })
</script>
<template>
  <el-button @click="open">历史与回执</el-button>
  <el-dialog v-model="visible" title="提交历史与回执" width="min(780px,94vw)">
    <p class="hint">
      回执保存提交时的事实；旧文件的当前可用状态另外显示。旧数据可能没有回执，不补造未知信息。
    </p>
    <p v-if="!receipts.length && !history.length" class="empty">暂无提交历史与回执。</p>
    <article v-for="receipt in receipts" :key="receipt.receipt_no" class="assignment-card">
      <b>{{ receipt.receipt_no }}</b>
      <p>{{ receipt.snapshot.course_name }} / {{ receipt.snapshot.assignment_title }}</p>
      <p>
        实际提交人：{{ receipt.snapshot.student?.name }}（{{ receipt.snapshot.student?.username }}）
        · 第{{ receipt.snapshot.submit_count }}次 ·
        {{ receipt.snapshot.is_late ? '迟交' : '准时' }}
      </p>
      <p>
        提交：{{ receipt.snapshot.submitted_at }} · 当时有效截止：{{
          receipt.snapshot.effective_deadline || '不限'
        }}
      </p>
      <p v-if="receipt.snapshot.group">
        小组：{{ receipt.snapshot.group.name }} · 成员：{{
          receipt.snapshot.group.members
            .map((member) => member.name + '（' + member.username + '）')
            .join('、')
        }}
      </p>
      <p>
        文件：{{ normalizeSubmissionFileName(receipt.snapshot.file_name) || '在线作答' }} ·
        提交时：{{ states[receipt.snapshot.file_state] || '未知' }} · 当前：{{
          states[receipt.current_file_state] || '未知'
        }}
      </p>
      <RequiredAnswerContent
        :questions="receipt.snapshot.answer_question"
        :content="receipt.snapshot.answer"
      />
      <el-button
        @click="
          download(
            apiBase + '/receipts/' + receipt.receipt_no + '/file',
            receipt.receipt_no + '.txt',
            'submission-receipt',
            { receiptNumber: receipt.receipt_no },
          )
        "
        >下载回执</el-button
      >
    </article>
    <h3>全部提交历史</h3>
    <article v-for="historyRecord in history" :key="historyRecord.id" class="assignment-card">
      <b
        >{{ historyRecord.submitted_at }} ·
        {{ normalizeSubmissionFileName(historyRecord.file_name) || '在线作答' }}</b
      >
      <p>
        {{ historyRecord.is_late ? '迟交' : '准时' }} ·
        {{ states[historyRecord.file_state] }}
      </p>
      <RequiredAnswerContent
        :questions="historyRecord.answer_question"
        :content="historyRecord.content"
      />
      <el-button
        v-if="['available', 'online'].includes(historyRecord.file_state)"
        @click="
          download(
            apiBase + '/file?history_id=' + historyRecord.id,
            normalizeSubmissionFileName(historyRecord.file_name) || '在线作答.txt',
            'submission-file',
            { historyId: historyRecord.id },
          )
        "
        >下载此版本</el-button
      >
    </article>
  </el-dialog>
</template>
