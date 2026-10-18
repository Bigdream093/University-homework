<script setup>
import { computed } from 'vue'
import {
  requiredQuestions,
  requiredAnswerValues,
} from '@university-homework/domain/requiredAnswers'
const props = defineProps({
  questions: String,
  content: String,
  showAnswers: { type: Boolean, default: true },
})
const items = computed(() => requiredQuestions(props.questions))
const answers = computed(() => requiredAnswerValues(props.questions, props.content))
</script>
<template>
  <div class="required-answer-display">
    <section v-for="(question, index) in items" :key="question.id" class="answer-item">
      <b class="question-label">必答题目 {{ index + 1 }}</b>
      <p class="question-text">{{ question.title }}</p>
      <div v-if="question.guidance" class="guidance">
        <span class="guidance-label">答题规范</span>
        <p>{{ question.guidance }}</p>
      </div>
      <div v-if="showAnswers" class="student-answer">
        <span class="guidance-label">学生答案</span>
        <p>{{ answers[question.id] || '（未填写）' }}</p>
      </div>
    </section>
    <p v-if="!items.length && showAnswers && content">{{ content }}</p>
  </div>
</template>
<style scoped>
.required-answer-display {
  margin: 16px 0;
  color: var(--ink);
  font-size: 14px;
  line-height: 1.75;
  overflow-wrap: anywhere;
}
.answer-item {
  padding: 16px 0;
  border-top: 1px solid var(--line);
}
.answer-item:last-child {
  padding-bottom: 0;
}
.question-label {
  color: #526f65;
  font-size: 14px;
  font-weight: 600;
}
p {
  margin: 0;
  white-space: pre-wrap;
}
.question-text {
  margin-top: 8px;
  font-size: 15px;
}
.guidance,
.student-answer {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  align-items: baseline;
  gap: 12px;
  margin-top: 10px;
}
.guidance-label {
  color: #71847d;
  font-size: 13px;
}
.guidance p {
  color: #526f65;
}
@media (max-width: 600px) {
  .guidance,
  .student-answer {
    grid-template-columns: minmax(0, 1fr);
    gap: 4px;
  }
}
</style>
