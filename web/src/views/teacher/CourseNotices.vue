<script setup>
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import api, { messageOf } from '../../api/request.js';

const props = defineProps({ courseId: { type: [String, Number], required: true } });
const notices = ref([]);
const dialog = ref(false);
const editId = ref(null);
const form = ref({ title: '', content: '', pinned: false, status: 'draft' });

async function load() {
  try {
    notices.value = (await api.get(`/courses/${props.courseId}/notices`)).data;
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

function open(n) {
  editId.value = n?.id || null;
  form.value = n
    ? { title: n.title, content: n.content, pinned: Boolean(n.pinned), status: n.status }
    : { title: '', content: '', pinned: false, status: 'draft' };
  dialog.value = true;
}

async function save() {
  if (!form.value.title.trim()) {
    ElMessage.warning('请填写通知标题');
    return;
  }
  try {
    if (editId.value) await api.put(`/notices/${editId.value}`, form.value);
    else await api.post(`/courses/${props.courseId}/notices`, form.value);
    dialog.value = false;
    ElMessage.success(editId.value ? '通知已更新' : '通知已保存');
    load();
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

async function remove(n) {
  try {
    await ElMessageBox.confirm(`确定删除通知「${n.title}」？`, '确认', { type: 'warning' });
    await api.delete(`/notices/${n.id}`);
    ElMessage.success('通知已删除');
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
      <el-button type="primary" color="#15554e" @click="open()">发布通知</el-button>
      <span class="hint">草稿学生不可见，发布后学生在课程通知页查看</span>
    </div>
    <div v-if="notices.length">
      <article v-for="n in notices" :key="n.id" class="assignment-card">
        <div style="display: flex; justify-content: space-between; gap: 20px">
          <div>
            <span v-if="n.pinned" class="badge" style="background: #e6a23c">置顶</span>
            <span class="badge">{{ n.status === 'published' ? '已发布' : '草稿' }}</span>
            <h3>{{ n.title }}</h3>
            <p style="white-space: pre-wrap; line-height: 1.8; color: #566e69">{{ n.content || '暂无内容' }}</p>
            <span class="hint">{{ n.created_at }}</span>
          </div>
          <div class="assignment-actions">
            <el-button @click="open(n)">编辑</el-button>
            <el-button type="danger" text @click="remove(n)">删除</el-button>
          </div>
        </div>
      </article>
    </div>
    <div v-else class="empty">还没有通知，发布后学生可见。</div>

    <el-dialog v-model="dialog" :title="editId ? '编辑通知' : '发布通知'" width="min(560px, 92vw)">
      <el-form label-position="top">
        <el-form-item label="标题">
          <el-input v-model="form.title" />
        </el-form-item>
        <el-form-item label="内容">
          <el-input v-model="form.content" type="textarea" :rows="6" placeholder="输入通知内容" />
        </el-form-item>
        <el-form-item label="发布方式">
          <el-radio-group v-model="form.status">
            <el-radio value="draft">存为草稿（学生不可见）</el-radio>
            <el-radio value="published">立即发布（学生可见）</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item>
          <el-checkbox v-model="form.pinned">置顶显示</el-checkbox>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" color="#15554e" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
