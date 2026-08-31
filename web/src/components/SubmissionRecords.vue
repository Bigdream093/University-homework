<script setup>
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import api,{messageOf} from '../api/request.js';
import { downloadBlob } from '../utils/files.js';
const props=defineProps({apiBase:String});
const visible=ref(false),history=ref([]),receipts=ref([]);
const states={available:'文件仍可下载',online:'在线作答',replaced:'原文件已替换',legacy_unknown:'旧记录状态未知',missing:'实体文件缺失'};
async function open(){try{const [h,r]=await Promise.all([api.get(props.apiBase+'/history'),api.get(props.apiBase+'/receipts')]);history.value=h.data;receipts.value=r.data;visible.value=true;}catch(e){ElMessage.error(messageOf(e));}}
async function download(url,name){try{const {data}=await api.get(url,{responseType:'blob',timeout:0});downloadBlob(data,name);}catch(e){ElMessage.error(messageOf(e));}}
</script>
<template>
<el-button :disabled="!apiBase" @click="open">历史与回执</el-button>
<el-dialog v-model="visible" title="提交历史与回执" width="min(780px,94vw)">
<p class="hint">回执保存提交时的事实；旧文件的当前可用状态另外显示。旧数据可能没有回执，不补造未知信息。</p>
<article v-for="r in receipts" :key="r.receipt_no" class="assignment-card">
<b>{{r.receipt_no}}</b><p>{{r.snapshot.course_name}} / {{r.snapshot.assignment_title}}</p>
<p>实际提交人：{{r.snapshot.student?.name}}（{{r.snapshot.student?.username}}） · 第{{r.snapshot.submit_count}}次 · {{r.snapshot.is_late?'迟交':'准时'}}</p>
<p>提交：{{r.snapshot.submitted_at}} · 当时有效截止：{{r.snapshot.effective_deadline||'不限'}}</p>
<p v-if="r.snapshot.group">小组：{{r.snapshot.group.name}} · 成员：{{r.snapshot.group.members.map(m=>m.name+'（'+m.username+'）').join('、')}}</p>
<p>文件：{{r.snapshot.file_name||'在线作答'}} · 提交时：{{states[r.snapshot.file_state]||'未知'}} · 当前：{{states[r.current_file_state]||'未知'}}</p>
<el-button @click="download(apiBase+'/receipts/'+r.receipt_no+'/file',r.receipt_no+'.txt')">下载回执</el-button>
</article>
<h3>全部提交历史</h3>
<article v-for="h in history" :key="h.id" class="assignment-card"><b>{{h.submitted_at}} · {{h.file_name||'在线作答'}}</b><p>{{states[h.file_state]}}</p><p style="white-space:pre-wrap">{{h.content}}</p><el-button v-if="['available','online'].includes(h.file_state)" @click="download(apiBase+'/file?history_id='+h.id,h.file_name||'在线作答.txt')">下载此版本</el-button></article>
</el-dialog>
</template>

