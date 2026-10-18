<script setup>
import RichTextEditor from './RichTextEditor.vue'
import { reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api, { messageOf } from '../api/request.js'
import { editableRichText } from '../utils/richText.js'
import { normalizeExtensions } from '../utils/assignmentForm.js'
import { createRequiredQuestionId } from '../utils/requiredQuestionId.js'
import { DEFAULT_ASSIGNMENT_FILE_MAX_MB } from '@university-homework/domain/limits'
import {
  DEFAULT_REQUIRED_ANSWER_MAX_CHARS,
  requiredQuestions,
  serializeRequiredQuestions,
} from '@university-homework/domain/requiredAnswers'
const props = defineProps({ courseId: { type: [String, Number], required: true } })
const emit = defineEmits(['changed'])
const assignmentDialog = ref(false)
const editId = ref(null)
const imageBusy = ref(false)
const saving = ref(false)
const requiredQuestionList = ref([])
const requiredQuestionDialog = ref(false)
const editingQuestionId = ref(null)
const questionForm = reactive({
  title: '',
  guidance: '',
  maxChars: DEFAULT_REQUIRED_ANSWER_MAX_CHARS,
})
const assignmentForm = reactive({
  title: '',
  description: '',
  required_answer: '',
  type: 'document',
  deadline: '',
  total_score: 100,
  allow_resubmit_count: 1,
  submission_mode: 'overwrite',
  max_file_mb: DEFAULT_ASSIGNMENT_FILE_MAX_MB,
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
          required_answer: assignment.required_answer || '',
          type: assignment.type,
          deadline: assignment.deadline,
          total_score: assignment.total_score,
          allow_resubmit_count: assignment.allow_resubmit_count,
          submission_mode: assignment.submission_mode || 'overwrite',
          max_file_mb: assignment.max_file_mb || DEFAULT_ASSIGNMENT_FILE_MAX_MB,
          work_mode: assignment.work_mode || 'individual',
          group_submit_policy: assignment.group_submit_policy || 'designated',
          allowed_extensions: assignment.allowed_extensions || '',
          require_preview_image: Number(assignment.require_preview_image ?? 0) === 1,
          preview_max_count: Number(assignment.preview_max_count ?? 3),
        }
      : {
          title: '',
          description: '',
          required_answer: '',
          type: 'document',
          deadline: '',
          total_score: 100,
          allow_resubmit_count: 1,
          submission_mode: 'overwrite',
          max_file_mb: DEFAULT_ASSIGNMENT_FILE_MAX_MB,
          work_mode: 'individual',
          group_submit_policy: 'designated',
          allowed_extensions: '',
          require_preview_image: false,
          preview_max_count: 3,
        },
  )
  requiredQuestionList.value = requiredQuestions(assignmentForm.required_answer)
  requiredQuestionDialog.value = false
  assignmentDialog.value = true
}
function openRequiredQuestion(question) {
  editingQuestionId.value = question?.id || null
  Object.assign(questionForm, {
    title: question?.title || '',
    guidance: question?.guidance || '',
    maxChars: question?.maxChars ?? DEFAULT_REQUIRED_ANSWER_MAX_CHARS,
  })
  requiredQuestionDialog.value = true
}
function confirmRequiredQuestion() {
  if (!questionForm.title.trim()) return ElMessage.warning('请填写必答题目')
  if (!questionForm.guidance.trim()) return ElMessage.warning('请填写答题规范')
  const maxChars = Number(questionForm.maxChars ?? DEFAULT_REQUIRED_ANSWER_MAX_CHARS)
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > DEFAULT_REQUIRED_ANSWER_MAX_CHARS)
    return ElMessage.warning('最多字符数须设置为1至5000字')
  const question = {
    id: editingQuestionId.value || createRequiredQuestionId(),
    title: questionForm.title.trim(),
    guidance: questionForm.guidance.trim(),
    maxChars,
  }
  const questions = editingQuestionId.value
    ? requiredQuestionList.value.map((item) => (item.id === question.id ? question : item))
    : [...requiredQuestionList.value, question]
  const serialized = serializeRequiredQuestions(questions)
  if (questions.length > 50 || serialized.length > 20000)
    return ElMessage.warning('最多可添加50道必答题目，题目与规范总内容不能超过20000字')
  requiredQuestionList.value = questions
  assignmentForm.required_answer = serialized
  requiredQuestionDialog.value = false
}
async function removeRequiredQuestion(question) {
  try {
    await ElMessageBox.confirm(
      '确认删除这道必答题目及其答题规范？保存作业后生效，已有提交记录会保留。',
      '删除必答题目',
      { type: 'warning' },
    )
    requiredQuestionList.value = requiredQuestionList.value.filter(
      (item) => item.id !== question.id,
    )
    assignmentForm.required_answer = serializeRequiredQuestions(requiredQuestionList.value)
  } catch {
    // Cancelling keeps the confirmed question intact.
  }
}
async function saveAssignment() {
  if (saving.value) return
  if (imageBusy.value) return ElMessage.warning('请等待图片上传完成，或处理失败图片')
  if (requiredQuestionDialog.value) return ElMessage.warning('请先确定或取消正在编辑的必答题目')
  assignmentForm.description_format = 'html'
  if (assignmentForm.type === 'document') {
    const parsed = normalizeExtensions(assignmentForm.allowed_extensions)
    if (parsed.error) {
      ElMessage.warning(`文件后缀名格式无效：${parsed.error}（只能是 1-12 位字母数字）`)
      return
    }
    assignmentForm.allowed_extensions = parsed.list.join(',')
  }
  saving.value = true
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
  } finally {
    saving.value = false
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
    :close-on-press-escape="!imageBusy && !saving"
    :show-close="!imageBusy && !saving"
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
      <el-divider content-position="left">必答题目（可选）</el-divider>
      <p class="hint">
        可添加多道题目。每道题填写题目和答题规范，点击“确定”后锁定；学生只能查看题目与规范，并逐题填写答案。文件作业仍须上传附件。
      </p>
      <article
        v-for="(question, index) in requiredQuestionList"
        :key="question.id"
        class="confirmed-question"
      >
        <div class="question-heading">
          <strong>必答题目 {{ index + 1 }}</strong>
          <el-tag class="question-status" size="small" type="info" effect="plain"
            >已确认 · 已锁定</el-tag
          >
          <div class="question-actions">
            <el-button size="small" text @click="openRequiredQuestion(question)"
              >解锁修改</el-button
            >
            <el-button size="small" type="danger" text @click="removeRequiredQuestion(question)"
              >删除</el-button
            >
          </div>
        </div>
        <p class="question-text">{{ question.title }}</p>
        <div v-if="question.guidance" class="question-guidance">
          <span class="question-guidance-label">答题规范</span>
          <p>{{ question.guidance }}</p>
        </div>
        <p class="question-limit">
          答案最多 {{ question.maxChars ?? DEFAULT_REQUIRED_ANSWER_MAX_CHARS }} 字
        </p>
      </article>
      <el-button
        :disabled="requiredQuestionList.length >= 50"
        type="primary"
        color="#15554e"
        plain
        @click="openRequiredQuestion()"
        >＋ 新增必答题目</el-button
      >
      <p v-if="!requiredQuestionList.length" class="hint">
        尚未设置必答题目，学生按原作业要求提交。
      </p>
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
        ><el-form-item label="学生自行重交次数（不含首次提交；教师退回另计，-1不限）"
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
            ><el-radio :value="DEFAULT_ASSIGNMENT_FILE_MAX_MB"
              >{{ DEFAULT_ASSIGNMENT_FILE_MAX_MB }}M</el-radio
            ><el-radio :value="500">500M</el-radio
            ><el-radio :value="1024">1G</el-radio></el-radio-group
          ><span class="hint" style="display: block; margin-top: 4px"
            >学生上传的单文件不能超过该大小</span
          ></el-form-item
        >
      </template> </el-form
    ><template #footer
      ><el-button :disabled="imageBusy || saving" @click="assignmentDialog = false">取消</el-button
      ><el-button
        type="primary"
        color="#15554e"
        :disabled="imageBusy || saving"
        :loading="saving"
        @click="saveAssignment"
        >保存</el-button
      ></template
    ></el-dialog
  >
  <el-dialog
    v-model="requiredQuestionDialog"
    :title="editingQuestionId ? '修改必答题目' : '新增必答题目'"
    width="min(720px,94vw)"
    append-to-body
    :close-on-click-modal="false"
  >
    <el-form label-position="top">
      <el-form-item label="必答题目" required>
        <el-input
          v-model="questionForm.title"
          aria-label="必答题目"
          type="textarea"
          :rows="2"
          maxlength="2000"
          show-word-limit
          placeholder="例如：你完成本次作业所花的时间是多少？"
        />
      </el-form-item>
      <el-form-item label="答题规范" required>
        <el-input
          v-model="questionForm.guidance"
          aria-label="答题规范"
          type="textarea"
          :rows="4"
          maxlength="10000"
          show-word-limit
          placeholder="例如：请以小时为单位，按“总用时：X小时；主要工作：……”的格式作答。"
        />
      </el-form-item>
      <el-form-item label="最多字符数">
        <el-input-number
          v-model="questionForm.maxChars"
          aria-label="每题最多字符数"
          :min="1"
          :max="DEFAULT_REQUIRED_ANSWER_MAX_CHARS"
          :precision="0"
          :step="100"
          controls-position="right"
        />
        <span class="hint" style="margin-left: 10px">默认 5000 字，可设置为 1–5000 字</span>
      </el-form-item>
    </el-form>
    <p class="hint">
      点击“确定”后，这道题目与规范将锁定为只读条目。需要调整时可点击“解锁修改”，最终随作业一起保存。
    </p>
    <template #footer>
      <el-button @click="requiredQuestionDialog = false">取消编辑</el-button>
      <el-button type="primary" color="#15554e" @click="confirmRequiredQuestion">确定</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.confirmed-question {
  margin: 14px 0;
  padding: 16px 18px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #fff;
}
.question-heading {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.question-heading strong {
  color: #526f65;
  font-size: 14px;
  font-weight: 600;
}
.question-status {
  --el-tag-bg-color: #f7f9f7;
  --el-tag-border-color: var(--line);
  --el-tag-text-color: #71847d;
}
.question-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-left: auto;
}
.question-actions .el-button {
  margin: 0;
}
.question-text,
.question-guidance p {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.question-text {
  margin: 12px 0 0;
  color: var(--ink);
  font-size: 15px;
  line-height: 1.75;
}
.question-guidance {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  align-items: baseline;
  gap: 12px;
  margin-top: 10px;
  font-size: 14px;
  line-height: 1.75;
}
.question-guidance-label {
  color: #71847d;
  font-size: 13px;
}
.question-guidance p {
  margin: 0;
  color: #526f65;
}
.question-limit {
  margin: 10px 0 0;
  color: #71847d;
  font-size: 12px;
  line-height: 1.6;
}
@media (max-width: 600px) {
  .confirmed-question {
    padding: 14px;
  }
  .question-guidance {
    grid-template-columns: minmax(0, 1fr);
    gap: 4px;
  }
}
</style>
