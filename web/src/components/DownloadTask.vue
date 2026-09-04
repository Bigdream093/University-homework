<script setup>
import { formatFileSize } from '../utils/files.js'

defineProps({ tasks: { type: Array, default: () => [] } })
defineEmits(['pause', 'resume', 'cancel', 'open-folder', 'dismiss'])
const labels = {
  starting: '准备下载',
  preparing: '正在整理文件',
  downloading: '正在下载',
  pausing: '正在暂停',
  paused: '已暂停',
  failed: '下载失败',
  completed: '下载完成',
  cancelling: '正在取消',
  cancelled: '下载已取消',
}
</script>

<template>
  <div v-if="tasks.length" class="download-tasks">
    <div
      v-for="task in tasks"
      :key="task.requestId"
      class="download-task"
      role="status"
      aria-live="polite"
    >
      <div class="download-task__head">
        <span
          ><b>{{ labels[task.state] || '下载任务' }}</b
          >：{{ task.fileName }}</span
        >
        <div class="download-task__actions">
          <el-button
            v-if="task.state === 'downloading'"
            link
            @click="$emit('pause', task.requestId)"
            >暂停</el-button
          >
          <el-button
            v-if="task.state === 'paused'"
            link
            type="primary"
            @click="$emit('resume', task.requestId)"
            >继续</el-button
          >
          <el-button
            v-if="task.state === 'completed'"
            link
            type="primary"
            @click="$emit('open-folder', task.requestId)"
            >打开文件夹</el-button
          >
          <el-button
            v-if="task.state === 'completed'"
            link
            @click="$emit('dismiss', task.requestId)"
            >关闭</el-button
          >
          <el-button
            v-if="
              ['starting', 'preparing', 'downloading', 'pausing', 'paused'].includes(task.state)
            "
            link
            type="danger"
            @click="$emit('cancel', task.requestId)"
            >取消</el-button
          >
        </div>
      </div>
      <el-progress
        :percentage="task.total ? Math.min(100, Math.round((task.loaded / task.total) * 100)) : 0"
        :indeterminate="!task.total"
        :status="
          task.state === 'completed'
            ? 'success'
            : ['failed', 'cancelled'].includes(task.state)
              ? 'exception'
              : undefined
        "
      />
      <span class="hint"
        >{{ formatFileSize(task.loaded) || '0K' }} /
        {{ formatFileSize(task.total) || '大小待确认' }}</span
      >
      <p
        v-if="task.message"
        class="download-task__message"
        :class="{ 'is-error': ['failed', 'cancelled'].includes(task.state) }"
      >
        {{ task.message }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.download-tasks {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 2100;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(520px, calc(100vw - 48px));
  max-height: calc(100vh - 48px);
  overflow-y: auto;
}
.download-task {
  box-sizing: border-box;
  padding: 14px 16px;
  border: 1px solid #b8ccc6;
  border-radius: 8px;
  background: #f7fbf9;
  box-shadow: 0 8px 24px rgba(31, 49, 44, 0.18);
}
.download-task__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 8px;
}
.download-task__head span {
  min-width: 0;
  overflow-wrap: anywhere;
}
.download-task__actions {
  display: flex;
  align-items: center;
  flex: none;
}
.download-task__message {
  margin: 8px 0 0;
  color: #606266;
  overflow-wrap: anywhere;
}
.download-task__message.is-error {
  color: #a43f35;
}
@media (max-width: 640px) {
  .download-tasks {
    right: 12px;
    bottom: 12px;
    width: calc(100vw - 24px);
  }
  .download-task__head {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
  }
  .download-task__actions {
    flex-wrap: wrap;
  }
}
</style>
