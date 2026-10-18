<script setup>
import PreviewGallery from './PreviewGallery.vue'
defineProps({
  modelValue: Boolean,
  previews: { type: Array, default: () => [] },
  title: { type: String, default: '作业预览图' },
  initialIndex: { type: Number, default: 0 },
})
defineEmits(['update:modelValue'])
</script>
<template>
  <el-dialog
    :model-value="modelValue"
    :title="title"
    width="min(1500px,96vw)"
    top="3vh"
    append-to-body
    destroy-on-close
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <PreviewGallery v-if="modelValue" :previews="previews" :initial-index="initialIndex" />
  </el-dialog>
</template>
