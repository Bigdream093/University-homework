<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import api, { messageOf } from '../../api/request.js';
import { downloadBlob } from '../../utils/files.js';
import SubmissionRecords from '../../components/SubmissionRecords.vue';
import ExtensionsPanel from '../../components/ExtensionsPanel.vue';
import AssignmentGroups from '../../components/AssignmentGroups.vue';
import { readToken } from '../../utils/session.js';

const route = useRoute();
const router = useRouter();
const assignment = ref({});
const allRows = ref([]);
const filter = ref('all');
const keyword = ref('');
const dialog = ref(false);
const mode = ref('grade');
const current = ref({});
const bulkLoading = ref(false);
const form = reactive({ score: null, comment: '', returned_reason: '' });

const rows = computed(() => {
  const search = keyword.value.trim().toLowerCase();
  return allRows.value.filter(row => {
    const matchesSearch = !search || row.username.toLowerCase().includes(search) || row.name.toLowerCase().includes(search) || row.members?.some(m=>(m.name+' '+m.username).toLowerCase().includes(search));
    if (!matchesSearch) return false;
    if (filter.value === 'unsubmitted') return !row.id;
    if (filter.value === 'submitted') return row.id && row.status === 'submitted';
    if (filter.value === 'late') return row.is_late === 1;
    if (filter.value === 'returned') return row.status === 'returned';
    if (filter.value === 'graded') return row.status === 'graded';
    return true;
  });
});

const stats = computed(() => ({
  all: allRows.value.length,
  submitted: allRows.value.filter(row => row.id).length,
  unsubmitted: allRows.value.filter(row => !row.id).length,
  graded: allRows.value.filter(row => row.status === 'graded').length
}));

async function load() {
  try {
    const [assignmentResponse, submissionResponse] = await Promise.all([
      api.get(`/assignments/${route.params.id}`),
      api.get(`/assignments/${route.params.id}/submissions`)
    ]);
    assignment.value = assignmentResponse.data;
    allRows.value = submissionResponse.data;
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

function open(row, type) {
  current.value = row;
  mode.value = type;
  Object.assign(form, {
    score: row.score,
    comment: row.comment || '',
    returned_reason: row.returned_reason || ''
  });
  dialog.value = true;
}

async function save() {
  try {
    if (mode.value === 'grade') {
      await api.post(current.value.api_base+'/grade', { score: form.score, comment: form.comment });
    } else {
      await api.post(current.value.api_base+'/return', { returned_reason: form.returned_reason });
    }
    ElMessage.success(mode.value === 'grade' ? '批改已保存' : '作业已退回');
    dialog.value = false;
    await load();
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

function safeName(value) {
  return String(value || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
}

function fileNameFor(row, source) {
  const [datePart = '', timePart = ''] = String(source.submitted_at || '').split(' ');
  const [, month = '', day = ''] = datePart.split('-');
  const [hour = '', minute = ''] = timePart.split(':');
  const timestamp = `${month}-${day}-${hour}-${minute}`;
  const rawName = source.file_name || '';
  const dot = rawName.lastIndexOf('.');
  const extension = dot > 0 ? (rawName.slice(dot + 1) || 'bin') : 'txt';
  return `${safeName(row.name)}_${safeName(row.username)}_${timestamp}_${source.is_late ? '迟交' : '准时'}.${extension}`;
}

function bulkFileName(row) {
  return fileNameFor(row, row);
}

function rowFiles(row) {
  if (row.files?.length) return row.files;
  if (row.file_name) return [{ history_id: null, file_name: row.file_name, file_size: row.file_size, is_late: row.is_late, submitted_at: row.submitted_at }];
  return row.content ? [{ history_id: null, file_name: null, content: row.content, is_late: row.is_late, submitted_at: row.submitted_at }] : [];
}

async function downloadSingle(row, f) {
  const url = f.history_id ? `${row.api_base}/file?history_id=${f.history_id}` : `${row.api_base}/file`;
  const response = await api.get(url, { responseType: 'blob',timeout:0 });
  downloadBlob(response.data, fileNameFor(row, f));
}

async function download(row) {
  const files = rowFiles(row);
  if (!files.length) {
    ElMessage.warning('该学生没有可下载的文件');
    return;
  }
  for (const f of files) {
    try {
      await downloadSingle(row, f);
    } catch (error) {
      ElMessage.error(messageOf(error));
    }
    await new Promise(resolve => window.setTimeout(resolve, 150));
  }
}

function buildBulkEntries() {
  return allRows.value.filter(row=>row.id).flatMap(row=>rowFiles(row).map(f=>({url:f.file_name?`/api${row.api_base}/file${f.history_id?'?history_id='+f.history_id:''}`:null,fileName:fileNameFor(row,f),content:f.file_name?null:f.content||''})));
}

async function downloadInBrowser(entries) {
  await ElMessageBox.confirm(
    `浏览器将逐个下载 ${entries.length} 份作业到默认下载目录。若浏览器询问是否允许多个文件，请选择允许。`,
    '批量下载提示',
    { type: 'info', confirmButtonText: '开始下载', cancelButtonText: '取消' }
  );
  for (const entry of entries) {
    if (entry.url) {
      const response = await api.get(entry.url.replace('/api', ''), { responseType: 'blob',timeout:0 });
      downloadBlob(response.data, entry.fileName);
    } else {
      downloadBlob(new Blob([entry.content], { type: 'text/plain;charset=utf-8' }), entry.fileName);
    }
    await new Promise(resolve => window.setTimeout(resolve, 150));
  }
}

async function downloadAll() {
  bulkLoading.value = true;
  try {
    if (assignment.value.submission_mode === 'append') {
      const response = await api.get(`/assignments/${route.params.id}/package`, { responseType: 'blob',timeout:0 });
      downloadBlob(response.data, `${assignment.value.title}-全部作业.zip`);
      ElMessage.success(`已生成“${assignment.value.title}-全部作业.zip”压缩包`);
      return;
    }
    const entries = buildBulkEntries();
    if (window.mohenDesktop?.saveAssignmentFiles) {
      const result = await window.mohenDesktop.saveAssignmentFiles({
        assignmentTitle: assignment.value.title,
        token: readToken(),
        entries
      });
      if (result.failed.length) {
        ElMessage.warning(`已保存 ${result.saved} 份，${result.failed.length} 份失败；文件夹已打开`);
      } else {
        ElMessage.success(`已在桌面生成“${assignment.value.title}”文件夹，共 ${result.saved} 份作业`);
      }
    } else {
      await downloadInBrowser(entries);
      ElMessage.success(`已开始下载 ${entries.length} 份作业`);
    }
  } catch (error) {
    if (error !== 'cancel') ElMessage.error(error.message || messageOf(error));
  } finally {
    bulkLoading.value = false;
  }
}

async function exportExcel() {
  try {
    const response = await api.get(`/assignments/${route.params.id}/export`, { responseType: 'blob',timeout:0 });
    downloadBlob(response.data, `${assignment.value.title}-成绩表.xlsx`);
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <el-button text @click="router.push(`/teacher/courses/${assignment.course_id || ''}`)">← 返回课程</el-button>
        <h1>{{ assignment.title || '提交管理' }}</h1>
        <p>截止 {{ assignment.deadline || '不限' }} · 满分 {{ assignment.total_score }} · {{ assignment.submission_mode === 'append' ? '追加模式' : '覆盖模式' }}</p>
      </div>
      <div class="assignment-actions">
        <el-button @click="exportExcel">导出成绩表</el-button>
        <el-button
          type="primary"
          color="#15554e"
          :loading="bulkLoading"
          @click="downloadAll"
        >
          一键下载全部作业
        </el-button>
      </div>
    </div>

    <el-alert
      v-if="stats.unsubmitted > 0"
      :title="`还有 ${stats.unsubmitted} ${assignment.work_mode==='group'?'组':'名学生'}未提交`"
      type="warning"
      show-icon
      :closable="false"
      style="margin-bottom: 18px"
    />

    <p v-if="assignment.work_mode==='group'" class="hint">成员覆盖：{{allRows.reduce((sum,r)=>sum+(r.members?.length||0),0)}}人。以下提交统计以组为单位。</p>
    <div class="stat-strip">
      <div class="stat"><b>{{ stats.all }}</b><span>{{assignment.work_mode==='group'?'应交组数':'应交人数'}}</span></div>
      <div class="stat"><b>{{ stats.submitted }}</b><span>已提交</span></div>
      <div class="stat"><b>{{ stats.unsubmitted }}</b><span>未提交</span></div>
      <div class="stat"><b>{{ stats.graded }}</b><span>已评分</span></div>
    </div>

    <div class="panel">
      <div class="toolbar">
        <el-radio-group v-model="filter">
          <el-radio-button value="all">全部</el-radio-button>
          <el-radio-button value="unsubmitted">未交</el-radio-button>
          <el-radio-button value="submitted">待批改</el-radio-button>
          <el-radio-button value="late">迟交</el-radio-button>
          <el-radio-button value="returned">已退回</el-radio-button>
          <el-radio-button value="graded">已评分</el-radio-button>
        </el-radio-group>
        <el-input v-model="keyword" clearable placeholder="搜索学号或姓名" style="width: 220px" />
      </div>

      <el-table :data="rows" stripe border>
        <el-table-column prop="username" :label="assignment.work_mode==='group'?'小组':'学号'" width="150" />
        <el-table-column v-if="assignment.work_mode==='group'" label="固定成员" min-width="180"><template #default="{row}">{{row.members?.map(m=>m.name+'（'+m.username+'）').join('、')}}</template></el-table-column>
        <el-table-column prop="name" label="姓名" width="110" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag v-if="!row.id" type="info">未交</el-tag>
            <el-tag v-else :type="row.status === 'graded' ? 'success' : row.status === 'returned' ? 'warning' : ''">
              {{ ({ submitted: '待批改', graded: '已评分', returned: '已退回' })[row.status] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column v-if="assignment.work_mode==='group'" label="实际提交人" min-width="150"><template #default="{row}">{{row.submitted_by_name||'—'}} {{row.submitted_by_username||''}}</template></el-table-column>
        <el-table-column prop="submit_count" label="次数" width="70"/>
        <el-table-column prop="submitted_at" label="提交时间" min-width="190">
          <template #default="{ row }">
            <span :class="{ late: row.is_late }">{{ row.submitted_at || '—' }} {{ row.is_late ? '（迟交）' : '' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="文件" min-width="260">
          <template #default="{ row }">
            <template v-if="rowFiles(row).length">
              <div v-for="f in rowFiles(row)" :key="f.history_id || 'latest'" class="file-cell">
                <el-button link type="primary" @click="downloadSingle(row, f)">{{ f.file_name || '在线作答' }}</el-button>
                <span v-if="f.is_late" class="late"> · 迟交</span>
              </div>
            </template>
            <span v-else class="hint">—</span>
          </template>
        </el-table-column>
        <el-table-column prop="score" label="成绩" width="80" />
        <el-table-column label="操作" width="230">
          <template #default="{ row }">
            <template v-if="row.id">
              <el-button v-if="rowFiles(row).length" link @click="download(row)">下载</el-button>
              <SubmissionRecords :api-base="row.api_base"/><el-button :disabled="assignment.course_status==='archived'" link type="primary" @click="open(row, 'grade')">评分</el-button>
              <el-button :disabled="assignment.course_status==='archived'" link type="warning" @click="open(row, 'return')">退回</el-button>
            </template>
            <span v-else class="hint">等待提交</span>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <AssignmentGroups v-if="assignment.work_mode==='group'" :assignment="assignment" :readonly="assignment.course_status==='archived'"/>
    <ExtensionsPanel :assignment-id="route.params.id" :readonly="assignment.course_status==='archived'||assignment.status!=='published'" @changed="load"/>
    <el-dialog v-model="dialog" :title="mode === 'grade' ? `批改 · ${current.name}` : `退回 · ${current.name}`" width="min(520px, 92vw)">
      <el-form label-position="top">
        <template v-if="mode === 'grade'">
          <el-form-item :label="`成绩（满分 ${assignment.total_score}）`">
            <el-input-number v-model="form.score" :min="0" :max="assignment.total_score" />
          </el-form-item>
          <el-form-item label="评语（仅教师端保存）">
            <el-input v-model="form.comment" type="textarea" :rows="4" />
          </el-form-item>
        </template>
        <el-form-item v-else label="退回原因（学生可见）">
          <el-input v-model="form.returned_reason" type="textarea" :rows="4" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button :type="mode === 'grade' ? 'primary' : 'warning'" :color="mode === 'grade' ? '#15554e' : ''" @click="save">确认</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.file-cell + .file-cell { margin-top: 4px; }
</style>
