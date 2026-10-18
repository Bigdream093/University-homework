<script setup>
import { contentSummary } from '../../utils/richText.js'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api, { messageOf } from '../../api/request.js'
import {
  closestDeadlineAssignment,
  createServerClock,
  deadlineRemainingText,
  deadlineState,
} from '../../utils/deadline.js'
import CourseQuestions from '../../components/CourseQuestions.vue'
import { useRefresh } from '../../composables/useRefresh.js'
import { useCollapse } from '../../composables/useCollapse.js'
import StudentNotices from './StudentNotices.vue'
import StudentMaterials from './StudentMaterials.vue'
import { useDraggableTabs } from '../../composables/useDraggableTabs.js'

const route = useRoute()
const router = useRouter()
const course = ref({})
const items = ref([])
const tab = ref('assignments')
const tabsRoot = ref(null)
const tabDefs = ref([
  { label: '通知', name: 'notices' },
  { label: '作业', name: 'assignments' },
  { label: '学习资料', name: 'materials' },
  { label: '课程问答', name: 'questions' },
])
useDraggableTabs(tabsRoot, tabDefs, 'student-course')
const assignmentCard = useCollapse()
const unread = ref(0)
const loading = ref(false)
const loaded = ref(false)
const loadError = ref('')
let loadSequence = 0,
  loadController
useRefresh(load)
watch(
  () => route.params.id,
  () => {
    load()
  },
)
const currentTime = ref(Date.now())
let serverClock = () => Date.now()
let clockTimer

async function load() {
  const sequence = ++loadSequence,
    courseId = route.params.id
  loadController?.abort()
  loadController = new AbortController()
  const signal = loadController.signal
  loading.value = true
  loadError.value = ''
  try {
    const [courseResponse, assignmentResponse] = await Promise.all([
      api.get(`/courses/${courseId}`, { signal }),
      api.get(`/courses/${courseId}/assignments`, { signal }),
    ])
    if (sequence !== loadSequence) return
    course.value = courseResponse.data
    unread.value = courseResponse.data.unread_notice_count || 0
    items.value = assignmentResponse.data
    serverClock = createServerClock(items.value[0]?.server_now)
    currentTime.value = serverClock()
    loaded.value = true
  } catch (error) {
    if (sequence === loadSequence && error.name !== 'CanceledError')
      loadError.value = messageOf(error)
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

function submissionStatus(assignment) {
  if (assignment.not_assigned) return '未安排参与'
  const status = assignment.submission_status
    ? { submitted: '待批改', graded: '已批改', returned: '退回重做' }[assignment.submission_status]
    : '待提交'
  return assignment.status === 'closed' ? `已关闭 · ${status}` : status
}

const deadlines = computed(
  () =>
    new Map(
      items.value.map((assignment) => [
        assignment.id,
        deadlineState(assignment.effective_deadline, currentTime.value),
      ]),
    ),
)
const closestDueAssignment = computed(() =>
  closestDeadlineAssignment(items.value, currentTime.value),
)
const closestDueState = computed(() => deadlines.value.get(closestDueAssignment.value?.id))
const reminderTime = computed(() => deadlineRemainingText(closestDueState.value))
const reminderDeadline = computed(() => {
  const value = closestDueAssignment.value?.effective_deadline || ''
  return value.length === 19 && value.endsWith(':00') ? value.slice(0, 16) : value
})
function setUnreadCount(count) {
  unread.value = course.value.status === 'active' ? Number(count) || 0 : 0
}

onMounted(() => {
  clockTimer = window.setInterval(() => {
    currentTime.value = serverClock()
  }, 60_000)
})

onUnmounted(() => {
  window.clearInterval(clockTimer)
  loadSequence += 1
  loadController?.abort()
})
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <el-button text @click="router.push('/student/courses')">← 我的课程</el-button>
        <h1>
          {{ course.name || '课程作业' }} {{ course.status === 'archived' ? '（已归档）' : '' }}
        </h1>
        <p>{{ course.description }}</p>
      </div>
    </div>

    <el-alert
      v-if="loadError"
      :title="loadError"
      type="error"
      show-icon
      :closable="false"
      style="margin-bottom: 14px"
      ><el-button size="small" @click="load">重试</el-button></el-alert
    >
    <div v-if="loading && !loaded" class="panel empty">正在加载课程作业…</div>

    <section v-if="loaded && !loadError" class="deadline-reminder" aria-label="作业截止提醒">
      <template v-if="closestDueAssignment">
        <div>
          <p class="reminder-label">
            {{
              ['submitted', 'graded'].includes(closestDueAssignment.submission_status)
                ? '最近截止作业'
                : '最近待交作业'
            }}
          </p>
          <h2 class="reminder-title">{{ closestDueAssignment.title }}</h2>
          <p class="reminder-status">{{ submissionStatus(closestDueAssignment) }}</p>
        </div>
        <div>
          <p class="reminder-label">截止时间</p>
          <time
            class="reminder-date"
            :datetime="closestDueAssignment.effective_deadline.replace(' ', 'T') + '+08:00'"
            >{{ reminderDeadline }}</time
          >
        </div>
        <div class="reminder-actions">
          <span class="badge" :class="closestDueState?.kind">{{ reminderTime }}</span>
          <el-button
            type="primary"
            color="#15554e"
            @click="router.push(`/student/assignments/${closestDueAssignment.id}`)"
            >查看作业 →</el-button
          >
        </div>
      </template>
      <p v-else class="reminder-label">暂无截止时间</p>
    </section>

    <div ref="tabsRoot">
      <el-tabs
        v-model="tab"
        class="section-tabs"
        :class="{ 'student-materials-active': tab === 'materials' }"
      >
        <el-tab-pane
          v-for="def in tabDefs"
          :key="def.name"
          :label="def.name === 'notices' && unread ? def.label + '（' + unread + '）' : def.label"
          :name="def.name"
          lazy
        >
          <div v-if="def.name === 'notices'" class="panel">
            <StudentNotices
              v-if="tab === 'notices'"
              :key="`notices-${route.params.id}`"
              :course-id="route.params.id"
              @unread-count="setUnreadCount"
            />
          </div>
          <div v-else-if="def.name === 'assignments'" class="panel">
            <article
              v-for="assignment in items"
              :key="assignment.id"
              class="assignment-card collapsible-card"
            >
              <div class="card-head" @click="assignmentCard.toggle(assignment.id)">
                <span
                  class="badge"
                  :class="'submission-state-' + (assignment.submission_status || 'unsubmitted')"
                  >{{ submissionStatus(assignment) }}</span
                >
                <h3 class="card-title">
                  {{ assignment.title }}
                  <small v-if="assignment.work_mode === 'group'">分组作业</small>
                </h3>
                <span class="hint card-meta"
                  >截止：{{ assignment.effective_deadline || '不限时间' }}</span
                >
                <span
                  v-if="
                    assignment.submission_status !== 'returned' &&
                    ['warning', 'late'].includes(deadlines.get(assignment.id)?.kind)
                  "
                  class="deadline-notice"
                  :class="deadlines.get(assignment.id)?.kind"
                >
                  {{ deadlines.get(assignment.id)?.text }}
                </span>
                <span class="card-chevron">{{
                  assignmentCard.isOpen(assignment.id) ? '收起 ▲' : '展开 ▼'
                }}</span>
              </div>
              <div v-if="assignmentCard.isOpen(assignment.id)" class="card-body">
                <p
                  v-if="assignment.submission_status === 'returned'"
                  class="assignment-return-note"
                >
                  退回原因：{{ assignment.returned_reason || '请打开作业详情查看教师的修改要求' }}
                </p>
                <p
                  style="white-space: pre-wrap; line-height: 1.8; color: #566e69; margin: 0 0 10px"
                >
                  {{
                    contentSummary(assignment.description, assignment.description_format) ||
                    '查看作业详情并提交'
                  }}
                </p>
                <span class="hint" style="display: block; margin-bottom: 10px"
                  >满分 {{ assignment.total_score }}</span
                >
                <span
                  v-if="
                    assignment.submission_status !== 'returned' &&
                    (deadlines.get(assignment.id)?.kind === 'warning' ||
                      deadlines.get(assignment.id)?.kind === 'late')
                  "
                  class="deadline-notice"
                  :class="deadlines.get(assignment.id)?.kind"
                  style="display: block; margin-bottom: 12px"
                >
                  {{ deadlines.get(assignment.id)?.kind === 'warning' ? '⚠' : '!' }}
                  {{ deadlines.get(assignment.id)?.text }}
                </span>
                <el-button
                  type="primary"
                  color="#15554e"
                  @click="router.push(`/student/assignments/${assignment.id}`)"
                  >查看详情并提交 →</el-button
                >
              </div>
            </article>
            <div v-if="loaded && !items.length" class="empty">老师还没有发布作业。</div>
          </div>
          <div v-else-if="def.name === 'questions'" class="panel">
            <CourseQuestions
              v-if="tab === 'questions'"
              :key="`questions-${route.params.id}`"
              :course-id="route.params.id"
              :readonly="course.status === 'archived'"
            />
          </div>
          <div v-else-if="def.name === 'materials'" class="panel student-materials-panel">
            <StudentMaterials
              :key="`materials-${route.params.id}`"
              :course-id="route.params.id"
              :active="tab === 'materials'"
            />
          </div>
        </el-tab-pane>
      </el-tabs>
    </div>
  </div>
</template>

<style scoped>
.assignment-return-note {
  padding: 10px 12px;
  border-radius: 6px;
  background: #fff4e4;
  color: #9c6526;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.deadline-reminder {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr) auto;
  align-items: center;
  gap: 28px;
  margin-bottom: 28px;
  padding: 26px 30px;
  border: 1px solid var(--line);
  border-radius: 18px;
  background: #fff;
  box-shadow: 0 10px 30px rgba(29, 72, 64, 0.04);
}
.reminder-label {
  margin: 0 0 10px;
  color: #71817e;
  font-size: 14px;
}
.reminder-title {
  margin: 0;
  font-size: 24px;
  overflow-wrap: anywhere;
}
.reminder-status {
  margin: 9px 0 0;
  color: #71817e;
  font-size: 13px;
}
.reminder-date {
  color: var(--green);
  font-size: 22px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
  letter-spacing: -0.6px;
}
.reminder-actions {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 13px;
}
.reminder-actions .badge {
  padding: 7px 12px;
  font-size: 14px;
  font-weight: 400;
}
.reminder-actions .badge.warning {
  color: #936312;
  background: #fff5df;
}
.reminder-actions .badge.late {
  color: #bb5a40;
  background: #fff0ec;
}
.card-title small {
  color: #7d8d89;
  font-size: 12px;
  font-weight: 400;
}
:global(.student-materials-panel) {
  position: relative;
  left: 50%;
  width: min(1800px, calc(100vw - 32px));
  max-width: none;
  transform: translateX(-50%);
}
:global(.section-tabs.student-materials-active .el-tabs__content) {
  overflow: visible;
}
@media (max-width: 800px) {
  .deadline-reminder {
    grid-template-columns: minmax(0, 1fr);
    gap: 20px;
    padding: 24px;
  }
  .reminder-date {
    font-size: clamp(18px, 5vw, 22px);
  }
  .reminder-actions {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
  }
  :global(.student-materials-panel) {
    width: calc(100vw - 24px);
    padding: 12px;
  }
}
</style>
