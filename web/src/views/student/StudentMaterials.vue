<script setup>
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import api, { messageOf } from '../../api/request.js';
import { downloadBlob, formatFileSize } from '../../utils/files.js';

const props = defineProps({ courseId: { type: [String, Number], required: true } });
const materials = ref([]);

async function load() {
  try {
    materials.value = (await api.get(`/courses/${props.courseId}/materials`)).data;
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

async function download(m) {
  try {
    const response = await api.get(`/materials/${m.id}/file`, { responseType: 'blob',timeout:0 });
    downloadBlob(response.data, m.file_name || '资料');
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

onMounted(load);
</script>

<template>
  <div>
    <el-table v-if="materials.length" :data="materials" stripe border>
      <el-table-column prop="title" label="标题" min-width="180" />
      <el-table-column prop="file_name" label="文件" min-width="220" />
      <el-table-column label="大小" width="100">
        <template #default="{ row }">{{ formatFileSize(row.file_size) }}</template>
      </el-table-column>
      <el-table-column prop="download_count" label="下载次数" width="100" />
      <el-table-column prop="created_at" label="上传时间" width="180" />
      <el-table-column label="操作" width="100">
        <template #default="{ row }">
          <el-button link type="primary" @click="download(row)">下载</el-button>
        </template>
      </el-table-column>
    </el-table>
    <div v-else class="empty">老师还没有上传学习资料。</div>
  </div>
</template>
