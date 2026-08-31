<script setup>
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useUpload } from '../../composables/useUpload.js';
import { useRefresh } from '../../composables/useRefresh.js';
import api, { messageOf } from '../../api/request.js';
import { downloadBlob, formatFileSize } from '../../utils/files.js';

const props = defineProps({ courseId: { type: [String, Number], required: true },readonly:Boolean });
const materials = ref([]);
const dialog = ref(false);
const editId = ref(null);
const form = ref({ title: '', description: '', file: null });
const uploading = ref(false);
const upload=useUpload(),{percent,state,busy,loaded,total}=upload;
const readers=ref([]),readersDialog=ref(false);
async function showReaders(m){try{readers.value=(await api.get('/materials/'+m.id+'/downloads')).data;readersDialog.value=true;}catch(e){ElMessage.error(messageOf(e));}}

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
    await upload.run({url:editId.value?`/materials/${editId.value}`:`/courses/${props.courseId}/materials`,method:editId.value?'put':'post',statusUrl:editId.value?`/materials/${editId.value}/upload-status/`:`/courses/${props.courseId}/material-upload-status/`,fields:{title:form.value.title,description:form.value.description},file:form.value.file});
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
    const response = await api.get(`/materials/${m.id}/file`, { responseType: 'blob',timeout:0 });
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

useRefresh(load);
</script>

<template>
  <div>
    <div class="toolbar">
      <el-button type="primary" color="#15554e" :disabled="readonly" @click="open()">上传资料</el-button>
      <span class="hint">支持文档、图片、视频、设计源文件和压缩包</span>
    </div>
    <el-table v-if="materials.length" :data="materials" stripe border>
      <el-table-column prop="title" label="标题" min-width="180" />
      <el-table-column prop="file_name" label="文件" min-width="220" />
      <el-table-column label="大小" width="100">
        <template #default="{ row }">{{ formatFileSize(row.file_size) }}</template>
      </el-table-column>
      <el-table-column prop="download_count" label="学生下载次数" width="130" />
      <el-table-column prop="created_at" label="上传时间" width="180" />
      <el-table-column label="操作" width="250">
        <template #default="{ row }">
          <el-button link @click="showReaders(row)">下载名单</el-button><el-button link type="primary" @click="download(row)">下载</el-button>
          <el-button link :disabled="readonly" @click="open(row)">编辑</el-button>
          <el-button link type="danger" :disabled="readonly" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
    <div v-else class="empty">还没有上传学习资料。</div>

    <el-dialog v-model="dialog" :title="editId ? '编辑资料' : '上传资料'" width="min(520px, 92vw)">
      <el-form label-position="top" :disabled="busy">
        <el-form-item label="标题">
          <el-input v-model="form.title" />
        </el-form-item>
        <el-form-item label="说明（可选）">
          <el-input v-model="form.description" type="textarea" :rows="3" />
        </el-form-item>
        <el-form-item label="文件">
          <input :disabled="busy" id="material-file" type="file" hidden @change="form.file = $event.target.files[0]">
          <label
            for="material-file"
            style="display: block; border: 1px dashed #9bb8b2; border-radius: 12px; padding: 18px; text-align: center; cursor: pointer; background: #f7fbf9"
          >
            <b>{{ form.file ? form.file.name : (editId ? '不更换文件（如需要请重新选择）' : '点击选择文件') }}</b>
          </label>
        </el-form-item>
      </el-form>
      <el-progress v-if="state" :percentage="percent" :indeterminate="!total&&busy"/><p v-if="state" class="hint">已传 {{(loaded/1024/1024).toFixed(1)}} MB / {{total?(total/1024/1024).toFixed(1)+' MB':'总大小待确认'}}</p><p role="status">{{state}}</p>
      <template #footer>
        <el-button :disabled="busy" @click="dialog = false">关闭</el-button><el-button v-if="busy" @click="upload.cancel">取消等待并查询</el-button>
        <el-button type="primary" color="#15554e" :loading="uploading" @click="save">保存</el-button>
      </template>
    </el-dialog>
    <el-dialog v-model="readersDialog" title="学生下载名单" width="min(780px,94vw)"><el-table :data="readers"><el-table-column prop="username" label="账号"/><el-table-column prop="name" label="姓名"/><el-table-column prop="download_count" label="完整下载次数"/><el-table-column prop="first_downloaded_at" label="首次下载"/><el-table-column prop="last_downloaded_at" label="最近下载"/></el-table></el-dialog>
  </div>
</template>
