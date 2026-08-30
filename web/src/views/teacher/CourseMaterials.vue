<script setup>
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import api, { messageOf } from '../../api/request.js';
import { downloadBlob, formatFileSize } from '../../utils/files.js';

const props = defineProps({ courseId: { type: [String, Number], required: true } });
const materials = ref([]);
const dialog = ref(false);
const editId = ref(null);
const form = ref({ title: '', description: '', file: null });
const uploading = ref(false);

async function load() {
  try {
    materials.value = (await api.get(`/courses/${props.courseId}/materials`)).data;
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

function open(m) {
  editId.value = m?.id || null;
  form.value = { title: m?.title || '', description: m?.description || '', file: null };
  dialog.value = true;
}

async function save() {
  if (!form.value.title.trim()) {
    ElMessage.warning('请填写资料标题');
    return;
  }
  if (!editId.value && !form.value.file) {
    ElMessage.warning('请选择要上传的资料文件');
    return;
  }
  uploading.value = true;
  try {
    const fd = new FormData();
    fd.append('title', form.value.title);
    fd.append('description', form.value.description);
    if (form.value.file) fd.append('file', form.value.file);
    if (editId.value) await api.put(`/materials/${editId.value}`, fd);
    else await api.post(`/courses/${props.courseId}/materials`, fd);
    dialog.value = false;
    ElMessage.success(editId.value ? '资料已更新' : '资料已上传');
    load();
  } catch (error) {
    ElMessage.error(messageOf(error));
  } finally {
    uploading.value = false;
  }
}

async function download(m) {
  try {
    const response = await api.get(`/materials/${m.id}/file`, { responseType: 'blob' });
    downloadBlob(response.data, m.file_name || '资料');
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

async function remove(m) {
  try {
    await ElMessageBox.confirm(`确定删除资料「${m.title}」？删除后文件将一并移除。`, '确认', { type: 'warning' });
    await api.delete(`/materials/${m.id}`);
    ElMessage.success('资料已删除');
    load();
  } catch (error) {
    if (error !== 'cancel') ElMessage.error(messageOf(error));
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="toolbar">
      <el-button type="primary" color="#15554e" @click="open()">上传资料</el-button>
      <span class="hint">支持文档、图片、视频、设计源文件和压缩包</span>
    </div>
    <el-table v-if="materials.length" :data="materials" stripe border>
      <el-table-column prop="title" label="标题" min-width="180" />
      <el-table-column prop="file_name" label="文件" min-width="220" />
      <el-table-column label="大小" width="100">
        <template #default="{ row }">{{ formatFileSize(row.file_size) }}</template>
      </el-table-column>
      <el-table-column prop="created_at" label="上传时间" width="180" />
      <el-table-column label="操作" width="170">
        <template #default="{ row }">
          <el-button link type="primary" @click="download(row)">下载</el-button>
          <el-button link @click="open(row)">编辑</el-button>
          <el-button link type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
    <div v-else class="empty">还没有上传学习资料。</div>

    <el-dialog v-model="dialog" :title="editId ? '编辑资料' : '上传资料'" width="min(520px, 92vw)">
      <el-form label-position="top">
        <el-form-item label="标题">
          <el-input v-model="form.title" />
        </el-form-item>
        <el-form-item label="说明（可选）">
          <el-input v-model="form.description" type="textarea" :rows="3" />
        </el-form-item>
        <el-form-item label="文件">
          <input id="material-file" type="file" hidden @change="form.file = $event.target.files[0]">
          <label
            for="material-file"
            style="display: block; border: 1px dashed #9bb8b2; border-radius: 12px; padding: 18px; text-align: center; cursor: pointer; background: #f7fbf9"
          >
            <b>{{ form.file ? form.file.name : (editId ? '不更换文件（如需要请重新选择）' : '点击选择文件') }}</b>
          </label>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" color="#15554e" :loading="uploading" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
