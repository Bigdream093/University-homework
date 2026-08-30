<script setup>
import { onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import api, { messageOf } from '../../api/request.js';
import { createServerClock, deadlineState } from '../../utils/deadline.js';
import StudentNotices from './StudentNotices.vue';
import StudentMaterials from './StudentMaterials.vue';
import { useDraggableTabs } from '../../composables/useDraggableTabs.js';

const route = useRoute();
const router = useRouter();
const course = ref({});
const items = ref([]);
const tab = ref('assignments');
const tabsRoot = ref(null);
const tabDefs = ref([
  { label: '通知', name: 'notices' },
  { label: '作业', name: 'assignments' },
  { label: '学习资料', name: 'materials' }
]);
useDraggableTabs(tabsRoot, tabDefs, 'student-course');
const currentTime = ref(Date.now());
let serverClock = () => Date.now();
let clockTimer;

async function load() {
  try {
    const [courseResponse, assignmentResponse] = await Promise.all([
      api.get(`/courses/${route.params.id}`),
      api.get(`/courses/${route.params.id}/assignments`)
    ]);
    course.value = courseResponse.data;
    items.value = assignmentResponse.data;
    serverClock = createServerClock(items.value[0]?.server_now);
    currentTime.value = serverClock();
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

function submissionStatus(assignment) {
  return assignment.submission_status
    ? ({ submitted: '已提交', graded: '已批改', returned: '退回重做' })[assignment.submission_status]
    : '待提交';
}

function deadline(assignment) {
  return deadlineState(assignment.deadline, currentTime.value);
}

onMounted(() => {
  load();
  clockTimer = window.setInterval(() => {
    currentTime.value = serverClock();
  }, 60_000);
});

onUnmounted(() => window.clearInterval(clockTimer));
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <el-button text @click="router.push('/student/courses')">← 我的课程</el-button>
        <h1>{{ course.name || '课程作业' }}</h1>
        <p>{{ course.description }}</p>
      </div>
    </div>

    <div ref="tabsRoot">
      <el-tabs v-model="tab" class="section-tabs">
        <el-tab-pane v-for="def in tabDefs" :key="def.name" :label="def.label" :name="def.name" lazy>
          <div v-if="def.name === 'notices'" class="panel"><StudentNotices :course-id="route.params.id" /></div>
          <div v-else-if="def.name === 'assignments'" class="panel">
            <article
              v-for="assignment in items"
              :key="assignment.id"
              class="assignment-card"
              style="cursor: pointer"
              @click="router.push(`/student/assignments/${assignment.id}`)"
            >
              <div style="display: flex; justify-content: space-between; gap: 18px">
                <div>
                  <span class="badge">{{ submissionStatus(assignment) }}</span>
                  <h3>{{ assignment.title }}</h3>
                  <p>{{ assignment.description || '查看作业详情并提交' }}</p>
                  <span class="hint">截止：{{ assignment.deadline || '不限时间' }} · 满分 {{ assignment.total_score }}</span>
                  <br>
                  <span
                    v-if="deadline(assignment).kind === 'warning' || deadline(assignment).kind === 'late'"
                    class="deadline-notice"
                    :class="deadline(assignment).kind"
                  >
                    {{ deadline(assignment).kind === 'warning' ? '⚠' : '!' }}
                    {{ deadline(assignment).text }}
                  </span>
                </div>
                <span style="align-self: center; color: #15554e">查看详情 →</span>
              </div>
            </article>
            <div v-if="!items.length" class="empty">老师还没有发布作业。</div>
          </div>
          <div v-else-if="def.name === 'materials'" class="panel"><StudentMaterials :course-id="route.params.id" /></div>
        </el-tab-pane>
      </el-tabs>
    </div>
  </div>
</template>
