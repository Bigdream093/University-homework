<script setup>
defineProps({
  submission: { type: Object, required: true },
  context: { type: Object, required: true },
  canSubmit: { type: Boolean, required: true },
  blockReason: { type: String, default: '' },
})

defineEmits(['edit'])
</script>

<template>
  <div class="submission-overview">
    <el-alert
      v-if="submission.status === 'returned'"
      title="作业已退回，请根据老师意见修改后重新提交。"
      type="warning"
      :description="submission.returned_reason || '老师未填写退回原因。'"
      show-icon
      :closable="false"
    />
    <el-alert
      v-else
      :title="submission.status === 'graded' ? '老师已完成批改' : '作业已提交，等待老师批改'"
      :type="submission.status === 'graded' ? 'success' : 'info'"
      :closable="false"
    />
    <dl class="submission-meta">
      <div>
        <dt>最近提交</dt>
        <dd>
          {{ submission.submitted_at || '—' }}
          <span v-if="submission.is_late" class="late">（迟交）</span>
        </dd>
      </div>
      <div v-if="context.group">
        <dt>实际提交人</dt>
        <dd>{{ submission.submitted_by_name }}（{{ submission.submitted_by_username }}）</dd>
      </div>
    </dl>
    <div v-if="submission.status !== 'graded'" class="submission-overview-actions">
      <el-button type="primary" color="#15554e" :disabled="!canSubmit" @click="$emit('edit')">
        {{ submission.status === 'returned' ? '修改并重新提交' : '修改提交' }}
      </el-button>
    </div>
    <p v-if="!canSubmit" class="hint block-reason">{{ blockReason }}</p>
  </div>
</template>

<style scoped>
.submission-overview {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.submission-meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 18px;
  margin: 0;
}
.submission-meta dt {
  margin-bottom: 3px;
  color: #7d8d89;
  font-size: 12px;
}
.submission-meta dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.submission-overview-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.submission-overview-actions .el-button {
  margin: 0;
}
.block-reason {
  margin: -4px 0 0;
}
</style>
