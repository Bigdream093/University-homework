<script setup>
import RichTextEditor from './RichTextEditor.vue'
import { reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import api, { messageOf } from '../api/request.js'
import { editableRichText } from '../utils/richText.js'
import { normalizeExtensions } from '../utils/assignmentForm.js'
const props = defineProps({ courseId: { type: [String, Number], required: true } })
const emit = defineEmits(['changed'])
const assignmentDialog = ref(false)
const editId = ref(null)
const imageBusy = ref(false)
const assignmentForm = reactive({
  title: '',
  description: '',
  type: 'document',
  deadline: '',
  total_score: 100,
  allow_resubmit_count: 1,
  submission_mode: 'overwrite',
  max_file_mb: 200,
  work_mode: 'individual',
  group_submit_policy: 'designated',
  allowed_extensions: '',
  require_preview_image: false,
  preview_max_count: 3,
})
function openAssignment(assignment) {
  editId.value = assignment?.id || null
  Object.assign(
    assignmentForm,
    assignment
      ? {
          title: assignment.title,
          description: editableRichText(assignment.description, assignment.description_format),
          type: assignment.type,
          deadline: assignment.deadline,
          total_score: assignment.total_score,
          allow_resubmit_count: assignment.allow_resubmit_count,
          submission_mode: assignment.submission_mode || 'overwrite',
          max_file_mb: assignment.max_file_mb || 200,
          work_mode: assignment.work_mode || 'individual',
          group_submit_policy: assignment.group_submit_policy || 'designated',
          allowed_extensions: assignment.allowed_extensions || '',
          require_preview_image: Number(assignment.require_preview_image ?? 0) === 1,
          preview_max_count: Number(assignment.preview_max_count ?? 3),
        }
      : {
          title: '',
          description: '',
          type: 'document',
          deadline: '',
          total_score: 100,
          allow_resubmit_count: 1,
          submission_mode: 'overwrite',
          max_file_mb: 200,
          work_mode: 'individual',
          group_submit_policy: 'designated',
          allowed_extensions: '',
          require_preview_image: false,
          preview_max_count: 3,
        },
  )
  assignmentDialog.value = true
}
async function saveAssignment() {
  if (imageBusy.value) return ElMessage.warning('请等待图片上传完成，或处理失败图片')
  assignmentForm.description_format = 'html'
  if (assignmentForm.type === 'document') {
    const parsed = normalizeExtensions(assignmentForm.allowed_extensions)
    if (parsed.error) {
      ElMessage.warning(`文件后缀名格式无效：${parsed.error}（只能是 1-12 位字母数字）`)
      return
    }
    assignmentForm.allowed_extensions = parsed.list.join(',')
  }
  try {
    const { data } = editId.value
      ? await api.put(`/assignments/${editId.value}`, assignmentForm)
      : await api.post(`/courses/${props.courseId}/assignments`, assignmentForm)
    assignmentDialog.value = false
    ElMessage.success(
      data.cancelled_extension_count
        ? `作业已保存，${data.cancelled_extension_count}条待审批延期已取消`
        : '作业已保存',
    )
    emit('changed')
  } catch (error) {
    ElMessage.error(messageOf(error))
  }
}

defineExpose({ open: openAssignment })
</script>
<template>
  <el-dialog
    v-model="assignmentDialog"
    :title="editId ? '编辑作业' : '创建作业'"
    width="min(1180px,96vw)"
    top="3vh"
    class="markdown-dialog"
    destroy-on-close
    :close-on-click-modal="false"
    :close-on-press-escape="!imageBusy"
    :show-close="!imageBusy"
    ><el-form label-position="top">
      <el-divider content-position="left">基本信息</el-divider>
      <p v-if="editId" class="hint">
        修改后的要求用于之后的提交；已有提交、历史附件和照片不会被隐藏。
      </p>
      <el-form-item label="作业标题"><el-input v-model="assignmentForm.title" /></el-form-item>
      <el-form-item label="作业要求"
        ><RichTextEditor
          v-if="assignmentDialog"
          v-model="assignmentForm.description"
          :course-id="courseId"
          label="作业要求富文本"
          @busy="imageBusy = $event"
      /></el-form-item>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px">
        <el-form-item label="类型"
          ><el-select v-model="assignmentForm.type" style="width: 100%"
            ><el-option label="文档/文件" value="document" /><el-option
              label="在线作答"
              value="online" /></el-select></el-form-item
        ><el-form-item label="截止时间"
          ><el-date-picker
            v-model="assignmentForm.deadline"
            type="datetime"
            value-format="YYYY-MM-DD HH:mm:ss"
            style="width: 100%" /></el-form-item
        ><el-form-item label="满分"
          ><el-input-number v-model="assignmentForm.total_score" :min="1" /></el-form-item
        ><el-form-item label="允许重交次数（-1不限）"
          ><el-input-number v-model="assignmentForm.allow_resubmit_count" :min="-1"
        /></el-form-item>
      </div>
      <el-divider content-position="left">组织与提交方式</el-divider>
      <el-form-item label="作业组织方式"
        ><el-radio-group v-model="assignmentForm.work_mode" :disabled="!!editId"
          ><el-radio value="individual">个人作业</el-radio
          ><el-radio value="group">分组作业</el-radio></el-radio-group
        ></el-form-item
      >
      <el-form-item v-if="assignmentForm.work_mode === 'group'" label="小组提交权限"
        ><el-radio-group v-model="assignmentForm.group_submit_policy"
          ><el-radio value="designated">指定成员提交</el-radio
          ><el-radio value="any">任一组员提交</el-radio></el-radio-group
        >
        <p class="hint">保存草稿后，打开“作业分组设置”配置成员快照，再发布。</p></el-form-item
      >
      <el-form-item label="提交模式"
        ><el-radio-group v-model="assignmentForm.submission_mode"
          ><el-radio value="overwrite">覆盖模式（重新提交会替换原文件）</el-radio
          ><el-radio value="append"
            >追加模式（重新提交作为补充，下载时统一打包）</el-radio
          ></el-radio-group
        ></el-form-item
      >
      <template v-if="assignmentForm.type === 'document'">
        <el-divider content-position="left">文件要求</el-divider>
        <el-form-item label="允许的文件后缀名（留空表示不限制）"
          ><el-input
            v-model="assignmentForm.allowed_extensions"
            placeholder="如：dwg, zip, psd"
          /><span class="hint" style="display: block; margin-top: 4px"
            >多个用逗号分隔，只允许 1-12 位字母数字，最多 20
            个，且必须是系统支持的类型；设置后学生上传其他后缀的文件会被拒收</span
          ></el-form-item
        >
        <el-form-item label="图片预览要求"
          ><el-checkbox v-model="assignmentForm.require_preview_image"
            >要求学生另交图片预览（仅 jpg/png，单张≤20M），便于快速查看和评分</el-checkbox
          >
          <div v-if="assignmentForm.require_preview_image" style="margin-top: 6px">
            <span style="margin-right: 8px">预览图上限</span
            ><el-input-number v-model="assignmentForm.preview_max_count" :min="1" :max="10" /><span
              class="hint"
              style="margin-left: 10px"
              >1-10 张；学生必须至少交 1 张</span
            >
          </div></el-form-item
        >
        <el-form-item label="文件大小上限"
          ><el-radio-group v-model="assignmentForm.max_file_mb"
            ><el-radio :value="10">10M</el-radio><el-radio :value="20">20M</el-radio
            ><el-radio :value="50">50M</el-radio><el-radio :value="100">100M</el-radio
            ><el-radio :value="200">200M</el-radio><el-radio :value="500">500M</el-radio
            ><el-radio :value="1024">1G</el-radio></el-radio-group
          ><span class="hint" style="display: block; margin-top: 4px"
            >学生上传的单文件不能超过该大小</span
          ></el-form-item
        >
      </template> </el-form
    ><template #footer
      ><el-button :disabled="imageBusy" @click="assignmentDialog = false">取消</el-button
      ><el-button type="primary" color="#15554e" :disabled="imageBusy" @click="saveAssignment"
        >保存</el-button
      ></template
    ></el-dialog
  >
</template>
