<script setup>
defineProps({
  modelValue: Boolean,
  draft: { type: Object, required: true },
  weightRows: { type: Array, required: true },
  weightSum: Number,
  dailyTarget: Number,
  weightsMatch: Boolean,
  finalAssignment: { type: Object, default: null },
  readonly: Boolean,
})
const emit = defineEmits(['update:modelValue', 'weight', 'distribute'])
</script>
<template>
  <el-dialog
    :model-value="modelValue"
    @update:model-value="emit('update:modelValue', $event)"
    title="成绩占比设置（平时作业）"
    width="min(560px,94vw)"
  >
    <p class="hint" style="margin-top: 0">
      每项填该作业占总成绩的百分比；为 0 表示该作业不计入成绩。各项之和必须等于上方「平时占比」，
      例如平时占比 30%、三次作业各占 10%。总成绩 = Σ(作业折算分×占比) + 期末折算分×期末占比。
    </p>
    <el-table :data="weightRows" size="small" max-height="420">
      <el-table-column prop="title" label="作业" min-width="200">
        <template #default="{ row }">
          {{ row.title }}
          <el-tag v-if="row.status === 'draft'" size="small" type="warning">草稿</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="total_score" label="满分" width="80" align="center" />
      <el-table-column label="占总成绩 %" width="160" align="center">
        <template #default="{ row }">
          <el-input-number
            :model-value="draft.weights[row.id]"
            @update:model-value="emit('weight', row.id, $event)"
            :min="0"
            :max="100"
            :step="1"
            :precision="1"
            :disabled="readonly"
            style="width: 130px"
          />
        </template>
      </el-table-column>
    </el-table>
    <p class="hint" :class="{ 'sum-mismatch': !weightsMatch }">
      平时合计 {{ weightSum }}%<span v-if="weightsMatch"
        >，与平时占比（{{ dailyTarget }}%）一致</span
      ><span v-else> ，与平时占比（{{ dailyTarget }}%）不一致，调整一致后才能保存</span>
    </p>
    <p v-if="finalAssignment" class="hint">
      期末作业「{{ finalAssignment.title }}」单独作为期末成绩（占
      {{ draft.final_ratio }}%），不参与占比设置。
    </p>
    <template #footer>
      <el-button :disabled="readonly" @click="emit('distribute')">平均分配</el-button>
      <el-button type="primary" color="#15554e" @click="emit('update:modelValue', false)"
        >完成</el-button
      >
    </template>
  </el-dialog>
</template>
<style scoped>
.sum-mismatch {
  color: #a43f35;
}
</style>
