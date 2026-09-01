<script setup>
import { onMounted, ref, nextTick } from 'vue';
import { ElMessage } from 'element-plus';
import { useRefresh } from '../../composables/useRefresh.js';
import api, { messageOf } from '../../api/request.js';
const props = defineProps({ courseId: { type: [String, Number], required: true } });
const emit=defineEmits(['read']);
const notices = ref([]), detail = ref(null), dialog = ref(false);
let openSequence = 0,loadSequence=0;
async function load() { const sequence=++loadSequence,courseId=props.courseId;try { const data=(await api.get(`/courses/${courseId}/notices`)).data;if(sequence===loadSequence)notices.value=data; } catch (error) { if(sequence===loadSequence)ElMessage.error(messageOf(error)); } }
async function open(item) { const sequence=++openSequence;try { const d=(await api.get(`/notices/${item.id}`)).data;if(sequence!==openSequence)return;detail.value=d;dialog.value=true;await nextTick();if(sequence!==openSequence)return;if(d.status==='published'){await api.post(`/notices/${item.id}/read`,{revision:d.content_revision});if(sequence!==openSequence)return;await load();emit('read');} } catch (error) { if(sequence===openSequence)ElMessage.error(messageOf(error)); } }
useRefresh(load);
</script>
<template>
  <div>
    <div v-if="notices.length">
      <article v-for="n in notices" :key="n.id" class="assignment-card" style="cursor:pointer" @click="open(n)">
        <span v-if="n.pinned" class="badge" style="background:#e6a23c">置顶</span>
        <span v-if="n.status==='published'&&!n.is_read" class="badge">未读</span>
        <span v-if="n.is_updated" class="badge" style="background:#409eff">已更新</span>
        <h3>{{ n.title }}</h3><p>{{ n.content_preview }}</p>
        <span class="hint">{{ n.status === 'withdrawn' ? `撤回于 ${n.withdrawn_at}` : `发布于 ${n.published_at || n.created_at}` }}</span>
      </article>
    </div><div v-else class="empty">老师还没有发布通知。</div>
    <el-dialog v-model="dialog" :title="detail?.title" width="min(640px,92vw)">
      <el-alert v-if="detail?.status==='withdrawn'" title="该通知已被教师撤回" type="warning" :description="`撤回时间：${detail.withdrawn_at}`" show-icon :closable="false" />
      <p v-if="detail?.status==='published'" class="hint">计划：{{detail.scheduled_at||'立即发布'}} · 实际发布：{{detail.published_at}} · 修改：{{detail.updated_at}}</p>
      <p v-if="detail?.status==='published'" style="white-space:pre-wrap;line-height:1.8;color:#566e69">{{ detail?.content }}</p>
    </el-dialog>
  </div>
</template>
