<script setup>
import { ref, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api, { messageOf } from '../api/request.js'
import { useRefresh } from '../composables/useRefresh.js'
const props = defineProps({ courseId: [String, Number], readonly: Boolean })
const groups = ref([]),
  students = ref([]),
  dialog = ref(false),
  form = ref({})
async function load() {
  try {
    const [groupsResponse, studentsResponse] = await Promise.all([
      api.get('/courses/' + props.courseId + '/groups'),
      api.get('/courses/' + props.courseId + '/students'),
    ])
    groups.value = groupsResponse.data
    students.value = studentsResponse.data
  } catch (error) {
    ElMessage.error(messageOf(error))
  }
}
const ungrouped = computed(() =>
  students.value.filter(
    (student) =>
      !groups.value.some((group) =>
        group.members.some((member) => member.id === student.id),
      ),
  ),
)
function open(group) {
  form.value = group
    ? {
        id: group.id,
        name: group.name,
        leader_id: group.leader_id,
        member_ids: group.members.map((member) => member.id),
      }
    : { name: '', leader_id: null, member_ids: [] }
  dialog.value = true
}
async function save() {
  try {
    if (form.value.id) await api.put('/groups/' + form.value.id, form.value)
    else await api.post('/courses/' + props.courseId + '/groups', form.value)
    dialog.value = false
    await load()
  } catch (error) {
    ElMessage.error(messageOf(error))
  }
}
async function remove(group) {
  try {
    await ElMessageBox.confirm('删除模板小组不会改变已发布作业的成员快照。是否继续？', '确认')
    await api.delete('/groups/' + group.id)
    await load()
  } catch (error) {
    if (error !== 'cancel') ElMessage.error(messageOf(error))
  }
}
useRefresh(load)
</script>
<template>
  <div>
    <div class="toolbar">
      <el-button type="primary" color="#15554e" :disabled="readonly" @click="open()"
        >创建小组</el-button
      ><el-button @click="load">刷新</el-button
      ><router-link to="/help#teacher-course">分组说明</router-link>
    </div>
    <section class="group-panel">
      <div class="group-panel-head">
        <b>未分组学生</b><span class="hint">共 {{ ungrouped.length }} 人</span>
      </div>
      <el-table v-if="ungrouped.length" :data="ungrouped" stripe size="default" max-height="360">
        <el-table-column prop="username" label="学号" width="220" />
        <el-table-column prop="name" label="姓名" />
      </el-table>
      <p v-else class="hint" style="margin: 8px 0 2px">所有学生都已分组。</p>
    </section>
    <p class="hint">这里是课程分组模板。作业首次发布后成员名单被冻结，修改模板不影响历史作业。</p>
    <div class="group-grid">
      <article v-for="group in groups" :key="group.id" class="assignment-card group-card">
        <div class="group-card-head">
          <h3>
            {{ group.name
            }}<span class="hint" style="margin-left: 10px">{{ group.members.length }} 人</span>
          </h3>
          <div class="assignment-actions">
            <el-button :disabled="readonly" @click="open(group)">编辑</el-button
            ><el-button :disabled="readonly" type="danger" text @click="remove(group)"
              >删除</el-button
            >
          </div>
        </div>
        <el-table
          v-if="group.members.length"
          :data="
            [...group.members].sort(
              (left, right) =>
                (left.id === group.leader_id ? -1 : 0) -
                  (right.id === group.leader_id ? -1 : 0) ||
                (left.username < right.username ? -1 : 1),
            )
          "
          stripe
          size="small"
        >
          <el-table-column prop="username" label="学号" width="200" />
          <el-table-column label="姓名"
            ><template #default="{ row }"
              >{{ row.name
              }}<el-tag
                v-if="row.id === group.leader_id"
                size="small"
                type="success"
                style="margin-left: 8px"
                >组长</el-tag
              ></template
            ></el-table-column
          >
        </el-table>
      </article>
    </div>
    <el-dialog v-model="dialog" title="课程分组" width="min(560px,94vw)"
      ><el-form label-position="top"
        ><el-form-item label="组名"><el-input v-model="form.name" /></el-form-item
        ><el-form-item label="组员"
          ><el-select v-model="form.member_ids" multiple filterable style="width: 100%"
            ><el-option
              v-for="student in students"
              :key="student.id"
              :label="student.name + '（' + student.username + '）'"
              :value="student.id" /></el-select></el-form-item
        ><el-form-item label="组长 / 默认提交人"
          ><el-select v-model="form.leader_id"
            ><el-option
              v-for="student in students.filter((student) => form.member_ids?.includes(student.id))"
              :key="student.id"
              :label="student.name"
              :value="student.id" /></el-select></el-form-item></el-form
      ><template #footer
        ><el-button type="primary" @click="save">保存</el-button></template
      ></el-dialog
    >
  </div>
</template>
<style scoped>
.group-panel {
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 16px 18px;
  margin-bottom: 14px;
}
.group-panel-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 10px;
}
.group-panel-head b {
  font-size: 15px;
}
.group-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 14px;
}
.group-card {
  margin-bottom: 0;
}
.group-card-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 10px;
}
.group-card-head h3 {
  margin: 0;
}
.group-card :deep(.el-table) {
  --el-table-border-color: var(--line);
}
</style>
