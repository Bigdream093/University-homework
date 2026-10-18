import test from 'node:test'
import assert from 'node:assert/strict'
import { effectScope, reactive } from 'vue'
import api from '../src/api/request.js'
import { useSubmissions } from '../src/composables/useSubmissions.js'
import { legacySubmissionPage, validateSubmissionPage } from '../src/utils/submissionList.js'
import { mountView, nodes, textOf, input, settle, waitFor } from './helpers/view-harness.js'

const roster = [
  ...Array.from({ length: 28 }, (_, i) => ({
    student_id: i + 1,
    username: `s${i + 1}`,
    name: `学生${i + 1}`,
    id: i < 2 ? i + 100 : null,
    status: i < 2 ? 'submitted' : null,
    is_late: i === 1 ? 1 : 0,
  })),
  ...Array.from({ length: 3 }, (_, i) => ({
    student_id: i + 30,
    username: `test${i}`,
    name: `测试员${i}`,
    id: i + 200,
    status: 'submitted',
  })),
]
const options = { status: 'unsubmitted', keyword: '', page: 1, pageSize: 25 }
test('旧列表：28名学生和3个测试账号统计、搜索和分页', () => {
  const result = legacySubmissionPage(roster, {}, options)
  assert.deepEqual(result.stats, { all: 28, submitted: 2, unsubmitted: 26, graded: 0 })
  assert.equal(result.counts.all, 31)
  assert.equal(result.counts.submitted, 5)
  assert.equal(result.counts.missingPreview, 5)
  assert.equal(result.rows.length, 25)
  assert.equal(result.total, 26)
  assert.equal(legacySubmissionPage(roster, {}, { ...options, page: 2 }).rows.length, 1)
  assert.equal(
    legacySubmissionPage(roster, {}, { ...options, status: 'submitted', lateOnly: true }).total,
    1,
  )
  const lateGraded = legacySubmissionPage(
    [{ id: 1, status: 'graded', is_late: 1 }],
    {},
    { ...options, status: 'graded', lateOnly: true },
  )
  assert.equal(lateGraded.total, 1, '迟交筛选可与已评分状态组合')
  const tester = legacySubmissionPage(
    roster,
    {},
    { ...options, status: 'submitted', keyword: 'test1' },
  )
  assert.equal(tester.total, 1)
  assert.equal(tester.rows[0].is_test_student, 1)
  assert.deepEqual(tester.stats, result.stats)
})
test('旧列表统计兼容数字字符串标志，并保留缺预览图计数', () => {
  const result = legacySubmissionPage(
    [
      { id: 1, status: 'submitted', is_late: '1', is_test_student: '0', preview_count: 0 },
      { id: 2, status: 'graded', is_late: '0', is_test_student: '1', preview_count: 1 },
    ],
    {},
    { ...options, status: 'submitted', lateOnly: true },
  )
  assert.deepEqual(result.stats, { all: 1, submitted: 1, unsubmitted: 0, graded: 0 })
  assert.equal(result.counts.late, 1)
  assert.equal(result.counts.missingPreview, 1)
  assert.equal(result.total, 1)
})
test('旧列表：小组成员搜索、测试组识别、退回和已评分', () => {
  const data = [
    { id: 1, kind: 'group', status: 'returned', members: [{ name: '测试员甲' }] },
    { id: 2, kind: 'group', status: 'graded', members: [{ name: '学生甲', username: 's1' }] },
  ]
  assert.equal(
    legacySubmissionPage(data, {}, { ...options, status: 'returned' }).rows[0].is_test_student,
    1,
  )
  const result = legacySubmissionPage(data, {}, { ...options, status: 'graded', keyword: 's1' })
  assert.equal(result.total, 1)
  assert.equal(result.stats.all, 1)
})
test('新版分页不再本地筛选，格式异常不能作为空表', () => {
  const data = {
    rows: [],
    total: 90,
    page: 2,
    page_size: 25,
    counts: { all: 90 },
    stats: { all: 87 },
  }
  assert.equal(validateSubmissionPage(data), data)
  for (const invalid of [null, {}, '<html>', { rows: [] }])
    assert.throws(() => validateSubmissionPage(invalid), /格式异常/)
})
test('旧接口先返回筛选结果时，页面重新取全量再计算，并可切换和搜索', async () => {
  const requests = []
  const view = await mountView('views/teacher/SubmissionsView.vue', {
    handler: async (config) => {
      if (config.url === '/assignments/1') return { id: 1, title: '作业', work_mode: 'individual' }
      if (config.url.endsWith('/submissions')) {
        requests.push(config.params)
        return config.params?.status ? [] : structuredClone(roster)
      }
      throw Error(config.url)
    },
  })
  assert.equal(requests.length, 2)
  assert.equal(requests[0].status, 'unsubmitted')
  assert.equal(requests[1], undefined)
  assert.equal(nodes(view.root, 'el-table')[0].props.data.length, 26)
  await input(nodes(view.root, 'el-radio-group')[0], 'submitted')
  assert.equal(nodes(view.root, 'el-table')[0].props.data.length, 5)
  assert.equal(requests.at(-1), undefined)
  assert.match(textOf(view.root), /待批改（5）/)
})
test('异常接口显示错误与重试，隐藏空表和零统计', async () => {
  const view = await mountView('views/teacher/SubmissionsView.vue', {
    handler: async (config) => (config.url === '/assignments/1' ? { id: 1 } : '<html>'),
  })
  assert.equal(nodes(view.root, 'el-table').length, 0)
  assert.match(
    nodes(view.root, 'el-alert').find((n) => n.props.type === 'error').props.title,
    /格式异常/,
  )
  assert.match(textOf(view.root), /重新加载/)
})

for (const relative of ['views/teacher/SubmissionsView.vue', 'views/teacher/ReviewInbox.vue'])
  test(`${relative}：分页后搜索只请求一次，并等待最后一次输入`, async () => {
    const view = await mountView(relative, {
      handler: async (config) =>
        config.url === '/assignments/1'
          ? { id: 1 }
          : {
              rows: [],
              total: 100,
              page: config.params?.page || 1,
              page_size: 50,
              counts: {},
              stats: {},
            },
    })
    const listCalls = () => view.requests.filter((request) => request.url !== '/assignments/1')
    nodes(view.root, 'el-pagination')[0].props['onUpdate:currentPage'](2)
    await settle()
    const before = listCalls().length
    const field = nodes(view.root, 'el-input')[0]
    await input(field, 'ali')
    await input(field, 'alice')
    assert.equal(listCalls().length, before, '重置分页不能绕过搜索防抖')
    await waitFor(() => listCalls().length === before + 1)
    assert.equal(listCalls().at(-1).params.keyword, 'alice')
    assert.equal(listCalls().at(-1).params.page, 1)
    if (relative.includes('SubmissionsView')) {
      nodes(view.root, 'el-pagination')[0].props['onUpdate:currentPage'](2)
      await settle()
      const previous = listCalls().length
      await input(nodes(view.root, 'el-radio-group')[0], 'submitted')
      assert.equal(listCalls().length, previous + 1, '筛选与分页重置合并为一次请求')
      assert.equal(listCalls().at(-1).params.status, 'submitted')
    }
  })

test('提交列表：旧接口纠正页码不重复加载；销毁作用域撤销搜索', async (t) => {
  const originals = new Map(
    ['window', 'localStorage'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  )
  const adapter = api.defaults.adapter
  globalThis.window = { setTimeout }
  globalThis.localStorage = { getItem: () => null }
  let requests = 0
  api.defaults.adapter = async (config) => {
    requests++
    return { data: structuredClone(roster), status: 200, headers: {}, config }
  }
  const scope = effectScope()
  const state = scope.run(() => useSubmissions(reactive({ params: { id: 1 }, query: {} })))
  t.after(() => {
    scope.stop()
    api.defaults.adapter = adapter
    for (const [key, value] of originals)
      if (value) Object.defineProperty(globalThis, key, value)
      else delete globalThis[key]
  })
  state.page.value = 10
  await settle()
  assert.equal(state.page.value, 1)
  assert.equal(requests, 2, '旧服务器仅需筛选响应与全量响应，不再为页码纠正重复请求')
  state.keyword.value = 'alice'
  scope.stop()
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(requests, 2, '销毁后不发送防抖查询')
})

test('待批改收件箱：卸载后不发送待执行的搜索或显示失败提示', async (t) => {
  const view = await mountView('views/teacher/ReviewInbox.vue', {
    handler: () => ({ rows: [], total: 1 }),
  })
  await input(nodes(view.root, 'el-input')[0], 'alice')
  view.dispose()
  const adapter = api.defaults.adapter
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  let requests = 0
  globalThis.localStorage = { getItem: () => null }
  api.defaults.adapter = async (config) => {
    requests++
    return { data: { rows: [], total: 1 }, status: 200, headers: {}, config }
  }
  t.after(() => {
    api.defaults.adapter = adapter
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage)
    else delete globalThis.localStorage
  })
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(requests, 0)
  assert.deepEqual(view.messages, [])
})
