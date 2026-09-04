<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import api, { messageOf } from '../../api/request.js'
import CourseStudentsPanel from '../../components/CourseStudentsPanel.vue'
import CourseAssignmentsPanel from '../../components/CourseAssignmentsPanel.vue'
import CourseAssignmentForm from '../../components/CourseAssignmentForm.vue'
import CourseGroups from '../../components/CourseGroups.vue'
import CourseQuestions from '../../components/CourseQuestions.vue'
import CourseSummary from '../../components/CourseSummary.vue'
import CourseNotices from './CourseNotices.vue'
import CourseMaterials from './CourseMaterials.vue'
import { useDraggableTabs } from '../../composables/useDraggableTabs.js'
const route = useRoute(),
  router = useRouter()
const course = ref({}),
  students = ref([]),
  assignments = ref([]),
  tab = ref('assignments')
const studentsPanel = ref(null),
  assignmentEditor = ref(null)
function openAssignment(assignment) {
  assignmentEditor.value?.open(assignment)
}
function openStudents() {
  studentsPanel.value?.open()
}
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
        <el-button :disabled="course.status === 'archived'" @click="openStudents()"
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
    <CourseAssignmentsPanel
      v-if="tab === 'assignments'"
      :assignments="assignments"
      :course="course"
      @edit="openAssignment"
      @changed="load"
    />
    <div v-else-if="tab === 'notices'" class="panel">
      <CourseNotices :course-id="route.params.id" :readonly="course.status === 'archived'" />
    </div>
    <div v-else-if="tab === 'summary'" class="panel">
      <CourseSummary
        :key="route.params.id"
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
    <CourseStudentsPanel
      :visible="tab === 'students'"
      :key="`students-${route.params.id}`"
      ref="studentsPanel"
      :course-id="route.params.id"
      :course="course"
      :students="students"
      @changed="load"
    />
    <CourseAssignmentForm
      :key="`assignment-${route.params.id}`"
      ref="assignmentEditor"
      :course-id="route.params.id"
      @changed="load"
    />
  </div>
</template>
