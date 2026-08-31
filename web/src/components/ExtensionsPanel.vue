<script setup>
import { computed,ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useUserStore } from '../stores/user.js';
import api,{messageOf} from '../api/request.js';
import { useRefresh } from '../composables/useRefresh.js';
const props=defineProps({assignmentId:[String,Number],canApply:Boolean,readonly:Boolean});
const emit=defineEmits(['changed']);const user=useUserStore(),teacher=computed(()=>user.user?.role==='teacher');
const rows=ref([]),dialog=ref(false),decision=ref(null),reason=ref(''),date=ref(''),status=ref('approved'),busy=ref(false);
const labels={pending:'待审批',approved:'已批准',rejected:'已拒绝',withdrawn:'已撤回',cancelled:'已取消'};
async function load(){if(!props.assignmentId)return;try{rows.value=(await api.get('/assignments/'+props.assignmentId+'/extensions')).data;}catch(e){ElMessage.error(messageOf(e));}}
function open(row=null){decision.value=row;reason.value='';date.value=row?.requested_deadline||'';status.value='approved';dialog.value=true;}
async function save(){busy.value=true;try{if(decision.value)await api.post('/extensions/'+decision.value.id+'/decision',{status:status.value,approved_deadline:date.value,decision_reason:reason.value});else await api.post('/assignments/'+props.assignmentId+'/extensions',{reason:reason.value,requested_deadline:date.value});dialog.value=false;await load();emit('changed');ElMessage.success('已保存');}catch(e){ElMessage.error(messageOf(e));}finally{busy.value=false;}}
async function withdraw(r){try{await api.post('/extensions/'+r.id+'/withdraw');await load();emit('changed');}catch(e){ElMessage.error(messageOf(e));}}
useRefresh(load);
</script>
<template><section class="panel" style="margin-top:20px">
<div class="toolbar"><h3>延期申请</h3><el-button @click="load">刷新</el-button><el-button v-if="!teacher&&canApply&&!readonly" :disabled="rows.some(r=>r.status==='pending')" @click="open()">申请延期</el-button><router-link :to="{path:'/help',hash:teacher?'#teacher-notice':'#student-notice'}">延期规则</router-link></div>
<p class="hint">申请不等于批准；不增加提交次数，不改变过去的迟交记录。小组理由仅申请人和教师可见。</p>
<article v-for="r in rows" :key="r.id" class="assignment-card"><b>{{labels[r.status]}} {{r.group_name||r.requester_name||''}} {{r.requester_username||''}}</b><p>希望延至：{{r.requested_deadline}} <template v-if="r.approved_deadline"> · 批准至：{{r.approved_deadline}}</template></p><p v-if="r.reason">理由：{{r.reason}}</p><p v-if="r.decision_reason">审批说明：{{r.decision_reason}}</p><el-button v-if="teacher&&r.status==='pending'&&!readonly" @click="open(r)">审批</el-button><el-button v-if="!teacher&&r.requester_id===user.user.id&&r.status==='pending'&&!readonly" @click="withdraw(r)">撤回申请</el-button></article>
<p v-if="!rows.length" class="hint">暂无延期申请。</p>
<el-dialog v-model="dialog" :title="decision?'审批延期':'申请延期'" width="min(540px,94vw)"><el-form label-position="top"><el-form-item v-if="decision" label="决定"><el-radio-group v-model="status"><el-radio value="approved">批准</el-radio><el-radio value="rejected">拒绝</el-radio></el-radio-group></el-form-item><el-form-item v-if="!decision||status==='approved'" label="延至（北京时间）"><el-date-picker v-model="date" type="datetime" value-format="YYYY-MM-DD HH:mm:ss"/></el-form-item><el-form-item :label="decision?'审批说明（拒绝必填）':'申请理由（必填）'"><el-input v-model="reason" type="textarea" :rows="4" maxlength="2000"/></el-form-item></el-form><template #footer><el-button @click="dialog=false">取消</el-button><el-button type="primary" :loading="busy" @click="save">确认</el-button></template></el-dialog>
</section></template>

