<script setup>
defineProps({
  label: { type: String, required: true },
  deadline: { type: String, default: '' },
  assignmentTitle: { type: String, default: '' },
})
</script>

<template>
  <section class="student-deadline-card" :aria-label="label">
    <p class="deadline-label">{{ label }}</p>
    <time
      v-if="deadline"
      :datetime="deadline.replace(' ', 'T') + '+08:00'"
      class="deadline-value"
      >{{ deadline }}</time
    >
    <p v-else class="deadline-empty">暂无截止时间</p>
    <p v-if="assignmentTitle" class="deadline-assignment">{{ assignmentTitle }}</p>
  </section>
</template>

<style scoped>
.student-deadline-card {
  margin-bottom: 24px;
  padding: 8px 0;
  width: fit-content;
  max-width: 100%;
  text-align: left;
  background: transparent;
}
.deadline-label {
  margin: 0 0 6px;
  color: #59736a;
  font-size: 13px;
}
.deadline-value {
  display: block;
  color: var(--green);
  font-size: clamp(18px, 2vw, 22px);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.35;
  letter-spacing: 0;
}
.deadline-empty {
  margin: 0;
  color: #59736a;
  font-size: 18px;
}
.deadline-assignment {
  margin: 10px 0 0;
  color: #59736a;
  font-size: 13px;
  overflow-wrap: anywhere;
}
</style>
