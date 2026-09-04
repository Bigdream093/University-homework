<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import api, { messageOf } from '../../api/request.js'
import { formatFileSize } from '../../utils/files.js'
import { useDownload } from '../../composables/useDownload.js'
import DownloadTask from '../../components/DownloadTask.vue'

const props = defineProps({ courseId: { type: [String, Number], required: true } })
const materials = ref([])
const downloadTask = useDownload()
const canOpenDownloads = Boolean(window.mohenDesktop?.openDownloadsFolder)

async function load() {
  try {
    materials.value = (await api.get(`/courses/${props.courseId}/materials`)).data
  } catch (error) {
    ElMessage.error(messageOf(error))
  }
}

async function downloadMaterial(material) {
  await downloadTask.start({
    endpoint: `/api/materials/${material.id}/file`,
    ticket: { kind: 'material', id: material.id },
    fileName: material.file_name || '资料',
    fileSize: material.file_size || 0,
  })
}

async function openDownloaded() {
  try {
    await window.mohenDesktop.openDownloadsFolder()
  } catch (error) {
    ElMessage.error(error?.message || '无法打开下载文件夹，请从系统文件管理器中打开“下载”目录')
  }
}

onMounted(load)
</script>

<template>
  <div>
    <div v-if="canOpenDownloads" class="material-toolbar">
      <el-button type="primary" plain @click="openDownloaded">查看已下载</el-button>
    </div>
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
          <el-button
            link
            type="primary"
            @click="downloadMaterial(row)"
            >下载</el-button
          >
        </template>
      </el-table-column>
    </el-table>
    <div v-else class="empty">老师还没有上传学习资料。</div>
    <DownloadTask
      :tasks="downloadTask.tasks.value"
      @pause="downloadTask.pause"
      @resume="downloadTask.resume"
      @cancel="downloadTask.cancel"
      @open-folder="downloadTask.openFolder"
      @dismiss="downloadTask.dismiss"
    />
  </div>
</template>

<style scoped>
.material-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 12px;
}
</style>
