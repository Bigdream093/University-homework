<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import api, { messageOf } from '../../api/request.js';
import { createServerClock, deadlineState } from '../../utils/deadline.js';

const route = useRoute();
const router = useRouter();
const assignment = ref({});
const submission = ref(null);
const content = ref('');
const file = ref(null);
const loading = ref(false);
const history = ref([]);
const historyDialog = ref(false);
const currentTime = ref(Date.now());
let serverClock = () => Date.now();
let clockTimer;

const deadline = computed(() => deadlineState(assignment.value.deadline, currentTime.value));
const fileSizeLabel = computed(() => {
  const mb = assignment.value.max_file_mb || 200;
  return mb >= 1024 ? '1G' : `${mb}M`;
});

async function load() {
  try {
    const [assignmentResponse, submissionResponse] = await Promise.all([
      api.get(`/assignments/${route.params.id}`),
      api.get(`/assignments/${route.params.id}/my-submission`)
    ]);
    assignment.value = assignmentResponse.data;
    submission.value = submissionResponse.data;
    content.value = submission.value?.content || '';
    serverClock = createServerClock(assignment.value.server_now);
    currentTime.value = serverClock();
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

function onFileChange(event) {
  const selected = event.target.files[0] || null;
  if (selected && assignment.value.max_file_mb && selected.size > assignment.value.max_file_mb * 1024 * 1024) {
    ElMessage.warning(`该作业限制单文件不超过 ${fileSizeLabel.value}`);
    event.target.value = '';
    return;
  }
  file.value = selected;
}

async function confirmSubmission() {
  const isLate = deadline.value.kind === 'late';
  const appendMode = assignment.value.submission_mode === 'append';
  const replacesFile = !appendMode && Boolean(file.value && submission.value?.file_name);
  if (!isLate && !replacesFile) return true;

  const message = isLate && replacesFile
    ? '当前已超过截止时间，并且新文件会替换上一次提交的文件。本次提交会被标记为“迟交”，老师可以看到。'
    : isLate && appendMode
      ? '当前已超过作业截止时间。本次重新提交的文件会作为补充保留，不会被覆盖。提交会被标记为“迟交”，老师可以看到。'
      : isLate
        ? '当前已超过作业截止时间。本次提交仍会被接收，但系统会明确标记为“迟交”，老师可以看到该状态。'
        : appendMode
          ? '本次重新提交的文件会作为补充保留，不会覆盖原文件，老师下载时会统一打包。'
          : '本次重新提交会替换上一次提交的文件，旧文件将不再保留。';
  const title = isLate ? '迟交提醒' : '提交方式确认';

  try {
    await ElMessageBox.confirm(
      message,
      title,
      {
        type: 'warning',
        confirmButtonText: isLate ? '仍要提交' : '确认替换',
        cancelButtonText: '暂不提交'
      }
    );
    return true;
  } catch {
    return false;
  }
}

async function submit() {
  if (!file.value && !content.value.trim()) {
    ElMessage.warning('请选择文件或填写在线作答内容');
    return;
  }
  if (!(await confirmSubmission())) return;

  if (file.value && assignment.value.max_file_mb && file.value.size > assignment.value.max_file_mb * 1024 * 1024) {
    ElMessage.warning(`该作业限制单文件不超过 ${fileSizeLabel.value}`);
    return;
  }

  loading.value = true;
  const formData = new FormData();
  if (file.value) formData.append('file', file.value);
  formData.append('content', content.value);

  try {
    const response = await api.post(`/assignments/${route.params.id}/submit`, formData, { timeout: 0 });
    await ElMessageBox.alert(
      response.data.is_late ? '已经提交成功。本次提交已超过截止时间，系统已标记为“迟交”，老师可以看到。' : '已经提交成功。',
      '提交成功',
      { type: 'success', confirmButtonText: '好的' }
    );
    file.value = null;
    await load();
  } catch (error) {
    ElMessage.error(messageOf(error));
  } finally {
    loading.value = false;
  }
}

async function showHistory() {
  if (!submission.value) return;
  try {
    history.value = (await api.get(`/submissions/${submission.value.id}/history`)).data;
    historyDialog.value = true;
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

onMounted(() => {
  load();
  clockTimer = window.setInterval(() => {
    currentTime.value = serverClock();
  }, 60_000);
});

onUnmounted(() => window.clearInterval(clockTimer));
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <el-button text @click="router.push(`/student/courses/${assignment.course_id || ''}`)">← 课程作业</el-button>
        <h1>{{ assignment.title || '作业详情' }}</h1>
        <p>{{ assignment.course_name }} · 截止 {{ assignment.deadline || '不限' }}</p>
      </div>
      <el-button v-if="submission" @click="showHistory">提交历史</el-button>
    </div>

    <el-alert
      v-if="deadline.kind === 'warning'"
      :title="deadline.text"
      description="请尽快完成并提交，避免网络或文件上传耗时造成迟交。"
      type="warning"
      show-icon
      :closable="false"
      style="margin-bottom: 18px"
    />
    <el-alert
      v-else-if="deadline.kind === 'late'"
      title="作业已超过截止时间"
      description="你仍然可以提交，但本次提交会被标记为迟交，老师可以看到。"
      type="error"
      show-icon
      :closable="false"
      style="margin-bottom: 18px"
    />

    <div class="detail-grid">
      <section class="panel">
        <span class="badge">{{ assignment.type === 'online' ? '在线作答' : '文件作业' }}</span>
        <h2>作业要求</h2>
        <p style="white-space: pre-wrap; line-height: 1.8; color: #566e69">
          {{ assignment.description || '老师暂未填写详细要求。' }}
        </p>
        <el-divider />
        <p class="hint">
          满分 {{ assignment.total_score }} · 允许重交
          {{ assignment.allow_resubmit_count === -1 ? '不限' : `${assignment.allow_resubmit_count}次` }}
          <template v-if="assignment.type !== 'online'"> · 单文件不超过 {{ fileSizeLabel }}</template>
        </p>
      </section>

      <aside class="panel" :class="{ 'late-submit-panel': deadline.kind === 'late' }">
        <template v-if="submission">
          <el-alert
            v-if="submission.status === 'returned'"
            title="作业被退回"
            type="warning"
            :description="submission.returned_reason"
            show-icon
            :closable="false"
          />
          <el-alert
            v-else
            :title="submission.status === 'graded' ? '老师已完成批改' : '已成功提交'"
            :type="submission.status === 'graded' ? 'success' : 'info'"
            :closable="false"
          />
          <div style="margin: 16px 0" class="hint">
            最近提交：{{ submission.submitted_at }}<br>
            文件：{{ submission.file_name || '在线作答' }}<br>
            提交次数：{{ submission.submit_count }}
            <span v-if="submission.is_late" class="late"> · 迟交</span>
          </div>
        </template>

        <h3>{{ submission ? '重新提交' : '提交作业' }}</h3>
        <el-alert
          v-if="submission?.file_name && assignment.type !== 'online'"
          :title="assignment.submission_mode === 'append' ? '重新提交的文件会作为补充保留，不会覆盖原文件' : '重新提交的新文件会替换上一次文件'"
          type="warning"
          show-icon
          :closable="false"
          style="margin-bottom: 14px"
        />
        <el-input
          v-if="assignment.type === 'online'"
          v-model="content"
          type="textarea"
          :rows="8"
          placeholder="在此输入作答内容"
        />
        <template v-else>
          <input id="file" type="file" hidden @change="onFileChange">
          <label
            for="file"
            style="display: block; border: 1px dashed #9bb8b2; border-radius: 14px; padding: 30px 15px; text-align: center; cursor: pointer; background: #f7fbf9"
          >
            <b>{{ file ? file.name : '点击选择文件' }}</b><br>
            <span class="hint">单文件不超过 {{ fileSizeLabel }}，支持文档、图片、视频、设计源文件和压缩包</span><br>
            <span class="hint">提交后将自动规范命名为：姓名_学号.扩展名</span>
          </label>
        </template>

        <el-button
          :type="deadline.kind === 'late' ? 'danger' : 'primary'"
          :color="deadline.kind === 'late' ? '' : '#15554e'"
          size="large"
          style="width: 100%; margin-top: 16px"
          :loading="loading"
          @click="submit"
        >
          {{ deadline.kind === 'late' ? '仍要迟交' : '确认提交' }}
        </el-button>
        <p class="hint">提交时间和迟交状态以服务器记录为准。</p>
      </aside>
    </div>

    <el-dialog v-model="historyDialog" title="提交历史" width="min(620px,94vw)">
      <el-timeline>
        <el-timeline-item
          v-for="item in history"
          :key="item.id"
          :timestamp="item.submitted_at"
          placement="top"
        >
          <b>{{ item.file_name || '在线作答' }}</b>
          <span v-if="item.is_late" class="late"> · 迟交</span>
          <p v-if="item.content" class="hint">{{ item.content }}</p>
        </el-timeline-item>
      </el-timeline>
    </el-dialog>
  </div>
</template>
