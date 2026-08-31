<script setup>
import { ref } from 'vue';
import { ElMessage,ElMessageBox } from 'element-plus';
import api,{messageOf} from '../api/request.js';
import { useRefresh } from '../composables/useRefresh.js';
const props=defineProps({courseId:[String,Number],readonly:Boolean});
const groups=ref([]),students=ref([]),dialog=ref(false),form=ref({});
async function load(){try{const [g,s]=await Promise.all([api.get('/courses/'+props.courseId+'/groups'),api.get('/courses/'+props.courseId+'/students')]);groups.value=g.data;students.value=s.data;}catch(e){ElMessage.error(messageOf(e));}}
function open(g){form.value=g?{id:g.id,name:g.name,leader_id:g.leader_id,member_ids:g.members.map(m=>m.id)}:{name:'',leader_id:null,member_ids:[]};dialog.value=true;}
async function save(){try{if(form.value.id)await api.put('/groups/'+form.value.id,form.value);else await api.post('/courses/'+props.courseId+'/groups',form.value);dialog.value=false;await load();}catch(e){ElMessage.error(messageOf(e));}}
async function remove(g){try{await ElMessageBox.confirm('删除模板小组不会改变已发布作业的成员快照。是否继续？','确认');await api.delete('/groups/'+g.id);await load();}catch(e){if(e!=='cancel')ElMessage.error(messageOf(e));}}
useRefresh(load);
</script>
<template><div><div class="toolbar"><el-button :disabled="readonly" @click="open()">创建小组</el-button><el-button @click="load">刷新</el-button><router-link to="/help#teacher-course">分组说明</router-link></div><p class="hint">未分组学生：{{students.filter(s=>!groups.some(g=>g.members.some(m=>m.id===s.id))).map(s=>s.name+'（'+s.username+'）').join('、')||'无'}}</p><p class="hint">这里是课程分组模板。作业首次发布后成员名单被冻结，修改模板不影响历史作业。</p><article v-for="g in groups" :key="g.id" class="assignment-card"><h3>{{g.name}}</h3><p>{{g.members.map(m=>m.name+'（'+m.username+'）'+(m.id===g.leader_id?'[组长]':'')).join('、')}}</p><el-button :disabled="readonly" @click="open(g)">编辑</el-button><el-button :disabled="readonly" type="danger" @click="remove(g)">删除</el-button></article>
<el-dialog v-model="dialog" title="课程分组" width="min(560px,94vw)"><el-form label-position="top"><el-form-item label="组名"><el-input v-model="form.name"/></el-form-item><el-form-item label="组员"><el-select v-model="form.member_ids" multiple filterable style="width:100%"><el-option v-for="s in students" :key="s.id" :label="s.name+'（'+s.username+'）'" :value="s.id"/></el-select></el-form-item><el-form-item label="组长 / 默认提交人"><el-select v-model="form.leader_id"><el-option v-for="s in students.filter(s=>form.member_ids?.includes(s.id))" :key="s.id" :label="s.name" :value="s.id"/></el-select></el-form-item></el-form><template #footer><el-button type="primary" @click="save">保存</el-button></template></el-dialog></div></template>
