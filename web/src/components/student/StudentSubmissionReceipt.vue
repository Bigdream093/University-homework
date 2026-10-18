<script setup>
import { normalizeSubmissionFileName } from '../../utils/submissionFiles.js'

defineProps({
  modelValue: { type: Boolean, default: false },
  receipt: { type: Object, default: null },
  requirePreview: { type: Boolean, default: false },
})

defineEmits(['update:modelValue', 'show-history', 'return-to-course'])
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="提交成功"
    width="min(480px,92vw)"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <template v-if="receipt">
      <p class="hint" style="margin-top: 0">回执编号：{{ receipt.receipt_no }}</p>
      <div class="receipt-grid">
        <span>提交时间</span><b>{{ receipt.submitted_at }}</b> <span>状态</span
        ><b :class="receipt.is_late ? 'late' : ''">{{
          receipt.is_late ? '迟交（老师可见）' : '准时'
        }}</b>
        <span>源文件</span><b>{{ normalizeSubmissionFileName(receipt.file_name) || '在线作答' }}</b>
        <template v-if="requirePreview"
          ><span>预览图</span><b>{{ receipt.preview_count }} 张</b></template
        >
        <span>提交次数</span><b>第 {{ receipt.submit_count }} 次</b>
      </div>
      <el-alert
        v-if="receipt.is_late"
        title="本次提交已超过截止时间，系统已标记为迟交，老师可以看到。"
        type="warning"
        show-icon
        :closable="false"
        style="margin-top: 12px"
      />
      <p class="hint" style="margin-bottom: 0">
        可在"历史与回执"中查看本次回执；如作业被退回，可查看退回原因。
      </p>
    </template>
    <template #footer>
      <el-button @click="$emit('update:modelValue', false)">关闭</el-button>
      <el-button @click="$emit('show-history')">查看本次提交</el-button>
      <el-button type="primary" color="#15554e" @click="$emit('return-to-course')">
        返回课程
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.receipt-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 8px 18px;
  margin: 12px 0;
}
.receipt-grid span {
  color: #7d8d89;
}
</style>
