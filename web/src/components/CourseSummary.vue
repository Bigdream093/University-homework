<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import api, { messageOf } from '../api/request.js'
import { downloadBlob } from '../utils/files.js'
import GradeWorkspace from './GradeWorkspace.vue'

// 成绩汇总：按名单原序展示每位学生每次作业的图片与评分，支持行内改分、
// 打开看图评分工作区、设置权重/期末/占比，并导出五列成绩表（服务端为计算口径）。
const props = defineProps({
  courseId: { type: [String, Number], required: true },
  courseName: { type: String, default: '' },
  readonly: { type: Boolean, default: false },
})

const loading = ref(false)
const assignments = ref([])
const students = ref([])
const savedConfig = ref({
  daily_ratio: 40,
  final_ratio: 60,
  grade_absent_mode: 'zero',
  final_assignment_id: null,
})
const draft = reactive({
  daily_ratio: 40,
  final_ratio: 60,
  grade_absent_mode: 'zero',
  final_assignment_id: null,
  weights: {},
})
const keyword = ref('')
const showDraftColumns = ref(false)
const showWeights = ref(false)
const saving = ref(false)
const exporting = ref(false)
const editingKey = ref('')
const editValue = ref(null)
const workspace = ref(false)
const workspaceRow = ref(null)
const workspaceRows = ref([])
const workspaceAssignment = ref({})
const ticketCache = new Map()

watch(() => props.courseId, load, { immediate: true })

async function load() {
  const courseId = props.courseId
  if (!courseId) return
  loading.value = true
  try {
    const { data } = await api.get(`/courses/${courseId}/summary`)
    if (String(props.courseId) !== String(courseId)) return
    assignments.value = data.assignments || []
    students.value = data.students || []
    syncSaved(data.config || {})
    await redeemFirstPreviews()
  } catch (error) {
    ElMessage.error(messageOf(error))
  } finally {
    loading.value = false
  }
}

function syncSaved(config) {
  const finalAssignment = assignments.value.find(
    (assignment) => Number(assignment.is_final) === 1,
  )
  savedConfig.value = {
    daily_ratio: Number(config.daily_ratio ?? 40),
    final_ratio: Number(config.final_ratio ?? 60),
    grade_absent_mode: config.grade_absent_mode === 'skip_ungraded' ? 'skip_ungraded' : 'zero',
    final_assignment_id: finalAssignment ? finalAssignment.id : null,
  }
  const weights = {}
  for (const assignment of assignments.value)
    weights[assignment.id] = Number(assignment.grade_weight ?? 0)
  savedConfig.value.weights = { ...weights }
  Object.assign(draft, {
    daily_ratio: savedConfig.value.daily_ratio,
    final_ratio: savedConfig.value.final_ratio,
    grade_absent_mode: savedConfig.value.grade_absent_mode,
    final_assignment_id: savedConfig.value.final_assignment_id,
    weights,
  })
}

// <img> 不携带登录头：批量换取短期票据，单次上限 200 张，超量分批。
async function redeemTickets(ids) {
  const need = [...new Set(ids)].filter((id) => !ticketCache.has(id))
  for (let index = 0; index < need.length; index += 200) {
    const { data } = await api.post('/previews/view-ticket', {
      ids: need.slice(index, index + 200),
    })
    for (const [id, ticket] of Object.entries(data.tickets || {}))
      ticketCache.set(Number(id), ticket || null)
  }
}
async function redeemFirstPreviews() {
  const ids = []
  for (const student of students.value)
    for (const assignment of assignments.value) {
      const cell = student.cells?.[assignment.id]
      if (cell?.previews?.length) ids.push(cell.previews[0].id)
    }
  if (!ids.length) return
  try {
    await redeemTickets(ids)
    applyTickets()
  } catch {
    /* 票据失败时缩略图不可见，分数与文件链接不受影响 */
  }
}
function applyTickets() {
  for (const student of students.value)
    for (const assignment of assignments.value) {
      for (const preview of student.cells?.[assignment.id]?.previews || []) {
        const ticket = ticketCache.get(preview.id)
        if (ticket) {
          preview.thumbnail = ticket.thumbnail
          preview.preview = ticket.file
        }
      }
    }
}

// —— 设置草稿与脏检查 ——

watch(
  () => draft.daily_ratio,
  (value) => {
    draft.final_ratio = Math.round((100 - Number(value || 0)) * 10) / 10
  },
)

function snapshotOf(source) {
  return JSON.stringify([
    Number(source.daily_ratio),
    Number(source.final_ratio),
    source.grade_absent_mode,
    source.final_assignment_id,
    assignments.value.map((assignment) => Number(source.weights?.[assignment.id] ?? 0)),
  ])
}
const dirty = computed(() => snapshotOf(draft) !== snapshotOf(savedConfig.value))

const visibleAssignments = computed(() =>
  showDraftColumns.value
    ? assignments.value
    : assignments.value.filter((assignment) => assignment.status !== 'draft'),
)
const finalCandidates = computed(() =>
  assignments.value.filter((assignment) => assignment.status !== 'draft'),
)
const weightRows = computed(() =>
  assignments.value.filter((assignment) => assignment.id !== Number(draft.final_assignment_id)),
)
// 平时各项占总成绩百分比之和（草稿与期末作业不参与）；服务端要求它必须等于平时占比才能保存。
const weightSum = computed(() => {
  let sum = 0
  for (const assignment of assignments.value) {
    if (assignment.id === Number(draft.final_assignment_id) || assignment.status === 'draft')
      continue
    const weight = Number(draft.weights?.[assignment.id] ?? 0)
    if (Number.isFinite(weight) && weight > 0) sum += weight
  }
  return Math.round(sum * 10) / 10
})
const dailyTarget = computed(() => Math.round(Number(draft.daily_ratio || 0) * 10) / 10)
const weightsMatch = computed(() => weightSum.value === dailyTarget.value)
const finalAssignment = computed(
  () =>
    assignments.value.find(
      (assignment) => assignment.id === Number(draft.final_assignment_id),
    ) || null,
)

const tableRows = computed(() => {
  const search = keyword.value.trim().toLowerCase()
  return students.value
    .filter(
      (student) =>
        !search ||
        String(student.username).toLowerCase().includes(search) ||
        String(student.name).toLowerCase().includes(search),
    )
    .map((student) => ({ ...student, live: computeScores(student.cells || {}) }))
})

// —— 三栏计算（与 server/src/services/summaryService.js 的 computeScores 保持同一公式） ——

const round1 = (value) => Math.round(value * 10) / 10
function normalize(score, total) {
  const numericTotal = Number(total),
    numericScore = Number(score)
  if (!Number.isFinite(numericTotal) || numericTotal <= 0 || !Number.isFinite(numericScore))
    return null
  return (numericScore / numericTotal) * 100
}
function computeScores(cells) {
  const mode = draft.grade_absent_mode
  let weighted = 0,
    gradedWeight = 0
  for (const assignment of assignments.value) {
    if (assignment.id === Number(draft.final_assignment_id) || assignment.status === 'draft')
      continue
    const weight = Number(draft.weights?.[assignment.id] ?? assignment.grade_weight ?? 0)
    if (!Number.isFinite(weight) || weight <= 0) continue
    const total = Number(assignment.total_score)
    if (!Number.isFinite(total) || total <= 0) continue
    const cell = cells[assignment.id]
    const graded =
      cell && !cell.not_assigned && cell.status === 'graded' && Number.isFinite(Number(cell.score))
    if (graded) {
      weighted += normalize(cell.score, total) * weight
      gradedWeight += weight
    } else if (!cell || cell.not_assigned || mode === 'zero') {
      gradedWeight += weight
    }
  }
  const dailyRaw = gradedWeight > 0 ? weighted / gradedWeight : null
  const finalAssignment = assignments.value.find(
    (assignment) =>
      assignment.id === Number(draft.final_assignment_id) && assignment.status !== 'draft',
  )
  let finalRaw = null
  if (finalAssignment) {
    const cell = cells[finalAssignment.id]
    if (
      cell &&
      !cell.not_assigned &&
      cell.status === 'graded' &&
      Number.isFinite(Number(cell.score))
    ) {
      finalRaw = normalize(cell.score, finalAssignment.total_score)
    }
  }
  const totalRaw =
    dailyRaw !== null && finalRaw !== null
      ? (dailyRaw * Number(draft.daily_ratio)) / 100 + (finalRaw * Number(draft.final_ratio)) / 100
      : dailyRaw !== null
        ? dailyRaw
        : finalRaw
  return { daily: dailyRaw, final: finalRaw, total: totalRaw }
}
// 与服务端 round1 一致：先舍入再补足一位小数，避免 toFixed 将 2.55 显示成 2.5。
const formatScore = (value) =>
  value === null || value === undefined || !Number.isFinite(Number(value))
    ? '—'
    : (Math.round(Number(value) * 10) / 10).toFixed(1)

async function saveConfig({ silent = false } = {}) {
  if (!weightsMatch.value) {
    ElMessage.warning(`平时各项占比之和（${weightSum.value}%）必须等于平时占比（${dailyTarget.value}%）`)
    return false
  }
  saving.value = true
  try {
    await api.put(`/courses/${props.courseId}/grade-config`, {
      daily_ratio: Number(draft.daily_ratio),
      final_ratio: Number(draft.final_ratio),
      grade_absent_mode: draft.grade_absent_mode,
      final_assignment_id: draft.final_assignment_id || null,
      weights: assignments.value.map((assignment) => ({
        assignment_id: assignment.id,
        grade_weight: Number(draft.weights?.[assignment.id] ?? 1),
      })),
    })
    await load()
    if (!silent) ElMessage.success('成绩设置已保存')
    return true
  } catch (error) {
    ElMessage.error(messageOf(error))
    return false
  } finally {
    saving.value = false
  }
}

async function exportExcel() {
  if (dirty.value && !props.readonly) {
    const ok = await saveConfig({ silent: true })
    if (!ok) return
    ElMessage.success('未保存的成绩设置已随导出一并保存')
  }
  exporting.value = true
  try {
    const response = await api.get(`/courses/${props.courseId}/summary/export`, {
      responseType: 'blob',
      timeout: 0,
    })
    downloadBlob(response.data, `${props.courseName || '课程'}-成绩汇总.xlsx`)
  } catch (error) {
    ElMessage.error(messageOf(error))
  } finally {
    exporting.value = false
  }
}

// 平均分配：把平时占比均分到各已发布平时作业（误差落在最后一项），草稿作业清 0。
function distributeEvenly() {
  const rows = weightRows.value.filter((assignment) => assignment.status !== 'draft')
  const each = rows.length ? Math.round((dailyTarget.value / rows.length) * 10) / 10 : 0
  let assigned = 0
  for (const assignment of weightRows.value) {
    if (assignment.status === 'draft') {
      draft.weights[assignment.id] = 0
      continue
    }
    const isLast = assignment.id === rows[rows.length - 1].id
    const value = isLast
      ? Math.max(0, Math.round((dailyTarget.value - assigned) * 10) / 10)
      : each
    draft.weights[assignment.id] = value
    assigned = Math.round((assigned + value) * 10) / 10
  }
}

// —— 行内改分（复用现有批改接口，覆盖旧分并把状态置为已评分） ——

function startEdit(student, assignment) {
  const cell = student.cells?.[assignment.id]
  if (!cell || cell.not_assigned || !cell.id || props.readonly) return
  editingKey.value = `${student.id}:${assignment.id}`
  editValue.value = cell.status === 'graded' ? cell.score : null
}
async function confirmEdit(student, assignment) {
  const key = `${student.id}:${assignment.id}`
  if (editingKey.value !== key) return
  editingKey.value = ''
  const cell = student.cells?.[assignment.id]
  if (!cell || !cell.id) return
  const score = Number(editValue.value)
  if (
    editValue.value === null ||
    editValue.value === '' ||
    !Number.isFinite(score) ||
    score < 0 ||
    score > Number(assignment.total_score)
  ) {
    ElMessage.warning(`成绩必须在 0 到 ${assignment.total_score} 之间`)
    return
  }
  try {
    await api.post(cell.api_base + '/grade', { score, comment: cell.comment || '' })
    cell.score = score
    cell.status = 'graded'
    cell.returned_reason = ''
    ElMessage.success('成绩已保存')
  } catch (error) {
    ElMessage.error(messageOf(error))
  }
}

// —— 看图评分工作区（完整功能：翻图、放大、改分、评语、退回） ——

function workspaceRowOf(student, cell) {
  return {
    ...cell,
    name: cell.group_name || student.name,
    username: cell.group_name || student.username,
  }
}
async function openWorkspace(student, assignment) {
  const cell = student.cells?.[assignment.id]
  if (!cell || cell.not_assigned || !cell.id) return
  try {
    await redeemTickets((cell.previews || []).map((preview) => preview.id))
    applyTickets()
  } catch {
    /* 打开工作区不依赖票据，图片加载失败时仍有文件链接 */
  }
  workspaceRow.value = workspaceRowOf(student, cell)
  workspaceAssignment.value = assignment
  workspaceRows.value = students.value
    .map((student) => student.cells?.[assignment.id])
    .filter((cell) => cell && !cell.not_assigned && cell.id)
    .map((cell) =>
      workspaceRowOf(
        students.value.find((student) => student.cells?.[assignment.id] === cell),
        cell,
      ),
    )
  workspace.value = true
}
function findCellByApiBase(apiBase) {
  for (const student of students.value)
    for (const assignment of assignments.value) {
      const cell = student.cells?.[assignment.id]
      if (cell && cell.api_base === apiBase) return { student, assignment, cell }
    }
  return null
}
async function onWorkspaceSaved(row, advance) {
  await load()
  const found = findCellByApiBase(row?.api_base)
  if (found) {
    workspaceRow.value = workspaceRowOf(found.student, found.cell)
    workspaceAssignment.value = found.assignment
    if (advance) {
      workspaceRows.value = students.value
        .map((student) => student.cells?.[found.assignment.id])
        .filter((cell) => cell && !cell.not_assigned && cell.id)
        .map((cell) =>
          workspaceRowOf(
            students.value.find((student) => student.cells?.[found.assignment.id] === cell),
            cell,
          ),
        )
    }
  } else {
    workspace.value = false
  }
}

const statusLabel = (cell) => ({ submitted: '待批改', returned: '已退回' })[cell.status] || '未评分'
</script>

<template>
  <div v-loading="loading">
    <div class="toolbar summary-toolbar">
      <div class="config-group">
        <span class="label">期末作业</span>
        <el-select
          v-model="draft.final_assignment_id"
          clearable
          placeholder="未指定"
          style="width: 200px"
          :disabled="readonly"
        >
          <el-option
            v-for="assignment in finalCandidates"
            :key="assignment.id"
            :label="assignment.title"
            :value="assignment.id"
          />
        </el-select>
        <span class="label">平时占比</span>
        <el-input-number
          v-model="draft.daily_ratio"
          :min="0"
          :max="100"
          :step="5"
          :disabled="readonly"
          style="width: 110px"
        />
        <span class="hint">%</span>
        <span class="hint">期末 {{ draft.final_ratio }}%</span>
        <el-select v-model="draft.grade_absent_mode" style="width: 210px" :disabled="readonly">
          <el-option label="未交、未评均按 0 分计入" value="zero" />
          <el-option label="未评不计入，未交按 0 分计入" value="skip_ungraded" />
        </el-select>
        <el-button :disabled="readonly" @click="showWeights = true">占比设置</el-button>
      </div>
      <div class="config-group">
        <el-input v-model="keyword" clearable placeholder="搜索学号或姓名" style="width: 200px" />
        <el-checkbox v-model="showDraftColumns">显示草稿作业</el-checkbox>
        <el-button
          type="primary"
          color="#15554e"
          :disabled="!dirty || readonly || !weightsMatch"
          :loading="saving"
          @click="saveConfig()"
          >保存设置</el-button
        >
        <el-button :loading="exporting" @click="exportExcel">导出成绩表</el-button>
      </div>
    </div>
    <el-alert
      v-if="dirty && !readonly"
      title="成绩设置已修改但尚未保存：三栏成绩为按当前设置的预览值，导出前会自动保存。"
      type="warning"
      show-icon
      :closable="false"
      style="margin-bottom: 12px"
    />
    <div class="summary-hint hint">
      点击图片打开看图评分（可翻看全部图片、改分、评语、退回）；点击分数可直接修改。三栏均为百分制，保留
      1 位小数<span v-if="!finalAssignment">；尚未指定期末作业，总成绩暂按平时成绩</span
      ><span v-else>；期末未评分的学生总成绩暂按平时成绩</span>。
    </div>

    <el-table :data="tableRows" stripe border size="default" class="summary-table">
      <el-table-column prop="username" label="学号" width="130" fixed="left" />
      <el-table-column prop="name" label="姓名" width="100" fixed="left">
        <template #default="{ row }">
          {{ row.name }}
          <el-tag v-if="row.status !== 'active'" size="small" type="info" style="margin-left: 4px"
            >停用</el-tag
          >
        </template>
      </el-table-column>
      <el-table-column
        v-for="assignment in visibleAssignments"
        :key="assignment.id"
        :label="assignment.title"
        min-width="170"
        align="center"
      >
        <template #header>
          <div class="col-head">
            <span class="col-title">{{ assignment.title }}</span>
            <span class="col-tags">
              <el-tag
                v-if="assignment.id === Number(draft.final_assignment_id)"
                size="small"
                type="danger"
                >期末</el-tag
              >
              <el-tag v-else size="small" type="info"
                >占比 {{ draft.weights?.[assignment.id] ?? 0 }}%</el-tag
              >
              <el-tag v-if="assignment.status === 'draft'" size="small" type="warning"
                >草稿</el-tag
              >
            </span>
          </div>
        </template>
        <template #default="{ row }">
          <template v-if="row.cells[assignment.id] && row.cells[assignment.id].id">
            <div class="cell-box">
              <div
                v-if="row.cells[assignment.id].previews?.length"
                class="thumb-wrap"
                title="点击打开看图评分"
                @click="openWorkspace(row, assignment)"
              >
                <img
                  :src="
                    row.cells[assignment.id].previews[0].thumbnail ||
                    row.cells[assignment.id].previews[0].preview
                  "
                  class="cell-thumb"
                  alt=""
                  loading="lazy"
                />
                <span v-if="row.cells[assignment.id].preview_count > 1" class="thumb-badge"
                  >{{ row.cells[assignment.id].preview_count }}张</span
                >
              </div>
              <el-button v-else link type="primary" @click="openWorkspace(row, assignment)">{{
                row.cells[assignment.id].file_name || '在线作答'
              }}</el-button>
              <div class="score-line">
                <template v-if="editingKey === `${row.id}:${assignment.id}`">
                  <el-input-number
                    v-model="editValue"
                    :min="0"
                    :max="assignment.total_score"
                    size="small"
                    style="width: 110px"
                    @keyup.enter="confirmEdit(row, assignment)"
                    @blur="confirmEdit(row, assignment)"
                  />
                </template>
                <template v-else>
                  <span
                    v-if="row.cells[assignment.id].status === 'graded'"
                    class="score"
                    :title="readonly ? '' : '点击修改成绩'"
                    @click="startEdit(row, assignment)"
                    >{{ row.cells[assignment.id].score
                    }}<span v-if="row.cells[assignment.id].is_late" class="late-mark">迟</span></span
                  >
                  <span
                    v-else
                    class="score pending"
                    :title="readonly ? '' : '点击直接评分'"
                    @click="startEdit(row, assignment)"
                    >{{ statusLabel(row.cells[assignment.id]) }}</span
                  >
                </template>
              </div>
              <div
                v-if="row.cells[assignment.id].group_name"
                class="cell-sub hint"
                :title="
                  (row.cells[assignment.id].members || [])
                    .map((member) => member.name + '（' + member.username + '）')
                    .join('、')
                "
              >
                {{ row.cells[assignment.id].group_name }}
              </div>
            </div>
          </template>
          <span
            v-else-if="row.cells[assignment.id] && row.cells[assignment.id].not_assigned"
            class="cell-empty hint"
            >未安排</span
          >
          <span v-else class="cell-empty hint">未交</span>
        </template>
      </el-table-column>
      <el-table-column label="平时成绩" width="100" fixed="right" align="center">
        <template #default="{ row }"
          ><b>{{ formatScore(row.live.daily) }}</b></template
        >
      </el-table-column>
      <el-table-column label="期末成绩" width="100" fixed="right" align="center">
        <template #default="{ row }"
          ><b>{{ formatScore(row.live.final) }}</b></template
        >
      </el-table-column>
      <el-table-column label="总成绩" width="100" fixed="right" align="center">
        <template #default="{ row }"
          ><b class="total">{{ formatScore(row.live.total) }}</b></template
        >
      </el-table-column>
      <template #empty>
        <div class="empty">课程里还没有学生或作业。</div>
      </template>
    </el-table>

    <el-dialog v-model="showWeights" title="成绩占比设置（平时作业）" width="min(560px,94vw)">
      <p class="hint" style="margin-top: 0">
        每项填该作业占总成绩的百分比；为 0 表示该作业不计入成绩。各项之和必须等于上方「平时占比」，
        例如平时占比 30%、三次作业各占 10%。总成绩 = Σ(作业折算分×占比) + 期末折算分×期末占比。
      </p>
      <el-table :data="weightRows" size="small" max-height="420">
        <el-table-column prop="title" label="作业" min-width="200">
          <template #default="{ row }">
            {{ row.title }}
            <el-tag v-if="row.status === 'draft'" size="small" type="warning">草稿</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="total_score" label="满分" width="80" align="center" />
        <el-table-column label="占总成绩 %" width="160" align="center">
          <template #default="{ row }">
            <el-input-number
              v-model="draft.weights[row.id]"
              :min="0"
              :max="100"
              :step="1"
              :precision="1"
              :disabled="readonly"
              style="width: 130px"
            />
          </template>
        </el-table-column>
      </el-table>
      <p class="hint" :class="{ 'sum-mismatch': !weightsMatch }">
        平时合计 {{ weightSum }}%<span v-if="weightsMatch">，与平时占比（{{ dailyTarget }}%）一致</span
        ><span v-else>
          ，与平时占比（{{ dailyTarget }}%）不一致，调整一致后才能保存</span
        >
      </p>
      <p v-if="finalAssignment" class="hint">
        期末作业「{{ finalAssignment.title }}」单独作为期末成绩（占 {{ draft.final_ratio }}%），不参与占比设置。
      </p>
      <template #footer>
        <el-button :disabled="readonly" @click="distributeEvenly">平均分配</el-button>
        <el-button type="primary" color="#15554e" @click="showWeights = false">完成</el-button>
      </template>
    </el-dialog>

    <GradeWorkspace
      v-model="workspace"
      :row="workspaceRow"
      :rows="workspaceRows"
      :assignment="workspaceAssignment"
      @saved="onWorkspaceSaved"
    />
  </div>
</template>

<style scoped>
.summary-toolbar {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}
.config-group {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.config-group .label {
  color: #40605a;
  font-size: 13px;
}
.summary-hint {
  margin: 0 0 12px;
}
.summary-table {
  width: 100%;
}
.col-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: center;
}
.col-title {
  font-weight: 600;
  line-height: 1.3;
  word-break: break-all;
}
.col-tags {
  display: flex;
  gap: 4px;
}
.cell-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 6px 0;
}
.thumb-wrap {
  position: relative;
  cursor: zoom-in;
  line-height: 0;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--line);
}
.cell-thumb {
  width: 88px;
  height: 64px;
  object-fit: cover;
  display: block;
}
.thumb-badge {
  position: absolute;
  right: 4px;
  bottom: 4px;
  background: rgba(21, 85, 78, 0.85);
  color: #fff;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 8px;
  line-height: 1.5;
}
.score {
  cursor: pointer;
  color: #15554e;
  font-weight: 600;
  border-bottom: 1px dashed #9ab8b2;
}
.score:hover {
  color: #0d3b36;
}
.score.pending {
  color: #b58a2a;
  font-weight: 400;
  border-bottom: none;
}
.late-mark {
  margin-left: 4px;
  font-size: 11px;
  color: #c45656;
  border: 1px solid #c45656;
  border-radius: 4px;
  padding: 0 3px;
  font-weight: 400;
}
.cell-empty {
  display: inline-block;
  padding: 24px 0;
}
.cell-sub {
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.total {
  color: #15554e;
}
.sum-mismatch {
  color: #a43f35;
}
</style>
