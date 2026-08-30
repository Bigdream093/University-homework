<script setup>
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import api, { messageOf } from '../../api/request.js';

const props = defineProps({ courseId: { type: [String, Number], required: true } });
const notices = ref([]);

async function load() {
  try {
    notices.value = (await api.get(`/courses/${props.courseId}/notices`)).data;
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div v-if="notices.length">
      <article v-for="n in notices" :key="n.id" class="assignment-card">
        <span v-if="n.pinned" class="badge" style="background: #e6a23c">置顶</span>
        <h3>{{ n.title }}</h3>
        <p style="white-space: pre-wrap; line-height: 1.8; color: #566e69">{{ n.content }}</p>
        <span class="hint">发布于 {{ n.created_at }}</span>
      </article>
    </div>
    <div v-else class="empty">老师还没有发布通知。</div>
  </div>
</template>
