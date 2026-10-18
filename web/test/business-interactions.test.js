import test from 'node:test'
import assert from 'node:assert/strict'
import { reactive, ref } from 'vue'
import { useGradeSettings } from '../src/composables/useGradeSettings.js'
import { useSummaryWorkspace } from '../src/composables/useSummaryWorkspace.js'
import {
  serializeRequiredQuestions,
  serializeRequiredAnswers,
} from '@university-homework/domain/requiredAnswers'
import {
  mountView,
  nodes,
  textOf,
  button,
  click,
  input,
  settle,
  waitFor,
} from './helpers/view-harness.js'

const failure = (message, status = 500) =>
  Object.assign(new Error(message), { response: { status, data: { message } } })
const assignment = (extra) => ({
  id: 1,
  course_id: 1,
  title: '设计作业',
  course_name: '设计课',
  type: 'online',
  status: 'published',
  course_status: 'active',
  total_score: 100,
  allow_resubmit_count: 1,
  submission_mode: 'overwrite',
  ...extra,
})

test('作业卡片：待批改只显示份数，不显示总人数', async () => {
  const view = await mountView('components/CourseAssignmentsPanel.vue', {
    props: {
      assignments: [
        {
          id: 1,
          title: '第一次作业',
          status: 'published',
          unsubmitted_count: 2,
          expected_count: 28,
          pending_review_count: 3,
        },
        {
          id: 2,
          title: '第二次作业',
          status: 'published',
          unsubmitted_count: 1,
          expected_count: 28,
          pending_review_count: 5,
        },
      ],
      course: { id: 1, status: 'active' },
    },
  })
  const content = textOf(view.root)
  assert.match(content, /待批改 3 份/)
  assert.match(content, /待批改 5 份/)
  assert.doesNotMatch(content, /\/(?:28)\s*待批改/)
})

async function student({
  a = {},
  context = {},
  saved = null,
  policy = {},
  run = async () => ({ receipt_no: 'R-1', submit_count: 1 }),
  confirm,
} = {}) {
  const calls = []
  const upload = {
    busy: ref(false),
    phase: ref('idle'),
    canPause: ref(false),
    canCancel: ref(false),
    percent: ref(0),
    state: ref(''),
    pending: ref(false),
    loaded: ref(0),
    total: ref(null),
    run: async (args) => {
      calls.push(args)
      return run(args)
    },
  }
  const view = await mountView('views/student/StudentSubmit.vue', {
    confirm,
    dependencies: { '../../composables/useChunkedUpload.js': { useChunkedUpload: () => upload } },
    handler: async (config) => {
      if (config.url.endsWith('/student-page'))
        return {
          assignment: assignment(a),
          context: { can_submit: true, ...context },
          submission: saved,
        }
      if (config.url.endsWith('/submission-policy'))
        return {
          server_now: '2026-10-16 12:00:00',
          effective_deadline: context.effective_deadline || null,
          is_late: false,
          can_submit: context.can_submit !== false,
          ...policy,
        }
      throw Error('Unexpected request ' + config.url)
    },
  })
  return { ...view, calls, upload }
}

test('提交页：空答案阻止发送，成功显示回执并清除文字草稿', async () => {
  const view = await student()
  await click(button(view, '确认提交'))
  assert.equal(view.calls.length, 0)
  assert.match(view.messages.at(-1).text, /填写在线/)
  await input(nodes(view.root, 'el-input')[0], '我的答案')
  await waitFor(() => sessionStorage.values().includes('我的答案'), '文字草稿保存')
  await click(button(view, '确认提交'))
  assert.equal(view.calls[0].metadata.content, '我的答案')
  assert.equal(view.calls[0].baseVersion, 0)
  assert.match(textOf(view.root), /R-1/)
  assert.ok(!sessionStorage.values().includes('我的答案'))
})

test('提交页：切换作业且新页面加载缓慢时，旧草稿不会写入新作业', async (t) => {
  const route = reactive({ params: { id: '1' } })
  let updateGuard, releaseNextPage
  const view = await mountView('views/student/StudentSubmit.vue', {
    dependencies: {
      'vue-router': {
        useRoute: () => route,
        useRouter: () => ({ push() {} }),
        onBeforeRouteLeave() {},
        onBeforeRouteUpdate: (guard) => {
          updateGuard = guard
        },
      },
    },
    handler: async (config) => {
      if (config.url === '/assignments/1/student-page')
        return { assignment: assignment(), context: { can_submit: true }, submission: null }
      if (config.url === '/assignments/2/student-page')
        return new Promise((resolve) => {
          releaseNextPage = () =>
            resolve({
              assignment: assignment({ id: 2 }),
              context: { can_submit: true },
              submission: null,
            })
        })
      throw Error('Unexpected request ' + config.url)
    },
  })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  window.setTimeout = setTimeout
  try {
    await input(nodes(view.root, 'el-input')[0], '只属于第一份作业的答案')
    assert.equal(await updateGuard({ params: { id: '2' } }, { params: { id: '1' } }), true)
    route.params.id = '2'
    await settle()
    assert.equal(typeof releaseNextPage, 'function')
    t.mock.timers.tick(400)
    assert.equal(sessionStorage.getItem('draft:submission:guest:1'), '只属于第一份作业的答案')
    assert.equal(sessionStorage.getItem('draft:submission:guest:2'), null)
    releaseNextPage()
    await settle()
    assert.equal(nodes(view.root, 'el-input')[0].props.modelValue, '')
  } finally {
    view.dispose()
    t.mock.timers.reset()
  }
})

test('提交页：题目规范显示在答案框占位提示中，全部题目填写后才能提交', async () => {
  const questions = serializeRequiredQuestions([
    {
      id: 'time',
      title: '你完成作业用了多少时间？',
      guidance: '以小时为单位，保留一位小数。',
      maxChars: 20,
    },
    { id: 'reflection', title: '你遇到的主要困难是什么？', guidance: '写明问题和解决方法。' },
  ])
  const view = await student({ a: { required_answer: questions } })
  const fields = nodes(view.root, 'el-input')
  assert.match(textOf(view.root), /必答题目 1/)
  assert.match(textOf(view.root), /必答题目 2/)
  assert.doesNotMatch(textOf(view.root), /必填|答题规范（老师设置）/)
  assert.equal(fields.length, 2)
  assert.equal(fields[0].props.placeholder, '以小时为单位，保留一位小数。')
  assert.equal(fields[0].props.maxlength, 20)
  assert.equal(fields[1].props.placeholder, '写明问题和解决方法。')
  assert.equal(fields[1].props.maxlength, 5000)
  assert.equal(button(view, '确认提交').props.disabled, true)
  await input(fields[0], '2.5小时')
  assert.equal(button(view, '确认提交').props.disabled, true)
  await input(fields[1], '困难：配色。解决：比较三种方案。')
  await click(button(view, '确认提交'))
  assert.equal(view.calls[0].metadata.answer_question, questions)
  assert.deepEqual(
    JSON.parse(view.calls[0].metadata.content).answers.map((answer) => answer.content),
    ['2.5小时', '困难：配色。解决：比较三种方案。'],
  )
})

test('提交页：旧版单题仍显示原规范并提交普通文字答案', async () => {
  const view = await student({ a: { required_answer: '请填写总用时，单位为小时。' } })
  assert.match(textOf(view.root), /请填写总用时，单位为小时。/)
  assert.equal(nodes(view.root, 'el-input')[0].props.maxlength, 5000)
  await input(nodes(view.root, 'el-input')[0], '3小时')
  await click(button(view, '确认提交'))
  assert.equal(view.calls[0].metadata.content, '3小时')
})

test('提交记录：按提交时的规范逐题显示答案，不展示序列化内容', async () => {
  const questions = serializeRequiredQuestions([
    { id: 'time', title: '总用时？', guidance: '请用小时回答。' },
  ])
  const content = serializeRequiredAnswers(questions, { time: '2小时' })
  const view = await mountView('components/RequiredAnswerContent.vue', {
    props: { questions, content },
  })
  assert.match(textOf(view.root), /总用时？/)
  assert.match(textOf(view.root), /请用小时回答。/)
  assert.match(textOf(view.root), /2小时/)
  assert.doesNotMatch(textOf(view.root), /required-answers|"version"/)
})

test('提交检查：只展示逐题填写、源文件和预览图三类结果，通过时使用简短文案', async () => {
  const view = await student({
    a: {
      type: 'document',
      required_answer: serializeRequiredQuestions([
        { id: 'time', title: '完成用时？', guidance: '' },
      ]),
      max_file_mb: 10,
      allowed_extensions: 'dwg',
      require_preview_image: 1,
      preview_max_count: 1,
    },
  })
  const checks = () => {
    const section = nodes(view.root, 'section').find((n) => n.props['aria-label'] === '提交检查')
    return nodes(section, 'li').map((n) => textOf(n).trim())
  }
  assert.deepEqual(checks(), [
    '× 尚未回答第1道必答题目',
    '× 尚未选择源文件',
    '× 尚未选择预览图（最多 1 张）',
  ])
  await input(nodes(view.root, 'el-input')[0], '2小时')
  await input(nodes(view.root, 'FileDropZone')[0], new File(['drawing'], 'design.dwg'))
  await input(nodes(view.root, 'PreviewImagePicker')[0], [new File(['png'], 'preview.png')])
  assert.deepEqual(checks(), [
    '✓ 第1道必答题目已填写',
    '✓ 源文件已上传并符合要求',
    '✓ 预览图上传并符合要求',
  ])
  assert.equal(button(view, '确认提交').props.disabled, false)
  await input(nodes(view.root, 'PreviewImagePicker')[0], [
    new File(['png'], 'one.png'),
    new File(['png'], 'two.png'),
  ])
  assert.equal(checks()[2], '× 预览图超过最多 1 张')
  assert.equal(button(view, '确认提交').props.disabled, true)
})

test('提交页：文件后缀、大小与必需预览图控制提交按钮', async () => {
  const view = await student({
    a: {
      type: 'document',
      max_file_mb: 10,
      allowed_extensions: 'dwg',
      require_preview_image: 1,
      preview_max_count: 2,
    },
  })
  assert.equal(button(view, '确认提交').props.disabled, true)
  await input(nodes(view.root, 'FileDropZone')[0], new File(['bad'], 'bad.exe'))
  assert.match(view.messages.at(-1).text, /后缀/)
  assert.equal(nodes(view.root, 'FileDropZone')[0].props.modelValue, null)
  await input(nodes(view.root, 'FileDropZone')[0], {
    name: 'large.dwg',
    size: 10 * 1024 * 1024 + 1,
  })
  assert.match(view.messages.at(-1).text, /不超过 10M/)
  const source = new File(['drawing'], 'design.dwg'),
    preview = new File(['png'], 'preview.png')
  await input(nodes(view.root, 'FileDropZone')[0], source)
  assert.equal(button(view, '确认提交').props.disabled, true)
  await input(nodes(view.root, 'PreviewImagePicker')[0], [preview])
  await click(button(view, '确认提交'))
  assert.deepEqual(
    view.calls[0].files.map((x) => [x.role, x.order, x.file.name]),
    [
      ['source', 0, 'design.dwg'],
      ['preview', 1, 'preview.png'],
    ],
  )
  assert.deepEqual(view.calls[0].fallback.fields, {
    content: '',
    answer_question: '',
    base_version: 0,
  })
  assert.equal(view.calls[0].fallback.file.name, 'design.dwg')
  assert.equal(view.calls[0].fallback.extraFiles[0].name, 'preview.png')
})

for (const [name, a, context, saved] of [
  ['课程归档', { course_status: 'archived' }, { can_submit: false }, null],
  ['作业关闭', { status: 'closed' }, { can_submit: false }, null],
  ['非小组提交人', {}, { can_submit: false, group: { name: '甲组' }, members: [] }, null],
  [
    '自行重交次数用尽',
    { allow_resubmit_count: 0 },
    {},
    { submit_count: 1, resubmit_count: 0, status: 'submitted' },
  ],
  ['已经评分', {}, {}, { submit_count: 1, resubmit_count: 0, status: 'graded' }],
])
  test('提交页权限：' + name + '禁用输入和提交', async () => {
    const view = await student({ a, context, saved })
    if (saved) {
      if (saved.status === 'graded') {
        assert.equal(
          nodes(view.root, 'el-button').some((node) => textOf(node).includes('等待老师退回重做')),
          false,
        )
        assert.match(textOf(view.root), /作业已完成批改，提交已完成/)
      } else {
        assert.equal(button(view, '修改提交').props.disabled, true)
      }
      assert.equal(nodes(view.root, 'el-input').length, 0)
    } else {
      assert.equal(button(view, '确认提交').props.disabled, true)
      assert.equal(nodes(view.root, 'el-input')[0].props.disabled, true)
    }
    assert.equal(view.calls.length, 0)
  })

test('提交页：覆盖确认取消不上传，网络失败保留草稿且可重试', async () => {
  let cancelled = true,
    confirmations = 0,
    failed = true
  const view = await student({
    saved: { content: '旧答案', submit_count: 1, status: 'submitted' },
    confirm: async () => {
      confirmations++
      if (cancelled) throw Error('cancel')
    },
    run: async () => {
      if (failed) throw failure('网络中断')
      return { receipt_no: 'R-retry' }
    },
  })
  await click(button(view, '修改提交'))
  await input(nodes(view.root, 'el-input')[0], '修订答案')
  await click(button(view, '确认提交修改'))
  assert.equal(view.calls.length, 0)
  cancelled = false
  await click(button(view, '确认提交修改'))
  assert.equal(button(view, '请按上方提示处理').props.loading, false)
  assert.equal(nodes(view.root, 'el-input')[0].props.modelValue, '修订答案')
  assert.match(textOf(view.root), /网络中断/)
  assert.match(textOf(view.root), /问题编号/)
  failed = false
  await click(button(view, '按当前内容重试'))
  assert.equal(view.calls.length, 2)
  assert.equal(view.calls[1].baseVersion, 1)
  assert.equal(view.calls[1].clientReference, view.calls[0].clientReference)
  assert.equal(confirmations, 2, '同一内容重试不重复弹确认框')
  assert.match(textOf(view.root), /R-retry/)
})

test('提交页：409冲突不自动重发，保留答案并提供刷新入口', async () => {
  const view = await student({
    run: async () => {
      throw failure('已有更新的提交记录', 409)
    },
  })
  await input(nodes(view.root, 'el-input')[0], '保留的答案')
  await click(button(view, '确认提交'))
  assert.equal(view.calls.length, 1)
  assert.ok(
    nodes(view.root, 'el-alert').some((n) => String(n.props.title).includes('提交状态冲突')),
  )
  await click(button(view, '获取最新状态'))
  assert.equal(nodes(view.root, 'el-input')[0].props.modelValue, '保留的答案')
  assert.equal(view.calls.length, 1)
})

test('提交页：按钮虽按本地时钟显示迟交，但最终以服务器预检判定为准', async () => {
  let confirmations = 0
  const deadline = '2020-01-01 00:00:00'
  const view = await student({
    context: { effective_deadline: deadline },
    policy: {
      server_now: '2019-12-31 23:59:00',
      effective_deadline: deadline,
      is_late: false,
      can_submit: true,
    },
    confirm: async () => {
      confirmations++
    },
  })
  await input(nodes(view.root, 'el-input')[0], '截止前提交')
  assert.equal(button(view, '仍要迟交').props.disabled, false)
  await click(button(view, '仍要迟交'))
  assert.equal(confirmations, 0)
  assert.equal(view.calls.length, 1)
})

const row = (extra) => ({
  id: 10,
  username: 's1',
  name: '学生甲',
  status: 'submitted',
  submit_count: 1,
  api_base: '/submissions/10',
  content: '答案',
  score: null,
  previews: [],
  ...extra,
})
async function grading({ archived = false, reject = false } = {}) {
  let record = row(),
    rejectSave = reject
  const view = await mountView('views/teacher/SubmissionsView.vue', {
    route: { params: { id: '1' }, query: { filter: 'submitted' } },
    handler: async (config, body) => {
      if (config.url === '/assignments/1')
        return assignment({ course_status: archived ? 'archived' : 'active' })
      if (config.url.endsWith('/submissions')) {
        const params = config.params || {}
        const matchesKeyword =
          !params.keyword || `${record.name} ${record.username}`.includes(params.keyword)
        const matchesStatus = !params.status || record.status === params.status
        return {
          rows: matchesKeyword && matchesStatus ? [structuredClone(record)] : [],
          total: matchesKeyword && matchesStatus ? 1 : 0,
          page: 1,
          page_size: 50,
          counts: {},
          stats: {},
        }
      }
      if (config.method === 'post' && /\/batch-(grade|return)$/.test(config.url)) {
        if (rejectSave) throw failure('保存失败')
        record = {
          ...record,
          ...(config.url.endsWith('/batch-return')
            ? { returned_reason: body.returned_reason }
            : { score: body.score, comment: body.comment }),
          status: config.url.endsWith('/batch-return') ? 'returned' : 'graded',
        }
        return {
          results: [{ id: record.id, kind: 'individual', success: true, message: 'ok' }],
          success_count: 1,
          failure_count: 0,
        }
      }
      throw Error('Unexpected ' + config.url)
    },
  })
  return {
    ...view,
    recover: () => {
      rejectSave = false
    },
  }
}

test('批改页：打开评分、拒绝越界、保存0分、刷新列表并清理草稿', async () => {
  const view = await grading()
  await click(button(view, '评分'))
  await input(nodes(view.root, 'el-input-number')[0], 101)
  await click(button(view, '保存评分'))
  assert.equal(view.requests.filter((r) => r.method === 'post').length, 0)
  await input(nodes(view.root, 'el-input-number')[0], 0)
  await input(
    nodes(view.root, 'el-input').find((n) => n.props.type === 'textarea'),
    '需改进',
  )
  await click(button(view, '保存评分'))
  assert.deepEqual(view.requests.find((r) => r.method === 'post').body, {
    score: 0,
    comment: '需改进',
    items: [{ id: 10, kind: 'individual', expected_status: 'submitted', expected_submit_count: 1 }],
  })
  assert.equal(nodes(view.root, 'el-dialog').length, 0)
  await input(nodes(view.root, 'el-radio-group')[0], 'graded')
  assert.equal(nodes(view.root, 'el-table')[0].props.data[0].status, 'graded')
  assert.deepEqual(sessionStorage.values(), [])
})

test('批改页：普通关闭保留未保存草稿，重新打开可继续编辑', async () => {
  const view = await grading()
  await click(button(view, '评分'))
  await input(nodes(view.root, 'el-input-number')[0], 75)
  await input(
    nodes(view.root, 'el-input').find((n) => n.props.type === 'textarea'),
    '补充说明',
  )
  await click(button(view, '关闭'))
  assert.ok(sessionStorage.values().some((value) => value.includes('补充说明')))
  await click(button(view, '评分'))
  assert.equal(nodes(view.root, 'el-input-number')[0].props.modelValue, 75)
  assert.equal(
    nodes(view.root, 'el-input').find((n) => n.props.type === 'textarea').props.modelValue,
    '补充说明',
  )
  assert.equal(view.requests.filter((request) => request.method === 'post').length, 0)
})

test('批改页：保存失败留在弹窗保留草稿，恢复后退回原因发送正确', async () => {
  const view = await grading({ reject: true })
  await click(button(view, '退回'))
  await input(
    nodes(view.root, 'el-input').find((n) => n.props.type === 'textarea'),
    '补充图纸',
  )
  await click(button(view, '确认退回'))
  assert.equal(nodes(view.root, 'el-dialog').length, 1)
  assert.equal(button(view, '确认退回').props.loading, false)
  assert.ok(sessionStorage.values().some((v) => v.includes('补充图纸')))
  view.recover()
  await click(button(view, '确认退回'))
  assert.equal(
    view.requests.filter((r) => r.method === 'post').at(-1).url,
    '/assignments/1/batch-return',
  )
  await input(nodes(view.root, 'el-radio-group')[0], 'returned')
  assert.equal(nodes(view.root, 'el-table')[0].props.data[0].returned_reason, '补充图纸')
})

test('批改页：归档禁止评分和退回，筛选及搜索仍可用', async () => {
  const view = await grading({ archived: true })
  assert.equal(button(view, '评分').props.disabled, true)
  assert.equal(button(view, '退回').props.disabled, true)
  await input(nodes(view.root, 'el-radio-group')[0], 'graded')
  assert.equal(nodes(view.root, 'el-table')[0].props.data.length, 0)
  await input(nodes(view.root, 'el-radio-group')[0], 'submitted')
  await input(nodes(view.root, 'el-input')[0], '不存在')
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(nodes(view.root, 'el-table')[0].props.data.length, 0)
})

test('批改页：只保留评分和退回，未交记录不能批量评分', async () => {
  const submitted = row(),
    absent = { id: null, kind: 'individual', student_id: 12, name: '未交学生', status: null }
  const view = await mountView('views/teacher/SubmissionsView.vue', {
    handler: async (config, body) => {
      if (config.url === '/assignments/1') return assignment()
      if (config.url.endsWith('/submissions'))
        return {
          rows: [submitted, absent],
          total: 2,
          page: 1,
          page_size: 50,
          counts: { all: 2, submitted: 1, unsubmitted: 1 },
          stats: { all: 2, submitted: 1, unsubmitted: 1, graded: 0 },
        }
      if (config.url.endsWith('/batch-grade'))
        return {
          results: body.items.map((item) => ({ ...item, success: true, message: '已保存' })),
          success_count: body.items.length,
          failure_count: 0,
        }
      throw Error('Unexpected ' + config.url)
    },
  })
  const table = nodes(view.root, 'el-table')[0]
  table.props.onSelectionChange([submitted])
  await settle()
  await click(button(view, '评分（1）'))
  assert.deepEqual(view.requests.find((request) => request.url.endsWith('/batch-grade')).body, {
    items: [{ id: 10, kind: 'individual', expected_status: 'submitted', expected_submit_count: 1 }],
    score: 88,
  })

  table.props.onSelectionChange([absent])
  await settle()
  assert.equal(button(view, '评分（0）').props.disabled, true)
  assert.equal(button(view, '退回（0）').props.disabled, true)
  assert.doesNotMatch(textOf(view.root), /未交记 0 分|缺预览|全部（/)
  assert.deepEqual(
    nodes(view.root, 'el-radio-button')
      .map(textOf)
      .map((text) => text.replace(/（.*$/, '')),
    ['未交', '待批改', '已退回', '已经评分'],
  )
  assert.equal(nodes(view.root, 'el-checkbox').length, 0)
})

test('迟交只作为独立筛选，可与不同批改状态组合', async () => {
  const view = await mountView('views/teacher/SubmissionsView.vue', {
    route: { params: { id: '1' }, query: { filter: 'submitted' } },
    handler: async (config) => {
      if (config.url === '/assignments/1') return assignment()
      if (config.url.endsWith('/submissions'))
        return {
          rows: [],
          total: 0,
          page: 1,
          page_size: 50,
          counts: { all: 0, submitted: 0, late: 2, returned: 0, graded: 0 },
          stats: { all: 0, submitted: 0, unsubmitted: 0, graded: 0 },
        }
      throw Error('Unexpected ' + config.url)
    },
  })
  await input(nodes(view.root, 'el-checkbox')[0], true)
  let params = view.requests.filter((request) => request.url.endsWith('/submissions')).at(-1).params
  assert.equal(params.status, 'submitted')
  assert.equal(params.late, 1)

  await input(nodes(view.root, 'el-radio-group')[0], 'graded')
  params = view.requests.filter((request) => request.url.endsWith('/submissions')).at(-1).params
  assert.equal(params.status, 'graded')
  assert.equal(params.late, 1)

  await input(nodes(view.root, 'el-radio-group')[0], 'unsubmitted')
  assert.equal(nodes(view.root, 'el-checkbox').length, 0)
  params = view.requests.filter((request) => request.url.endsWith('/submissions')).at(-1).params
  assert.equal(params.status, 'unsubmitted')
  assert.equal(params.late, undefined)
})

function summaryData() {
  return {
    config: { daily_ratio: 40, final_ratio: 60, grade_absent_mode: 'zero' },
    assignments: [
      {
        id: 1,
        title: '平时',
        total_score: 100,
        grade_weight: 40,
        status: 'published',
        is_final: 0,
      },
      { id: 2, title: '期末', total_score: 100, grade_weight: 0, status: 'published', is_final: 1 },
    ],
    students: [
      {
        id: 2,
        name: '学生甲',
        username: 's1',
        status: 'active',
        cells: {
          1: row({ status: 'graded', score: 80 }),
          2: row({ id: 11, api_base: '/submissions/11', status: 'graded', score: 90 }),
        },
      },
    ],
  }
}

test('成绩占比：20项作业的1%平时占比可按0.1%分配并精确合计', () => {
  const assignments = ref([
    ...Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      status: 'published',
      grade_weight: 0,
      is_final: 0,
    })),
    { id: 99, status: 'published', grade_weight: 0, is_final: 1 },
  ])
  const settings = useGradeSettings(assignments)
  settings.syncSaved({ daily_ratio: 1, final_ratio: 99, grade_absent_mode: 'zero' })
  settings.distributeEvenly()
  const values = settings.weightRows.value.map(
    (assignment) => settings.draft.weights[assignment.id],
  )
  assert.equal(settings.weightSum.value, 1)
  assert.equal(settings.weightsMatch.value, true)
  assert.equal(values.filter((value) => value === 0.1).length, 10)
  assert.equal(values.filter((value) => value === 0).length, 10)
})

async function summary({ readonly = false, reject = false } = {}) {
  const data = summaryData()
  return mountView('components/CourseSummary.vue', {
    props: { courseId: 1, courseName: '设计课', readonly },
    handler: async (config, body) => {
      if (config.url.endsWith('/summary')) return structuredClone(data)
      if (/\/courses\/1\/students\/2\/submissions$/.test(config.url))
        return Object.values(data.students[0].cells).map((cell) => structuredClone(cell))
      if (config.url.endsWith('/grade-config')) {
        if (reject) throw failure('配置保存失败')
        data.config = body
        for (const weight of body.weights)
          data.assignments.find((a) => a.id === weight.assignment_id).grade_weight =
            weight.grade_weight
        return {}
      }
      if (config.url.endsWith('/summary/export')) return new Blob(['xlsx'])
      if (config.url.endsWith('/batch-grade')) {
        if (reject) throw failure('评分保存失败')
        return { results: [{ success: true }] }
      }
      throw Error('Unexpected ' + config.url)
    },
  })
}

async function openSummaryWorkspace(view) {
  const action = nodes(view.root, 'el-button').find((node) => textOf(node).trim() === '查看评分')
  assert.ok(action, '成绩单元应提供查看评分入口')
  await click(action)
  await waitFor(() => nodes(view.root, 'el-dialog').length === 1, '批改工作区打开')
}

test('汇总页：异常响应显示重试，不能伪装成空名单；重试后恢复成绩', async () => {
  let broken = true
  const view = await mountView('components/CourseSummary.vue', {
    props: { courseId: 1 },
    handler: async (config) => {
      if (config.url.endsWith('/summary')) return broken ? { students: [] } : summaryData()
      throw Error('Unexpected ' + config.url)
    },
  })
  assert.match(nodes(view.root, 'el-alert')[0].props.title, /成绩汇总返回格式异常/)
  assert.equal(nodes(view.root, 'b').filter((node) => node.props.class === 'total').length, 0)
  assert.equal(
    nodes(view.root, 'el-button').some((node) => textOf(node) === '导出成绩表'),
    false,
  )
  broken = false
  await click(button(view, '重新加载'))
  await settle()
  assert.equal(textOf(nodes(view.root, 'b').find((node) => node.props.class === 'total')), '86.0')
})

test('成绩汇总：刷新数据不会覆盖未保存的占比草稿', async () => {
  const view = await summary()
  await click(button(view, '占比设置'))
  await input(nodes(view.root, 'el-input-number')[0], 35)
  await click(button(view, '完成'))
  await openSummaryWorkspace(view)
  await click(button(view, '修改评分'))
  await input(
    nodes(view.root, 'el-input-number').find((node) => node.props.modelValue === 80),
    100,
  )
  await click(button(view, '保存评分'))
  await settle()
  await click(button(view, '占比设置'))
  assert.equal(nodes(view.root, 'el-input-number')[0].props.modelValue, 35)
  assert.match(textOf(view.root), /35%/)
})

test('汇总页：从成绩单元打开批改工作区，保存后即时更新总分', async () => {
  const view = await summary()
  assert.equal(textOf(nodes(view.root, 'b').find((n) => n.props.class === 'total')), '86.0')
  await openSummaryWorkspace(view)
  assert.deepEqual(
    view.requests.find((request) => /\/students\/2\/submissions$/.test(request.url)).params,
    { assignment_id: 1 },
    '仅请求当前作业的提交详情',
  )
  await click(button(view, '修改评分'))
  await input(
    nodes(view.root, 'el-input-number').find((node) => node.props.modelValue === 80),
    100,
  )
  await click(button(view, '保存评分'))
  await settle()
  assert.deepEqual(view.requests.find((r) => r.method === 'post').body, {
    score: 100,
    comment: '',
    items: [
      {
        id: 10,
        kind: 'individual',
        expected_status: 'graded',
        expected_submit_count: 1,
      },
    ],
  })
  assert.equal(textOf(nodes(view.root, 'b').find((n) => n.props.class === 'total')), '94.0')
})

test('汇总页：权重不匹配禁止保存，平均分配后导出先保存再下载', async () => {
  const view = await summary()
  await input(nodes(view.root, 'el-input-number')[0], 50)
  assert.equal(button(view, '保存设置').props.disabled, true)
  await click(button(view, '占比设置'))
  await click(button(view, '平均分配'))
  await click(button(view, '完成'))
  assert.equal(button(view, '保存设置').props.disabled, false)
  await click(button(view, '导出成绩表'))
  assert.deepEqual(
    view.requests.slice(1).map((r) => [r.method, r.url]),
    [
      ['put', '/courses/1/grade-config'],
      ['get', '/courses/1/summary/export'],
    ],
  )
  assert.equal(view.requests[1].body.weights[0].grade_weight, 50)
  assert.equal(view.downloads[0][1], '设计课-成绩汇总.xlsx')
  assert.equal(button(view, '保存设置').props.disabled, true)
})

test('汇总页：配置保存失败阻止导出，保留修改并恢复按钮', async () => {
  const view = await summary({ reject: true })
  await input(nodes(view.root, 'el-select')[1], 'skip_ungraded')
  await click(button(view, '导出成绩表'))
  assert.equal(view.downloads.length, 0)
  assert.ok(!view.requests.some((r) => r.url.endsWith('/export')))
  assert.equal(button(view, '保存设置').props.disabled, false)
  assert.equal(button(view, '保存设置').props.loading, false)
  assert.match(view.messages.at(-1).text, /配置保存失败/)
})

test('汇总页：只读禁止改分和设置，搜索正常', async () => {
  const view = await summary({ readonly: true })
  assert.equal(button(view, '占比设置').props.disabled, true)
  await openSummaryWorkspace(view)
  assert.equal(
    nodes(view.root, 'el-button').some((node) => textOf(node).trim() === '修改评分'),
    false,
  )
  assert.match(textOf(view.root), /只读/)
  await input(nodes(view.root, 'el-input')[0], '不存在')
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(nodes(view.root, 'el-table')[0].props.data.length, 0)
})

test('看图评分：保存并跳过已评记录到下一份未评分', async () => {
  const saved = [],
    first = row({
      previews: [
        { id: 1, name: '一', thumbnail: 'one', preview: 'one-full' },
        { id: 2, name: '二', thumbnail: 'two', preview: 'two-full' },
      ],
    }),
    next = row({ id: 12, api_base: '/submissions/12' })
  const view = await mountView('components/GradeWorkspace.vue', {
    props: {
      modelValue: true,
      row: first,
      assignment: assignment(),
      rows: [first, row({ id: 11, api_base: '/submissions/11', status: 'graded' }), next],
      onSaved: (...args) => saved.push(args),
    },
    handler: async () => ({ results: [{ success: true, message: 'ok' }] }),
  })
  await input(nodes(view.root, 'el-input-number')[0], 100)
  await click(button(view, '保存并下一份待批改'))
  assert.equal(view.requests[0].body.score, 100)
  assert.deepEqual(view.requests[0].body.items, [
    { id: 10, kind: 'individual', expected_status: 'submitted', expected_submit_count: 1 },
  ])
  assert.equal(saved.length, 1)
  assert.equal(saved[0][0].id, 10)
  assert.equal(saved[0][1], true)
  assert.equal(saved[0][2].id, 12)
  assert.deepEqual(sessionStorage.values(), [])
})

test('看图评分：最后一份只通知保存一次并关闭', async () => {
  const saved = [],
    closed = [],
    first = row()
  const view = await mountView('components/GradeWorkspace.vue', {
    props: {
      modelValue: true,
      row: first,
      assignment: assignment(),
      rows: [first],
      onSaved: (...args) => saved.push(args),
      'onUpdate:modelValue': (value) => closed.push(value),
    },
    handler: async () => ({ results: [{ success: true, message: 'ok' }] }),
  })
  await input(nodes(view.root, 'el-input-number')[0], 0)
  await click(button(view, '保存并下一份待批改'))
  assert.equal(saved.length, 1)
  assert.equal(saved[0][0].api_base, first.api_base)
  assert.deepEqual(closed, [], '是否关闭由父级工作区处理')
})

test('看图评分：保存请求未结束时连续点击只提交一次', async () => {
  let finish
  const saved = [],
    first = row()
  const view = await mountView('components/GradeWorkspace.vue', {
    props: {
      modelValue: true,
      row: first,
      assignment: assignment(),
      rows: [first],
      onSaved: (...args) => saved.push(args),
    },
    handler: async () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  })
  await input(nodes(view.root, 'el-input-number')[0], 80)
  const save = button(view, '保存评分').props.onClick
  const pending = save()
  const repeated = save()
  await settle()
  assert.equal(view.requests.length, 1)
  finish({ results: [{ success: true, message: 'ok' }] })
  await Promise.all([pending, repeated])
  assert.equal(saved.length, 1)
})

for (const rejected of [false, true])
  test(`看图评分：退回${rejected ? '失败保留输入' : '成功通知并关闭'}，无需填写分数`, async () => {
    const saved = [],
      closed = [],
      first = row()
    const view = await mountView('components/GradeWorkspace.vue', {
      props: {
        modelValue: true,
        row: first,
        assignment: assignment(),
        rows: [first],
        onSaved: (...args) => saved.push(args),
        'onUpdate:modelValue': (value) => closed.push(value),
      },
      handler: async () => {
        if (rejected) throw failure('退回失败')
        return { results: [{ success: true, message: 'ok' }] }
      },
    })
    await click(button(view, '退回重做'))
    await input(nodes(view.root, 'el-input').at(-1), '补充图纸')
    await click(button(view, '确认退回'))
    assert.equal(view.requests[0].url, '/assignments/1/batch-return')
    assert.deepEqual(view.requests[0].body, {
      returned_reason: '补充图纸',
      items: [
        { id: 10, kind: 'individual', expected_status: 'submitted', expected_submit_count: 1 },
      ],
    })
    assert.equal(saved.length, rejected ? 0 : 1)
    assert.deepEqual(closed, rejected ? [] : [false])
    if (rejected) {
      assert.equal(nodes(view.root, 'el-input').at(-1).props.modelValue, '补充图纸')
      assert.ok(sessionStorage.values().some((value) => value.includes('补充图纸')))
      assert.equal(button(view, '确认退回').props.loading, false)
    } else assert.deepEqual(sessionStorage.values(), [])
  })

for (const count of [0, 200, 201])
  test(`预览图：${count}张按200张上限签发，重复ID只请求一次`, async () => {
    const previews = Array.from({ length: count }, (_, index) => ({ id: index + 1 }))
    const view = await mountView('views/teacher/SubmissionsView.vue', {
      handler: async (config, body) => {
        if (config.url === '/assignments/1') return assignment()
        if (config.url.endsWith('/submissions'))
          return {
            rows: [row({ previews }), row({ id: 11, previews: previews.slice(0, 1) })],
            total: 2,
            page: 1,
            page_size: 50,
            counts: {},
            stats: {},
          }
        if (config.url === '/previews/view-ticket')
          return {
            tickets: Object.fromEntries(
              body.ids
                .slice(0, 200)
                .map((id) => [id, { thumbnail: `thumb-${id}`, file: `file-${id}` }]),
            ),
          }
        throw Error('Unexpected ' + config.url)
      },
    })
    const requests = view.requests.filter((request) => request.url === '/previews/view-ticket')
    assert.equal(requests.length, Math.ceil(count / 200))
    assert.ok(requests.every((request) => request.body.ids.length <= 200))
    assert.deepEqual(
      requests.flatMap((request) => request.body.ids),
      previews.map((preview) => preview.id),
    )
    for (const record of nodes(view.root, 'el-table')[0].props.data)
      for (const preview of record.previews) {
        assert.equal(preview.thumbnail, `thumb-${preview.id}`)
        assert.equal(preview.preview, `file-${preview.id}`)
      }
    assert.deepEqual(view.errors, [])
  })

test('预览图：分批并行到达即可显示，旧票据响应不会覆盖刷新列表', async () => {
  let releaseOld,
    ticketCalls = 0,
    lists = 0
  const view = await mountView('views/teacher/SubmissionsView.vue', {
    route: { params: { id: '1' }, query: { filter: 'unsubmitted' } },
    handler: async (config, body) => {
      if (config.url === '/assignments/1') return assignment()
      if (config.url.endsWith('/submissions')) {
        lists++
        return {
          rows: [
            row({
              previews: Array.from({ length: lists === 1 ? 201 : 1 }, (_, index) => ({
                id: index + 1,
              })),
            }),
          ],
          total: 1,
          page: 1,
          page_size: 50,
          counts: {},
          stats: {},
        }
      }
      if (config.url === '/previews/view-ticket') {
        ticketCalls++
        if (ticketCalls === 1)
          return new Promise((resolve) => {
            releaseOld = resolve
          })
        if (body.ids.includes(201))
          return { tickets: { 201: { thumbnail: 'fast-thumb', file: 'fast-file' } } }
        return { tickets: { 1: { thumbnail: 'new-thumb', file: 'new-file' } } }
      }
      throw Error('Unexpected ' + config.url)
    },
  })
  assert.equal(typeof releaseOld, 'function')
  const initial = nodes(view.root, 'el-table')[0].props.data[0].previews
  assert.equal(ticketCalls, 2, '两批同时发出，不等待第一批')
  assert.equal(initial[0].ticketPending, true)
  assert.equal(initial[200].ticketPending, false)
  assert.equal(initial[200].thumbnail, 'fast-thumb', '已完成批次立即可以显示')
  await input(nodes(view.root, 'el-radio-group')[0], 'submitted')
  await settle()
  releaseOld({ tickets: { 1: { thumbnail: 'old-thumb', file: 'old-file' } } })
  await settle()
  assert.equal(ticketCalls, 3)
  assert.equal(nodes(view.root, 'el-table')[0].props.data[0].previews[0].thumbnail, 'new-thumb')
})

test('汇总工作区：打开后局部更新成绩并跳到下一份，不重新加载汇总', async () => {
  const first = { id: 1, name: '甲', username: 's1', cells: { 1: row() } }
  const second = {
    id: 2,
    name: '乙',
    username: 's2',
    cells: { 1: row({ id: 11, api_base: '/submissions/11', group_name: '第二组' }) },
  }
  const students = ref([
    first,
    { name: '未交', cells: {} },
    second,
    { cells: { 1: row({ not_assigned: true }) } },
  ])
  const ticketBatches = []
  const workspace = useSummaryWorkspace(
    students,
    ref([{ id: 1 }]),
    async (ids) => ticketBatches.push(ids),
    async () => {},
  )
  await workspace.openWorkspace(students.value[0], { id: 1 })
  assert.deepEqual(
    workspace.workspaceRows.value.map((record) => [record.api_base, record.name]),
    [
      ['/submissions/10', '甲'],
      ['/submissions/11', '第二组'],
    ],
  )
  assert.deepEqual(ticketBatches, [])
  const saved = { ...first.cells[1], status: 'graded', score: 80, comment: '完成' }
  await workspace.onWorkspaceSaved(saved, true, second.cells[1])
  assert.deepEqual(ticketBatches, [], '保存不会为其他提交签发图片票据')
  assert.equal(workspace.workspaceRow.value.api_base, '/submissions/11')
  assert.equal(workspace.workspaceRows.value[0].score, 80)
})

test('批改页：当前页末份保存后，跨页下一份的图片只签发一次', async () => {
  let saved = false
  const next = row({ id: 11, api_base: '/submissions/11', name: '学生乙', previews: [{ id: 7 }] })
  const view = await mountView('views/teacher/SubmissionsView.vue', {
    route: { params: { id: '1' }, query: { filter: 'submitted' } },
    handler: (config) => {
      if (config.url === '/assignments/1') return assignment()
      if (config.url.endsWith('/batch-grade')) {
        saved = true
        return { results: [{ success: true }] }
      }
      if (config.url.endsWith('/submissions')) {
        const rows = config.params?.page_size === 200 ? [next] : saved ? [] : [row()]
        return {
          rows: structuredClone(rows),
          total: rows.length,
          page: 1,
          page_size: config.params?.page_size || 50,
          counts: {},
          stats: {},
        }
      }
      if (config.url === '/previews/view-ticket')
        return { tickets: { 7: { thumbnail: '/thumb', preview: '/file' } } }
      throw Error('Unexpected ' + config.url)
    },
  })
  await click(button(view, '评分'))
  await input(nodes(view.root, 'el-input-number')[0], 80)
  await click(button(view, '保存并下一份待批改'))
  await waitFor(() => view.requests.some((request) => request.url === '/previews/view-ticket'))
  await settle()
  assert.equal(view.requests.filter((request) => request.url === '/previews/view-ticket').length, 1)
  assert.match(textOf(view.root), /学生乙/)
})

test('汇总工作区：一份小组评分同步全部成员行', async () => {
  const group = row({ api_base: '/group-submissions/10', kind: 'group' })
  const students = ref([
    { id: 1, cells: { 1: { ...group } } },
    { id: 2, cells: { 1: { ...group } } },
    { id: 3, cells: { 1: row({ id: 11, api_base: '/group-submissions/11' }) } },
  ])
  const workspace = useSummaryWorkspace(
    students,
    ref([{ id: 1 }]),
    async () => {},
    () => {},
  )
  await workspace.onWorkspaceSaved(
    { ...group, status: 'graded', score: 90, comment: '完成' },
    false,
  )
  assert.deepEqual(
    students.value.map((student) => student.cells[1].score),
    [90, 90, null],
  )
})

test('汇总页：工作区评分失败保留原成绩，不错误更新总分', async () => {
  const view = await summary({ reject: true })
  await openSummaryWorkspace(view)
  await click(button(view, '修改评分'))
  await input(
    nodes(view.root, 'el-input-number').find((node) => node.props.modelValue === 80),
    100,
  )
  await click(button(view, '保存评分'))
  await settle()
  assert.equal(textOf(nodes(view.root, 'b').find((n) => n.props.class === 'total')), '86.0')
  assert.match(view.messages.at(-1).text, /评分保存失败/)
})

for (const [name, path, props] of [
  ['提交页', 'views/student/StudentSubmit.vue', {}],
  ['批改页', 'views/teacher/SubmissionsView.vue', {}],
  ['汇总页', 'components/CourseSummary.vue', { courseId: 1 }],
])
  test(name + '：加载失败显示错误且不发生渲染异常', async () => {
    const view = await mountView(path, {
      props,
      handler: async () => {
        throw failure('加载失败')
      },
    })
    if (path.startsWith('views/student/')) {
      const alert = nodes(view.root, 'el-alert').find((node) => node.props.title === '加载失败')
      assert.ok(alert)
    } else assert.ok(view.messages.some((m) => m.level === 'error' && m.text === '加载失败'))
    assert.deepEqual(view.errors, [])
  })

test('课程页：提取后的作业表单新建、校验后缀并清空再次打开的草稿', async () => {
  const view = await mountView('views/teacher/CourseManage.vue', {
    dependencies: { '../../composables/useDraggableTabs.js': { useDraggableTabs: () => {} } },
    handler: async (config, body) => {
      if (config.method === 'post' && config.url === '/courses/1/assignments')
        return { id: 2, ...body }
      if (config.url === '/courses/1') return { id: 1, name: '设计课', status: 'active' }
      if (config.url.endsWith('/students') || config.url.endsWith('/assignments')) return []
      throw Error('Unexpected request ' + config.url)
    },
  })
  await click(button(view, '发布新作业'))
  const fields = nodes(view.root, 'el-input')
  await input(fields[0], '新作业')
  await input(
    fields.find((field) => field.props.placeholder === '如：dwg, zip, psd'),
    '.ZIP；dwg',
  )
  await click(button(view, '保存'))
  const created = view.requests.find((r) => r.method === 'post')
  assert.equal(created.body.title, '新作业')
  assert.equal(created.body.allowed_extensions, 'zip,dwg')
  assert.equal(created.body.description_format, 'html')
  await click(button(view, '发布新作业'))
  assert.equal(nodes(view.root, 'el-input')[0].props.modelValue, '')
})

test('作业表单：保存请求处理中连续触发只发送一次', async () => {
  let finishSave
  const view = await mountView('views/teacher/CourseManage.vue', {
    dependencies: { '../../composables/useDraggableTabs.js': { useDraggableTabs: () => {} } },
    handler: async (config) => {
      if (config.method === 'post' && config.url === '/courses/1/assignments')
        return new Promise((resolve) => {
          finishSave = resolve
        })
      if (config.url === '/courses/1') return { id: 1, name: '设计课', status: 'active' }
      if (config.url.endsWith('/students') || config.url.endsWith('/assignments')) return []
      throw Error('Unexpected request ' + config.url)
    },
  })
  await click(button(view, '发布新作业'))
  await input(nodes(view.root, 'el-input')[0], '重复点击保护')
  const save = button(view, '保存').props.onClick
  const first = save()
  await settle()
  const repeated = save()
  await settle()
  assert.equal(
    view.requests.filter(
      (request) => request.method === 'post' && request.url === '/courses/1/assignments',
    ).length,
    1,
  )
  assert.equal(button(view, '保存').props.loading, true)
  finishSave({ id: 2 })
  await Promise.all([first, repeated])
})

test('学生名单：手动添加请求处理中连续触发只发送一次', async () => {
  let finishAdd
  const view = await mountView('components/CourseStudentsPanel.vue', {
    props: {
      visible: true,
      courseId: 1,
      course: { id: 1, status: 'active' },
      students: [],
    },
    handler: async (config) => {
      if (config.url === '/courses/1/students' && config.method === 'post')
        return new Promise((resolve) => {
          finishAdd = resolve
        })
      throw Error('Unexpected request ' + config.url)
    },
  })
  await click(button(view, '手动添加'))
  await input(nodes(view.root, 'el-input')[0], '20269999')
  await input(nodes(view.root, 'el-input')[1], '新增学生')
  const add = button(view, '添加').props.onClick
  const first = add()
  await settle()
  const repeated = add()
  await settle()
  assert.equal(view.requests.filter((request) => request.method === 'post').length, 1)
  finishAdd({ message: '学生已加入课程' })
  await Promise.all([first, repeated])
})

test('课程分组：保存请求处理中连续触发只发送一次', async () => {
  let finishSave
  const view = await mountView('components/CourseGroups.vue', {
    props: { courseId: 1, readonly: false },
    dependencies: { '../composables/useRefresh.js': { useRefresh: (load) => load() } },
    handler: async (config) => {
      if (config.method === 'get')
        return config.url.endsWith('/students')
          ? [{ id: 8, name: '甲', username: '8001', status: 'active' }]
          : []
      if (config.method === 'post' && config.url === '/courses/1/groups')
        return new Promise((resolve) => {
          finishSave = resolve
        })
      throw Error('Unexpected request ' + config.url)
    },
  })
  await click(button(view, '创建小组'))
  await input(nodes(view.root, 'el-input')[0], '一组')
  nodes(view.root, 'el-checkbox')[0].props.onChange(true)
  await settle()
  await input(nodes(view.root, 'el-select')[0], 8)
  const save = button(view, '保存').props.onClick
  const first = save()
  await settle()
  const repeated = save()
  await settle()
  assert.equal(
    view.requests.filter(
      (request) => request.url === '/courses/1/groups' && request.method === 'post',
    ).length,
    1,
  )
  assert.equal(button(view, '保存').props.loading, true)
  finishSave({ id: 1 })
  await Promise.all([first, repeated])
})

test('课程页：学生数排除测试账号并显示最近截止作业和待批改份数', async () => {
  const view = await mountView('views/teacher/CourseManage.vue', {
    dependencies: { '../../composables/useDraggableTabs.js': { useDraggableTabs: () => {} } },
    handler: async (config) => {
      if (config.url === '/courses/1')
        return {
          id: 1,
          name: '设计课',
          status: 'active',
          student_count: 3,
          invite_code: 'ABC123',
        }
      if (config.url.endsWith('/students'))
        return [{ name: '学生甲' }, { name: '学生乙' }, { name: '测试员账号' }]
      if (config.url.endsWith('/assignments'))
        return [
          {
            id: 1,
            title: '较晚截止作业',
            status: 'published',
            deadline: '2099-01-01 00:00:00',
            server_now: '2026-10-15 14:00:00',
            unsubmitted_count: 1,
            unsubmitted_expected_count: 3,
            pending_review_count: 2,
          },
          {
            id: 2,
            title: '最近截止作业',
            status: 'published',
            deadline: '2098-12-31 00:00:00',
            server_now: '2026-10-15 14:00:00',
            unsubmitted_count: 23,
            unsubmitted_expected_count: 25,
            pending_review_count: 3,
          },
        ]
      throw Error('Unexpected request ' + config.url)
    },
  })
  const content = textOf(view.root)
  assert.match(content, /未交 23 人/)
  assert.doesNotMatch(content, /23\/25/)
  assert.match(content, /未交/)
  assert.ok(nodes(view.root, 'div').some((node) => node.props.title === '最近截止作业'))
  assert.match(content, /5\s*未批改/)
  assert.match(content, /课程学生/)
  assert.match(content, /ABC123/)
  assert.deepEqual(view.errors, [])
})

test('课程页：可添加多道必答题目，弹窗确定后锁定，取消修改保留原内容', async () => {
  const view = await mountView('views/teacher/CourseManage.vue', {
    dependencies: { '../../composables/useDraggableTabs.js': { useDraggableTabs: () => {} } },
    handler: async (config, body) => {
      if (config.method === 'post' && config.url === '/courses/1/assignments')
        return { id: 2, ...body }
      if (config.url === '/courses/1') return { id: 1, name: '设计课', status: 'active' }
      if (config.url.endsWith('/students') || config.url.endsWith('/assignments')) return []
      throw Error('Unexpected request ' + config.url)
    },
  })
  await click(button(view, '发布新作业'))
  await input(nodes(view.root, 'el-input')[0], '多题作业')
  for (const [title, guidance] of [
    ['总用时？', '用小时填写。'],
    ['主要困难？', '说明解决方式。'],
  ]) {
    await click(button(view, '＋ 新增必答题目'))
    const maxCharsField = nodes(view.root, 'el-input-number').find(
      (field) => field.props['aria-label'] === '每题最多字符数',
    )
    assert.equal(maxCharsField.props.modelValue, 5000)
    if (title === '总用时？') await input(maxCharsField, 1200)
    await input(
      nodes(view.root, 'el-input').find((field) => field.props['aria-label'] === '必答题目'),
      title,
    )
    await click(button(view, '确定'))
    assert.match(view.messages.at(-1).text, /请填写答题规范/)
    await input(
      nodes(view.root, 'el-input').find((field) => field.props['aria-label'] === '答题规范'),
      guidance,
    )
    await click(button(view, '确定'))
    assert.equal(
      nodes(view.root, 'el-input').filter((field) => field.props['aria-label'] === '必答题目')
        .length,
      0,
    )
  }
  assert.equal(nodes(view.root, 'el-tag').filter((tag) => textOf(tag).includes('已锁定')).length, 2)
  await click(nodes(view.root, 'el-button').find((node) => textOf(node) === '解锁修改'))
  await input(
    nodes(view.root, 'el-input').find((field) => field.props['aria-label'] === '必答题目'),
    '取消的修改',
  )
  await click(button(view, '取消编辑'))
  await click(button(view, '保存'))
  const created = view.requests.find((request) => request.method === 'post')
  const questions = JSON.parse(created.body.required_answer).questions
  assert.deepEqual(
    questions.map((question) => [question.title, question.guidance, question.maxChars]),
    [
      ['总用时？', '用小时填写。', 1200],
      ['主要困难？', '说明解决方式。', 5000],
    ],
  )
  assert.notEqual(questions[0].id, questions[1].id)
})

test('批改页：放弃草稿恢复服务端成绩并删除缓存', async () => {
  const view = await grading()
  await click(button(view, '评分'))
  await input(nodes(view.root, 'el-input-number')[0], 75)
  assert.ok(sessionStorage.values().some((value) => value.includes('75')))
  await click(button(view, '放弃草稿'))
  assert.equal(nodes(view.root, 'el-input-number')[0].props.modelValue, null)
  assert.equal(sessionStorage.values().length, 0)
})

test('自行重交额度为零仍可首次提交，首次之后按额度锁定', async () => {
  const view = await student({ a: { allow_resubmit_count: 0 } })
  const field = nodes(view.root, 'el-input')[0]
  assert.equal(field.props.disabled, false)
  await input(field, '零次重交额度的首次答案')
  await click(button(view, '确认提交'))
  assert.equal(view.calls.length, 1)
  assert.equal(view.calls[0].metadata.content, '零次重交额度的首次答案')
})
