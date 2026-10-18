<script setup>
import { ref, computed, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api, { messageOf } from '../api/request.js'
import { useRefresh } from '../composables/useRefresh.js'
const props = defineProps({ courseId: [String, Number], readonly: Boolean })
const isDialogDismissal = (error) =>
  ['cancel', 'close'].includes(error) || ['cancel', 'close'].includes(error?.message)
const groups = ref([]),
  students = ref([]),
  dialog = ref(false),
  saving = ref(false),
  form = ref({})
const memberKeyword = ref('')
const selectedMembers = computed(() =>
  students.value.filter((student) => form.value.member_ids?.includes(student.id)),
)
const filteredMembers = computed(() =>
  students.value.filter((student) =>
    `${student.name} ${student.username}`
      .toLowerCase()
      .includes(memberKeyword.value.trim().toLowerCase()),
  ),
)
function otherGroup(student) {
  return groups.value.find(
    (group) =>
      group.id !== form.value.id && group.members.some((member) => member.id === student.id),
  )
}
function toggleMember(student, checked) {
  if (saving.value || props.readonly || otherGroup(student)) return
  form.value.member_ids = checked
    ? [...new Set([...(form.value.member_ids || []), student.id])]
    : (form.value.member_ids || []).filter((id) => id !== student.id)
}
watch(
  () => form.value.member_ids,
  (ids) => {
    if (form.value.leader_id && !ids?.includes(form.value.leader_id)) {
      form.value.leader_id = null
      ElMessage.warning('已移除原组长，请重新选择组长')
    }
  },
)
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
      !groups.value.some((group) => group.members.some((member) => member.id === student.id)),
  ),
)
function open(group) {
  memberKeyword.value = ''
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
  if (saving.value || props.readonly) return
  if (!form.value.name?.trim()) {
    ElMessage.warning('请填写组名')
    return
  }
  if (!form.value.member_ids?.length) {
    ElMessage.warning('请选择组员')
    return
  }
  if (!form.value.member_ids.includes(form.value.leader_id)) {
    ElMessage.warning('请从已选组员中选择组长')
    return
  }
  saving.value = true
  try {
    if (form.value.id) await api.put('/groups/' + form.value.id, form.value)
    else await api.post('/courses/' + props.courseId + '/groups', form.value)
    dialog.value = false
    await load()
  } catch (error) {
    ElMessage.error(messageOf(error))
  } finally {
    saving.value = false
  }
}
async function remove(group) {
  try {
    await ElMessageBox.confirm('删除模板小组不会改变已发布作业的成员快照。是否继续？', '确认')
    await api.delete('/groups/' + group.id)
    await load()
  } catch (error) {
    if (!isDialogDismissal(error)) ElMessage.error(messageOf(error))
  }
}
useRefresh(load)
</script>
<template>
  <div>
    <div class="toolbar group-toolbar">
      <div class="group-toolbar-actions">
        <el-button type="primary" color="#15554e" :disabled="readonly" @click="open()"
          >创建小组</el-button
        ><el-button @click="load">刷新</el-button>
      </div>
      <router-link to="/help#teacher-group" custom v-slot="{ navigate }">
        <el-button class="group-help-button" size="small" @click="navigate">分组说明</el-button>
      </router-link>
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
                (left.id === group.leader_id ? -1 : 0) - (right.id === group.leader_id ? -1 : 0) ||
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
    <el-dialog
      v-model="dialog"
      title="课程分组"
      width="min(760px,94vw)"
      top="5vh"
      :close-on-click-modal="!saving"
      :close-on-press-escape="!saving"
      :show-close="!saving"
      class="group-editor-dialog"
    >
      <el-form label-position="top" :disabled="saving || readonly">
        <el-form-item label="组名"
          ><el-input v-model="form.name" placeholder="请输入小组名称" maxlength="100"
        /></el-form-item>
        <el-form-item label="组员">
          <div class="member-picker">
            <div class="member-candidates">
              <el-input v-model="memberKeyword" clearable placeholder="搜索姓名或学号" />
              <div class="member-list">
                <el-checkbox
                  v-for="student in filteredMembers"
                  :key="student.id"
                  :model-value="form.member_ids?.includes(student.id)"
                  :disabled="
                    saving || readonly || !!otherGroup(student) || student.status === 'inactive'
                  "
                  @change="toggleMember(student, $event)"
                >
                  <span class="member-name">{{ student.name }}</span
                  ><span class="member-number">{{ student.username }}</span
                  ><span v-if="otherGroup(student)" class="member-owner">{{
                    otherGroup(student).name
                  }}</span>
                </el-checkbox>
                <p v-if="!filteredMembers.length" class="hint">没有匹配的学生</p>
              </div>
            </div>
            <div class="member-selected">
              <b>已选 {{ selectedMembers.length }} 人</b>
              <div class="member-tags">
                <el-tag
                  v-for="student in selectedMembers"
                  :key="student.id"
                  :closable="!saving && !readonly"
                  @close="toggleMember(student, false)"
                  >{{ student.name }}（{{ student.username }}）</el-tag
                >
              </div>
              <p v-if="!selectedMembers.length" class="hint">从左侧名单选择本组成员</p>
            </div>
          </div>
        </el-form-item>
        <el-form-item label="组长 / 默认提交人">
          <el-select
            v-model="form.leader_id"
            placeholder="请选择组长"
            style="width: 100%"
            :disabled="!selectedMembers.length || saving || readonly"
          >
            <el-option
              v-for="student in selectedMembers"
              :key="student.id"
              :label="student.name + '（' + student.username + '）'"
              :value="student.id"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer
        ><el-button :disabled="saving" @click="dialog = false">取消</el-button
        ><el-button
          type="primary"
          color="#15554e"
          :loading="saving"
          :disabled="saving || readonly"
          @click="save"
          >保存</el-button
        ></template
      >
    </el-dialog>
  </div>
</template>
<style scoped>
.group-toolbar {
  justify-content: space-between;
}
.group-toolbar-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.group-toolbar-actions :deep(.el-button) {
  margin: 0;
}
.group-help-button {
  margin-left: auto;
}
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
  grid-template-columns: repeat(auto-fill, minmax(min(340px, 100%), 1fr));
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
.member-picker {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
}
.member-candidates {
  padding: 12px;
  min-width: 0;
}
.member-list {
  height: 240px;
  overflow-y: auto;
  padding-top: 8px;
}
.member-list .el-checkbox {
  display: flex;
  width: 100%;
  margin: 0;
  min-height: 38px;
  height: auto;
}
.member-list :deep(.el-checkbox__label) {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}
.member-name {
  color: var(--ink);
}
.member-number {
  color: #819188;
  font-size: 12px;
}
.member-owner {
  font-size: 11px;
  color: #9a7c52;
}
.member-selected {
  min-width: 0;
  padding: 12px;
  background: #f7faf8;
  border-left: 1px solid var(--line);
}
.member-selected b {
  color: var(--green);
  font-size: 13px;
}
.member-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  max-height: 245px;
  overflow-y: auto;
  margin-top: 12px;
}
:global(.group-editor-dialog .el-dialog__body) {
  max-height: 72vh;
  overflow-y: auto;
}
@media (max-width: 560px) {
  .member-picker {
    grid-template-columns: minmax(0, 1fr);
  }
  .member-selected {
    border-left: 0;
    border-top: 1px solid var(--line);
  }
  .member-list {
    height: 180px;
  }
}
</style>
