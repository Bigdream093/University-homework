<script setup>
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import api, { messageOf } from '../../api/request.js'

const route = useRoute(),
  router = useRouter()
const rows = ref([]),
  keyword = ref(''),
  page = ref(1),
  pageSize = ref(50),
  total = ref(0),
  loading = ref(false)
let sequence = 0,
  searchTimer,
  searchPending = false,
  disposed = false

async function load() {
  if (disposed) return
  const current = ++sequence
  loading.value = true
  try {
    const { data } = await api.get('/teacher/pending-reviews', {
      params: {
        page: page.value,
        page_size: pageSize.value,
        course_id: route.query?.course_id || undefined,
        keyword: keyword.value.trim() || undefined,
      },
    })
    if (current !== sequence) return
    rows.value = data.rows || []
    total.value = Number(data.total || 0)
  } catch (error) {
    if (current === sequence) ElMessage.error(messageOf(error))
  } finally {
    if (current === sequence) loading.value = false
  }
}

function openReview(row) {
  router.push({
    path: `/teacher/assignments/${row.assignment_id}`,
    query: {
      filter: 'submitted',
      keyword: row.kind === 'group' ? row.name : row.username,
      review: String(row.id),
      review_kind: row.kind,
    },
  })
}

watch(
  [() => route.query?.course_id, keyword, page, pageSize],
  ([course, search, , size], [oldCourse, oldSearch, , oldSize]) => {
    searchPending ||= search !== oldSearch
    if (page.value !== 1 && (course !== oldCourse || search !== oldSearch || size !== oldSize)) {
      page.value = 1
      return
    }
    clearTimeout(searchTimer)
    const current = ++sequence
    const refresh = () => {
      if (disposed || current !== sequence) return
      searchPending = false
      load()
    }
    if (searchPending) searchTimer = window.setTimeout(refresh, 250)
    else nextTick(refresh)
  },
  { flush: 'sync' },
)
onUnmounted(() => {
  disposed = true
  sequence += 1
  clearTimeout(searchTimer)
})
onMounted(load)
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <el-button text @click="router.push('/teacher/courses')">← 返回课程</el-button>
        <h1>待批改收件箱</h1>
        <p>按提交时间排列，点击一条记录可直接打开评分。</p>
      </div>
      <el-input v-model="keyword" clearable placeholder="搜索课程、作业、姓名或学号" />
    </div>
    <div class="panel" v-loading="loading">
      <el-table :data="rows" stripe border>
        <el-table-column prop="course_name" label="课程" min-width="150" />
        <el-table-column prop="assignment_title" label="作业" min-width="180" />
        <el-table-column label="学生 / 小组" min-width="180">
          <template #default="{ row }">
            <b>{{ row.name }}</b>
            <span v-if="row.kind !== 'group'" class="hint"> {{ row.username }}</span>
            <div v-else-if="row.members" class="hint">{{ row.members }}</div>
          </template>
        </el-table-column>
        <el-table-column label="提交时间" min-width="175">
          <template #default="{ row }">
            {{ row.submitted_at || '—' }}
            <span v-if="row.is_late" class="late">迟交</span>
          </template>
        </el-table-column>
        <el-table-column prop="file_name" label="提交内容" min-width="150">
          <template #default="{ row }">{{ row.file_name || '在线作答' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link @click="openReview(row)">去批改</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="!loading && !total" class="empty">当前没有待批改作业。</div>
      <el-pagination
        v-if="total"
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :page-sizes="[25, 50, 100]"
        :total="total"
        background
        layout="total, sizes, prev, pager, next, jumper"
        style="justify-content: flex-end; margin-top: 14px"
      />
    </div>
  </div>
</template>
