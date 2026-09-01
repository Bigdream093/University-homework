<script setup>
import { onMounted, onUnmounted, ref,computed,watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import api, { messageOf } from '../../api/request.js';
import { createServerClock, deadlineState } from '../../utils/deadline.js';
import CourseQuestions from '../../components/CourseQuestions.vue';
import { useRefresh } from '../../composables/useRefresh.js';
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
  { label: '学习资料', name: 'materials' },{ label:'课程问答',name:'questions' }
]);
useDraggableTabs(tabsRoot, tabDefs, 'student-course');
const unread=ref(0);
let loadSequence=0,unreadSequence=0;
async function refreshUnread(){const sequence=++unreadSequence,courseId=Number(route.params.id);try{const {data}=await api.get('/my/courses');if(sequence===unreadSequence)unread.value=data.find(c=>c.id===courseId)?.unread_notice_count||0;}catch{}}
useRefresh(()=>{load();refreshUnread();});
watch(tab,refreshUnread);
watch(() => route.params.id, () => { load();refreshUnread(); });
const currentTime = ref(Date.now());
let serverClock = () => Date.now();
let clockTimer;

async function load() {
  const sequence=++loadSequence,courseId=route.params.id;
  try {
    const [courseResponse, assignmentResponse] = await Promise.all([
      api.get(`/courses/${courseId}`),
      api.get(`/courses/${courseId}/assignments`)
    ]);
    if(sequence!==loadSequence)return;
    course.value = courseResponse.data;
    items.value = assignmentResponse.data;
    serverClock = createServerClock(items.value[0]?.server_now);
    currentTime.value = serverClock();
  } catch (error) {
    if(sequence===loadSequence)ElMessage.error(messageOf(error));
  }
}

function submissionStatus(assignment) {
  if(assignment.not_assigned)return '未安排参与';
  if(assignment.status==='closed')return '已关闭';
  return assignment.submission_status
    ? ({ submitted: '已提交', graded: '已批改', returned: '退回重做' })[assignment.submission_status]
    : '待提交';
}

function deadline(assignment) {
  return deadlineState(assignment.effective_deadline, currentTime.value);
}

onMounted(() => {
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
        <h1>{{ course.name || '课程作业' }} {{course.status==='archived'?'（已归档）':''}}</h1>
        <p>{{ course.description }}</p>
      </div>
    </div>

    <div ref="tabsRoot">
      <el-tabs v-model="tab" class="section-tabs">
        <el-tab-pane v-for="def in tabDefs" :key="def.name" :label="def.name==='notices'&&unread?def.label+'（'+unread+'）':def.label" :name="def.name" lazy>
          <div v-if="def.name === 'notices'" class="panel"><StudentNotices v-if="tab==='notices'" :key="`notices-${route.params.id}`" :course-id="route.params.id" @read="refreshUnread"/></div>
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
                  <h3>{{ assignment.title }} <small>{{assignment.work_mode==='group'?'分组作业':'个人作业'}}</small></h3>
                  <p>{{ assignment.description || '查看作业详情并提交' }}</p>
                  <span class="hint">截止：{{ assignment.effective_deadline || '不限时间' }} · 满分 {{ assignment.total_score }}</span>
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
          <div v-else-if="def.name === 'questions'" class="panel"><CourseQuestions v-if="tab==='questions'" :key="`questions-${route.params.id}`" :course-id="route.params.id" :readonly="course.status==='archived'"/></div>
          <div v-else-if="def.name === 'materials'" class="panel"><StudentMaterials :key="`materials-${route.params.id}`" :course-id="route.params.id" /></div>
        </el-tab-pane>
      </el-tabs>
    </div>
  </div>
</template>
