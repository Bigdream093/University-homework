<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api, { messageOf } from '../../api/request.js'
import CourseGroups from '../../components/CourseGroups.vue'
import AssignmentGroups from '../../components/AssignmentGroups.vue'
import CourseQuestions from '../../components/CourseQuestions.vue'
import CourseSummary from '../../components/CourseSummary.vue'
import CourseNotices from './CourseNotices.vue'
import CourseMaterials from './CourseMaterials.vue'
import { useDraggableTabs } from '../../composables/useDraggableTabs.js'
import { useCollapse } from '../../composables/useCollapse.js'
const route = useRoute(),
  router = useRouter(),
  course = ref({}),
  students = ref([]),
  assignments = ref([]),
  tab = ref('assignments'),
  studentDialog = ref(false),
  assignmentDialog = ref(false),
  editId = ref(null),
  studentForm = reactive({ username: '', name: '' }),
  assignmentForm = reactive({
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
const tabsRoot = ref(null),
  tabDefs = ref([
    { label: '作业管理', name: 'assignments' },
    { label: '成绩汇总', name: 'summary' },
    { label: '通知', name: 'notices' },
    { label: '学习资料', name: 'materials' },
    { label: '学生名单', name: 'students' },
    { label: '分组', name: 'groups' },
    { label: '课程问答', name: 'questions' },
  ])
useDraggableTabs(tabsRoot, tabDefs, 'teacher-course')
const published = computed(
  () => assignments.value.filter((assignment) => assignment.status === 'published').length,
)
const assignmentCard = useCollapse()
let loadSequence = 0
async function load() {
  const sequence = ++loadSequence,
    courseId = route.params.id
  try {
    const [courseResponse, studentsResponse, assignmentsResponse] = await Promise.all([
      api.get(`/courses/${courseId}`),
      api.get(`/courses/${courseId}/students`),
      api.get(`/courses/${courseId}/assignments`),
    ])
    if (sequence !== loadSequence) return
    course.value = courseResponse.data
    students.value = studentsResponse.data
    assignments.value = assignmentsResponse.data
  } catch (error) {
    if (sequence === loadSequence) ElMessage.error(messageOf(error))
  }
}
async function addStudent() {
  try {
    await api.post(`/courses/${route.params.id}/students`, studentForm)
    studentDialog.value = false
    Object.assign(studentForm, { username: '', name: '' })
    ElMessage.success('学生已加入')
    load()
  } catch (error) {
    ElMessage.error(messageOf(error))
  }
}
async function importFile(options) {
  const formData = new FormData()
  formData.append('file', options.file)
  try {
    const { data } = await api.post(`/courses/${route.params.id}/students/import`, formData)
    ElMessage.success(
      `新增账号${data.created}人，加入课程${data.joined}人，重复${data.duplicated}人`,
    )
    options.onSuccess()
    load()
  } catch (error) {
    options.onError(error)
    ElMessage.error(messageOf(error))
  }
}
async function studentAction(student, action) {
  try {
    if (action === 'remove') {
      const { data } = await api.get(
        `/courses/${route.params.id}/students/${student.id}/removal-impact`,
      )
      const summary = `将永久删除该生在本课程中的 ${data.submissions} 份提交、${data.history} 个历史版本、${data.previews} 张照片、${data.questions} 条提问及相关活动记录。共享小组作业会保留并移除其身份。请输入学号 ${student.username} 确认。`
      await ElMessageBox.prompt(summary, '移除并清理资料', {
        type: 'warning',
        confirmButtonText: '永久删除',
        cancelButtonText: '取消',
        inputValidator: (value) => value === student.username || '输入的学号不正确',
      })
      await api.delete(`/courses/${route.params.id}/students/${student.id}`)
      ElMessage.success('学生及其课程资料已删除')
    } else if (action === 'reset') {
      await api.post(`/students/${student.id}/reset-password`)
      ElMessage.success('密码已重置为123456')
    } else
      await api.put(`/students/${student.id}/status`, {
        status: student.status === 'active' ? 'disabled' : 'active',
      })
    load()
  } catch (error) {
    if (error !== 'cancel') ElMessage.error(messageOf(error))
  }
}
function openAssignment(assignment) {
  editId.value = assignment?.id || null
  Object.assign(
    assignmentForm,
    assignment
      ? {
          title: assignment.title,
          description: assignment.description,
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
// 与服务端同规则的格式预检：去点转小写、逗号/分号/空白分隔、纯字母数字 1-12 位、最多 20 个。
function normalizeExtensions(input) {
  const list = String(input || '')
    .split(/[,，;；\s]+/)
    .map((token) => token.replace(/^\.+/, '').trim().toLowerCase())
    .filter(Boolean)
  for (const ext of list) if (!/^[a-z0-9]{1,12}$/.test(ext)) return { error: ext }
  if (list.length > 20) return { error: '后缀名超过 20 个' }
  return { list: [...new Set(list)] }
}
function formatExtensions(value) {
  return String(value || '')
    .split(',')
    .filter(Boolean)
    .map((extension) => '.' + extension)
    .join('、')
}
async function saveAssignment() {
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
      : await api.post(`/courses/${route.params.id}/assignments`, assignmentForm)
    assignmentDialog.value = false
    ElMessage.success(
      data.cancelled_extension_count
        ? `作业已保存，${data.cancelled_extension_count}条待审批延期已取消`
        : '作业已保存',
    )
    load()
  } catch (error) {
    ElMessage.error(messageOf(error))
  }
}
async function assignmentAction(assignment, action) {
  try {
    if (action === 'delete') {
      await ElMessageBox.confirm('确认删除这项作业？', '确认', { type: 'warning' })
      await api.delete(`/assignments/${assignment.id}`)
    } else await api.post(`/assignments/${assignment.id}/${action}`)
    ElMessage.success(action === 'publish' ? '作业已发布' : '作业已关闭')
    load()
  } catch (error) {
    if (error !== 'cancel') ElMessage.error(messageOf(error))
  }
}
async function moveAssignment(assignment, direction) {
  try {
    await api.post(`/assignments/${assignment.id}/move`, { direction })
    await load()
  } catch (error) {
    ElMessage.error(messageOf(error))
  }
}
onMounted(load)
watch(
  () => route.params.id,
  () => {
    tab.value = 'assignments'
    load()
  },
)
</script>
<template>
  <div>
    <div class="page-head">
      <div>
        <el-button text @click="router.push('/teacher/courses')">← 返回课程</el-button>
        <h1>
          {{ course.name || '课程详情' }} {{ course.status === 'archived' ? '（已归档）' : '' }}
        </h1>
        <p>
          {{ course.code }} · 邀请码 <b>{{ course.invite_code }}</b>
        </p>
      </div>
      <div>
        <el-button :disabled="course.status === 'archived'" @click="studentDialog = true"
          >添加学生</el-button
        ><el-button
          type="primary"
          color="#15554e"
          :disabled="course.status === 'archived'"
          @click="openAssignment()"
          >发布新作业</el-button
        >
      </div>
    </div>
    <div class="stat-strip">
      <div class="stat">
        <b>{{ students.length }}</b
        ><span>课程学生</span>
      </div>
      <div class="stat">
        <b>{{ assignments.length }}</b
        ><span>全部作业</span>
      </div>
      <div class="stat">
        <b>{{ published }}</b
        ><span>进行中</span>
      </div>
      <div class="stat">
        <b>{{ course.invite_code || '—' }}</b
        ><span>课程邀请码</span>
      </div>
    </div>
    <div ref="tabsRoot">
      <el-tabs v-model="tab" class="section-tabs"
        ><el-tab-pane v-for="def in tabDefs" :key="def.name" :label="def.label" :name="def.name"
      /></el-tabs>
    </div>
    <div v-if="tab === 'assignments'" class="panel">
      <div v-if="assignments.length">
        <article
          v-for="(assignment, index) in assignments"
          :key="assignment.id"
          class="assignment-card collapsible-card"
        >
          <div class="card-head" @click="assignmentCard.toggle(assignment.id)">
            <span class="badge">{{
              { draft: '草稿', published: '已发布', closed: '已关闭' }[assignment.status]
            }}</span
            ><span v-if="assignment.status !== 'draft'" class="badge"
              >{{ assignment.unsubmitted_count }}/{{ assignment.expected_count }} 未交</span
            ><span v-if="assignment.status !== 'draft'" class="badge"
              >{{ assignment.pending_review_count }}/{{ assignment.expected_count }} 待批改</span
            >
            <h3 class="card-title">{{ assignment.title }}</h3>
            <span class="hint">截止：{{ assignment.deadline || '不限' }}</span
            ><el-button-group @click.stop
              ><el-button
                size="small"
                :disabled="course.status === 'archived' || index === 0"
                @click="moveAssignment(assignment, 'up')"
                >上移</el-button
              ><el-button
                size="small"
                :disabled="course.status === 'archived' || index === assignments.length - 1"
                @click="moveAssignment(assignment, 'down')"
                >下移</el-button
              ></el-button-group
            ><el-button
              size="small"
              type="primary"
              color="#15554e"
              @click.stop="router.push(`/teacher/assignments/${assignment.id}`)"
              >查看提交</el-button
            ><span class="card-chevron">{{
              assignmentCard.isOpen(assignment.id) ? '收起 ▲' : '展开 ▼'
            }}</span>
          </div>
          <div v-if="assignmentCard.isOpen(assignment.id)" class="card-body">
            <p style="white-space: pre-wrap; line-height: 1.8; color: #566e69; margin: 0 0 10px">
              {{ assignment.description || '暂无作业说明' }}
            </p>
            <span class="hint" style="display: block; margin-bottom: 12px"
              >{{ assignment.work_mode === 'group' ? '分组作业' : '个人作业' }} · 满分{{
                assignment.total_score
              }} · 可重交{{
                assignment.allow_resubmit_count === -1
                  ? '不限'
                  : assignment.allow_resubmit_count + '次'
              }} · {{ assignment.submission_mode === 'append' ? '追加模式' : '覆盖模式'
              }}<template v-if="assignment.type !== 'online'">
                · 单文件≤{{
                  assignment.max_file_mb >= 1024 ? '1G' : assignment.max_file_mb + 'M'
                }}</template
              ><template v-if="assignment.allowed_extensions">
                · 限交后缀：{{ formatExtensions(assignment.allowed_extensions) }}</template
              ><template v-if="Number(assignment.require_preview_image) === 1">
                · 需交预览图 1-{{ assignment.preview_max_count }} 张（jpg/png）</template
              ></span
            >
            <div class="assignment-actions">
              <AssignmentGroups
                v-if="assignment.work_mode === 'group'"
                :assignment="assignment"
                :readonly="course.status === 'archived'"
              /><el-button
                :disabled="course.status === 'archived'"
                @click="openAssignment(assignment)"
                >编辑</el-button
              ><el-button
                v-if="assignment.status === 'draft'"
                type="success"
                :disabled="course.status === 'archived'"
                @click="assignmentAction(assignment, 'publish')"
                >发布</el-button
              ><el-button
                v-if="assignment.status === 'published'"
                type="warning"
                :disabled="course.status === 'archived'"
                @click="assignmentAction(assignment, 'close')"
                >关闭</el-button
              ><el-button
                v-if="assignment.status === 'closed'"
                type="success"
                :disabled="course.status === 'archived'"
                @click="assignmentAction(assignment, 'publish')"
                >重新发布</el-button
              ><el-button
                type="primary"
                color="#15554e"
                @click="router.push(`/teacher/assignments/${assignment.id}`)"
                >查看提交</el-button
              ><el-button
                type="danger"
                text
                :disabled="course.status === 'archived'"
                @click="assignmentAction(assignment, 'delete')"
                >删除</el-button
              >
            </div>
          </div>
        </article>
      </div>
      <div v-else class="empty">还没有作业，创建后可发布给学生。</div>
    </div>
    <div v-else-if="tab === 'notices'" class="panel">
      <CourseNotices :course-id="route.params.id" :readonly="course.status === 'archived'" />
    </div>
    <div v-else-if="tab === 'summary'" class="panel">
      <CourseSummary
        :course-id="route.params.id"
        :course-name="course.name"
        :readonly="course.status === 'archived'"
      />
    </div>
    <div v-else-if="tab === 'materials'" class="panel">
      <CourseMaterials :course-id="route.params.id" :readonly="course.status === 'archived'" />
    </div>
    <div v-else-if="tab === 'groups'" class="panel">
      <CourseGroups :course-id="route.params.id" :readonly="course.status === 'archived'" />
    </div>
    <div v-else-if="tab === 'questions'" class="panel">
      <CourseQuestions :course-id="route.params.id" :readonly="course.status === 'archived'" />
    </div>
    <div v-else class="panel">
      <div class="toolbar">
        <el-button :disabled="course.status === 'archived'" @click="studentDialog = true"
          >手动添加</el-button
        ><el-upload
          :show-file-list="false"
          accept=".xlsx,.xls"
          :disabled="course.status === 'archived'"
          :http-request="importFile"
          ><el-button type="primary" plain>导入Excel名单</el-button></el-upload
        ><span class="hint">A列学号，B列姓名，首行为表头</span>
      </div>
      <el-table :data="students" stripe
        ><el-table-column prop="username" label="学号" /><el-table-column
          prop="name"
          label="姓名"
        /><el-table-column prop="submission_count" label="已交作业" /><el-table-column label="状态"
          ><template #default="{ row }"
            ><el-tag :type="row.status === 'active' ? 'success' : 'info'">{{
              row.status === 'active' ? '正常' : '停用'
            }}</el-tag></template
          ></el-table-column
        ><el-table-column label="操作" width="250"
          ><template #default="{ row }"
            ><el-button
              link
              :disabled="course.status === 'archived'"
              @click="studentAction(row, 'reset')"
              >重置密码</el-button
            ><el-button
              link
              :disabled="course.status === 'archived'"
              @click="studentAction(row, 'status')"
              >{{ row.status === 'active' ? '停用' : '启用' }}</el-button
            ><el-button
              link
              type="danger"
              :disabled="course.status === 'archived'"
              @click="studentAction(row, 'remove')"
              >移除并清理</el-button
            ></template
          ></el-table-column
        ></el-table
      >
    </div>
    <el-dialog v-model="studentDialog" title="添加学生" width="min(460px,92vw)"
      ><el-form label-position="top"
        ><el-form-item label="学号"><el-input v-model="studentForm.username" /></el-form-item
        ><el-form-item label="姓名"><el-input v-model="studentForm.name" /></el-form-item></el-form
      ><template #footer
        ><el-button @click="studentDialog = false">取消</el-button
        ><el-button type="primary" color="#15554e" @click="addStudent">添加</el-button></template
      ></el-dialog
    ><el-dialog
      v-model="assignmentDialog"
      :title="editId ? '编辑作业' : '创建作业'"
      width="min(680px,94vw)"
      ><el-form label-position="top">
        <el-divider content-position="left">基本信息</el-divider>
        <p v-if="editId" class="hint">
          修改后的要求用于之后的提交；已有提交、历史附件和照片不会被隐藏。
        </p>
        <el-form-item label="作业标题"
          ><el-input v-model="assignmentForm.title"
        /></el-form-item>
        <el-form-item label="作业要求"
          ><el-input v-model="assignmentForm.description" type="textarea" :rows="4"
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
              placeholder="如：dwg, zip, psd" /><span
              class="hint"
              style="display: block; margin-top: 4px"
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
              ><el-input-number
                v-model="assignmentForm.preview_max_count"
                :min="1"
                :max="10" /><span
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
        ><el-button @click="assignmentDialog = false">取消</el-button
        ><el-button type="primary" color="#15554e" @click="saveAssignment"
          >保存</el-button
        ></template
      ></el-dialog
    >
  </div>
</template>
