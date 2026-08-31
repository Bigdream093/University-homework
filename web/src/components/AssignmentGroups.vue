<script setup>
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import api,{messageOf} from '../api/request.js';
const props=defineProps({assignment:Object,readonly:Boolean});
const students=ref([]);const dialog=ref(false),groups=ref([]),snapshots=ref([]),selected=ref([]);
async function load(){try{const [g,s,roster]=await Promise.all([api.get('/courses/'+props.assignment.course_id+'/groups'),api.get('/assignments/'+props.assignment.id+'/groups'),api.get('/courses/'+props.assignment.course_id+'/students')]);groups.value=g.data;snapshots.value=s.data;students.value=roster.data;}catch(e){ElMessage.error(messageOf(e));}}
async function open(){await load();dialog.value=true;}
async function snapshot(){try{await api.post('/assignments/'+props.assignment.id+'/groups/snapshot',{group_ids:selected.value});await load();ElMessage.success('快照已保存');}catch(e){ElMessage.error(messageOf(e));}}
async function submitter(g){try{await api.put('/assignment-groups/'+g.id+'/submitter',{submitter_id:g.submitter_id});ElMessage.success('已保存提交人');}catch(e){ElMessage.error(messageOf(e));await load();}}
</script>
<template><el-button @click="open">作业分组设置</el-button><el-dialog v-model="dialog" title="本次作业固定分组" width="min(700px,94vw)"><template v-if="assignment.status==='draft'&&!assignment.groups_locked&&!readonly"><el-select v-model="selected" multiple placeholder="选择课程模板小组" style="width:100%"><el-option v-for="g in groups" :key="g.id" :value="g.id" :label="g.name"/></el-select><el-button style="margin-top:12px" @click="snapshot">保存成员快照</el-button></template><p class="hint">本次未安排：{{students.filter(s=>!snapshots.some(g=>g.members.some(m=>m.id===s.id))).map(s=>s.name+'（'+s.username+'）').join('、')||'无'}}</p><p class="hint">首次发布后不得改动成员名单；可更换为本组仍在课程内的提交人。</p><article v-for="g in snapshots" :key="g.id" class="assignment-card"><b>{{g.name}}</b><p>{{g.members.map(m=>m.name+'（'+m.username+'）').join('、')}}</p><el-select v-model="g.submitter_id" :disabled="readonly" @change="submitter(g)"><el-option v-for="m in g.members" :key="m.id" :value="m.id" :label="m.name"/></el-select></article><p v-if="!snapshots.length">尚未配置快照，不能发布。</p></el-dialog></template>
