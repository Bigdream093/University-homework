<script setup>
import FileDropZone from '../FileDropZone.vue'
import PreviewImagePicker from '../PreviewImagePicker.vue'
import { DEFAULT_REQUIRED_ANSWER_MAX_CHARS } from '@university-homework/domain/requiredAnswers'

defineProps({
  assignment: { type: Object, required: true },
  submission: { type: Object, default: null },
  questions: { type: Array, default: () => [] },
  answers: { type: Object, default: () => ({}) },
  content: { type: String, default: '' },
  file: { type: Object, default: null },
  previews: { type: Array, default: () => [] },
  requirePreview: { type: Boolean, default: false },
  previewMax: { type: Number, default: 3 },
  acceptAttribute: { type: String, default: null },
  allowedExtensions: { type: Array, default: () => [] },
  extensionLabel: { type: String, default: '' },
  fileSizeLabel: { type: String, default: '' },
  checklist: { type: Array, default: () => [] },
  submissionState: { type: Object, required: true },
  submissionStateTitle: { type: String, default: '' },
  submissionLocked: { type: Boolean, default: false },
  submissionUncertain: { type: Boolean, default: false },
  canSubmit: { type: Boolean, default: false },
  submissionBlockReason: { type: String, default: '' },
  uploadState: { type: String, default: '' },
  uploadPercent: { type: Number, default: 0 },
  uploadTotal: { type: Number, default: 0 },
  uploadBusy: { type: Boolean, default: false },
  uploadCanPause: { type: Boolean, default: false },
  uploadCanCancel: { type: Boolean, default: false },
  uploadLoaded: { type: Number, default: 0 },
  uploadPhase: { type: String, default: '' },
  loading: { type: Boolean, default: false },
  confirming: { type: Boolean, default: false },
  deadlineView: { type: Object, required: true },
})

const emit = defineEmits([
  'update:content',
  'update:file',
  'update:previews',
  'set-answer',
  'cancel-edit',
  'submit',
  'copy-reference',
  'refresh-conflict',
  'pause-upload',
  'cancel-upload',
])
</script>

<template>
  <div v-if="submission" class="edit-heading">
    <div>
      <h3>{{ submission.status === 'returned' ? '修改并重新提交' : '修改提交' }}</h3>
      <p class="hint">
        答案已带入。<template v-if="assignment.type !== 'online'">请重新选择源文件。</template>
        <template v-if="requirePreview">请重新选择本次预览图。</template>
      </p>
    </div>
    <el-button :disabled="submissionLocked || uploadBusy" @click="emit('cancel-edit')">
      取消修改
    </el-button>
  </div>
  <h3 v-else>提交作业</h3>
  <p v-if="!canSubmit" class="hint">{{ submissionBlockReason }}</p>
  <div v-if="questions.length" class="required-answers">
    <article v-for="(question, index) in questions" :key="question.id" class="required-answer-item">
      <div class="readonly-question">
        <h4>必答题目 {{ index + 1 }}</h4>
        <p class="question-title">{{ question.title }}</p>
      </div>
      <label :for="'required-answer-' + question.id">第 {{ index + 1 }} 题答案</label>
      <el-input
        :id="'required-answer-' + question.id"
        :model-value="answers[question.id] || ''"
        :disabled="submissionLocked || submissionUncertain || !canSubmit"
        type="textarea"
        :rows="4"
        :maxlength="question.maxChars ?? DEFAULT_REQUIRED_ANSWER_MAX_CHARS"
        show-word-limit
        :placeholder="question.guidance || '请按题目要求规范作答'"
        :aria-label="`第${index + 1}题答案`"
        @update:model-value="emit('set-answer', question.id, $event)"
      />
    </article>
  </div>
  <el-input
    v-else-if="assignment.type === 'online'"
    :model-value="content"
    :disabled="submissionLocked || submissionUncertain || !canSubmit"
    type="textarea"
    :rows="8"
    placeholder="在此输入作答内容"
    aria-label="在线作答内容"
    @update:model-value="emit('update:content', $event)"
  />
  <template v-if="assignment.type !== 'online'">
    <p class="hint" style="margin: 0 0 6px">
      <b>{{ assignment.required_answer ? '②' : '①' }} 文件区域</b>（源文件）
    </p>
    <FileDropZone
      :model-value="file"
      :disabled="submissionLocked || submissionUncertain || !canSubmit"
      :accept="acceptAttribute"
      @update:model-value="emit('update:file', $event)"
    >
      <span v-if="allowedExtensions.length" class="upload-dropzone__tag">
        允许格式：{{ extensionLabel }}
      </span>
      <span class="upload-dropzone__tag">单文件不超过 {{ fileSizeLabel }}</span>
      <span v-if="!allowedExtensions.length" class="upload-dropzone__note">
        支持文档、图片、视频、设计源文件和压缩包
      </span>
      <span class="upload-dropzone__note">提交后自动命名为：姓名_学号_提交时间.扩展名</span>
    </FileDropZone>
    <template v-if="requirePreview">
      <p class="hint" style="margin: 16px 0 6px">
        <b>{{ assignment.required_answer ? '③' : '②' }} 图片区域</b>（预览图，老师评分时直接查看）
      </p>
      <PreviewImagePicker
        :model-value="previews"
        :max="previewMax"
        :disabled="submissionLocked || submissionUncertain || !canSubmit"
        @update:model-value="emit('update:previews', $event)"
      />
    </template>
  </template>

  <section
    v-if="checklist.length"
    class="submit-checklist"
    :class="{ 'is-complete': checklist.every((item) => item.ok) }"
    aria-label="提交检查"
  >
    <b>提交检查</b>
    <ul>
      <li v-for="(item, index) in checklist" :key="index" :class="item.ok ? 'is-ok' : 'is-pending'">
        <span aria-hidden="true">{{ item.ok ? '✓' : '×' }}</span>
        {{ item.text }}
      </li>
    </ul>
  </section>

  <el-alert
    v-if="submissionState.kind !== 'idle'"
    :title="submissionStateTitle"
    :type="submissionState.kind === 'uncertain' ? 'warning' : 'error'"
    show-icon
    :closable="false"
    style="margin-top: 14px"
  >
    <p style="margin: 0 0 8px">原因分类：{{ submissionState.category }}</p>
    <p style="margin: 0 0 8px">{{ submissionState.message }}</p>
    <p v-if="submissionState.kind === 'uncertain'" style="margin: 0 0 8px">
      服务器可能已经保存。请先查询或重试同一份内容，确认结果后再继续修改。
    </p>
    <div v-if="submissionState.reference" class="hint" style="margin: 0 0 8px">
      问题编号：<code>{{ submissionState.reference }}</code>
      <el-button link type="primary" @click="emit('copy-reference')">复制编号</el-button>
    </div>
    <el-button
      v-if="submissionState.kind === 'conflict'"
      size="small"
      type="primary"
      @click="emit('refresh-conflict')"
      >获取最新状态</el-button
    >
    <el-button v-else size="small" type="primary" @click="emit('submit')">
      {{ submissionState.kind === 'uncertain' ? '查询服务器结果' : '按当前内容重试' }}
    </el-button>
  </el-alert>

  <div v-if="uploadState" style="margin: 14px 0 4px">
    <el-progress :percentage="uploadPercent" :indeterminate="!uploadTotal && uploadBusy" />
    <p class="hint" style="margin: 6px 0 0">
      已传 {{ (uploadLoaded / 1024 / 1024).toFixed(1) }} MB /
      {{ uploadTotal ? (uploadTotal / 1024 / 1024).toFixed(1) + ' MB' : '总大小待确认' }}
    </p>
    <p role="status" style="margin: 4px 0 0">{{ uploadState }}</p>
    <el-button
      v-if="uploadCanPause"
      size="small"
      style="margin-top: 8px"
      @click="emit('pause-upload')"
      >暂停</el-button
    >
    <el-button
      v-if="uploadCanCancel"
      size="small"
      type="danger"
      plain
      style="margin-top: 8px"
      @click="emit('cancel-upload')"
      >取消上传</el-button
    >
  </div>
  <el-button
    :type="
      submissionState.kind !== 'idle'
        ? 'default'
        : deadlineView.kind === 'late'
          ? 'danger'
          : 'primary'
    "
    :color="submissionState.kind !== 'idle' || deadlineView.kind === 'late' ? '' : '#15554e'"
    size="large"
    style="width: 100%; margin-top: 16px"
    :loading="loading || confirming"
    :disabled="
      submissionLocked ||
      submissionState.kind !== 'idle' ||
      !canSubmit ||
      checklist.some((item) => !item.ok)
    "
    @click="emit('submit')"
  >
    {{
      submissionState.kind !== 'idle'
        ? '请按上方提示处理'
        : uploadPhase === 'paused'
          ? '继续上传'
          : ['failed', 'uncertain'].includes(uploadPhase)
            ? '查询 / 重试'
            : submission
              ? submission.status === 'returned'
                ? '确认重新提交'
                : deadlineView.kind === 'late'
                  ? '确认修改并迟交'
                  : '确认提交修改'
              : deadlineView.kind === 'late'
                ? '仍要迟交'
                : '确认提交'
    }}
  </el-button>
  <p class="hint">
    提交时间和迟交状态以服务器记录为准。上传100%后仍须等待保存。断网或刷新后重新选择相同文件，可从已上传位置继续。
  </p>
</template>

<style scoped>
.submit-checklist {
  margin-top: 14px;
  border: 1px solid #efcf8a;
  border-radius: 10px;
  padding: 10px 14px;
  background: #fff8e9;
  color: #8a641e;
}
.submit-checklist.is-complete {
  border-color: #b8d9c5;
  background: #eff8f2;
  color: #39735f;
}
.submit-checklist ul {
  display: grid;
  gap: 6px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}
.submit-checklist li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  line-height: 1.5;
}
.submit-checklist li > span {
  width: 1.2em;
  flex: none;
  font-weight: 700;
  text-align: center;
}
.submit-checklist li.is-ok {
  color: #39735f;
}
.submit-checklist li.is-pending {
  color: #9a5d1e;
}
.edit-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 18px;
}
.edit-heading h3 {
  margin: 0 0 5px;
}
.edit-heading p {
  margin: 0;
}
.required-answer-item {
  margin-bottom: 18px;
}
.readonly-question {
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #f7fbf9;
}
.readonly-question h4 {
  margin: 0 0 8px;
}
.question-title {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 0;
  font-weight: 400;
  line-height: 1.7;
}
.required-answer-item label {
  display: block;
  margin: 10px 0 6px;
  font-weight: 600;
}
</style>
