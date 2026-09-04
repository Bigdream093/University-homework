import test, { after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as Vue from 'vue'
import { parse, compileScript } from 'vue/compiler-sfc'
import { createPinia, setActivePinia } from 'pinia'
import api, { messageOf } from '../src/api/request.js'
import { useUserStore } from '../src/stores/user.js'
import { readUser, readToken, saveSession } from '../src/utils/session.js'

// 使用真实 Vue 编译与渲染，仅替换浏览器宿主和 UI 控件；模板中的未定义变量必须暴露。
const renderer = Vue.createRenderer({
  createElement: (tag) => ({ tag, props: {}, children: [] }),
  createText: (text) => ({ text }),
  createComment: (text) => ({ text }),
  setText: (node, text) => { node.text = text },
  setElementText: (node, text) => { node.text = text; node.children = [] },
  patchProp: (node, key, previous, value) => { node.props[key] = value },
  insert(node, parent, anchor = null) {
    if (node.parent) {
      node.parent.children.splice(node.parent.children.indexOf(node), 1)
    }
    node.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(node)
    else parent.children.splice(index, 0, node)
  },
  remove(node) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
  },
  parentNode: (node) => node.parent,
  nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1],
})

const originalAdapter = api.defaults.adapter
const globalNames = ['localStorage', 'navigator', 'window', 'location']
const originalGlobals = new Map(
  globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
)
const mountedApps = []
afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount()
  api.defaults.adapter = originalAdapter
})
after(() => {
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})

function compileView(relativePath, dependencies) {
  const filename = new URL(relativePath, import.meta.url)
  const { descriptor } = parse(readFileSync(filename, 'utf8'))
  const { content } = compileScript(descriptor, {
    id: relativePath,
    inlineTemplate: true,
    genDefaultAs: 'component',
  })
  const executable = content.replace(
    /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/g,
    (statement, bindings, specifier) => {
      assert.ok(specifier in dependencies, `Missing test dependency: ${specifier}`)
      const namedStart = bindings.indexOf('{')
      const declarations = []
      if (namedStart !== 0) {
        const defaultName = bindings.split(',')[0].trim()
        declarations.push(`const ${defaultName} = dependencies[${JSON.stringify(specifier)}].default`)
      }
      if (namedStart >= 0) {
        const named = bindings.slice(namedStart).replace(/\bas\b/g, ':')
        declarations.push(`const ${named} = dependencies[${JSON.stringify(specifier)}]`)
      }
      return declarations.join(';\n') + ';'
    },
  )
  return new Function('dependencies', executable + '\nreturn component')(dependencies)
}

async function mountView(relativePath, { response = [], userAgent = '', query = {}, failure } = {}) {
  const storage = new Map()
  const messages = []
  const requests = []
  const navigations = []
  const errors = []
  const globals = {
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    navigator: { userAgent },
    window: { dispatchEvent() {}, setTimeout },
    location: { pathname: '/login', assign: (target) => navigations.push(target) },
  }
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  api.defaults.adapter = async (config) => {
    requests.push(config)
    if (failure) throw { config, response: { status: 401, data: { message: failure } } }
    return { data: response, status: 200, statusText: 'OK', headers: {}, config }
  }
  const dependencies = {
    vue: Vue,
    'vue-router': {
      useRouter: () => ({ push: (target) => navigations.push(target) }),
      useRoute: () => ({ query }),
    },
    'element-plus': {
      ElMessage: Object.fromEntries(
        ['success', 'warning', 'error'].map((level) => [level, (text) => messages.push({ level, text })]),
      ),
      ElMessageBox: { confirm: async () => {} },
    },
    '../stores/user.js': { useUserStore },
    '../api/request.js': { default: api, messageOf },
    '../../api/request.js': { default: api, messageOf },
    '../../composables/useUpload.js': { newRequestId: () => 'test-request', intentSignature: JSON.stringify },
    '../../composables/useRefresh.js': { useRefresh: (load) => Vue.onMounted(load) },
  }
  const pinia = createPinia()
  setActivePinia(pinia)
  const app = renderer.createApp(compileView(relativePath, dependencies))
  app.use(pinia)
  app.config.errorHandler = (error) => errors.push(error)
  app.config.warnHandler = () => {}
  for (const tag of [
    'el-button', 'el-form', 'el-form-item', 'el-input', 'el-radio-group',
    'el-radio-button', 'el-dialog', 'el-checkbox', 'router-link',
  ]) {
    app.component(tag, {
      inheritAttrs: false,
      setup: (props, { attrs, slots }) => () => Vue.h(tag, attrs, [
        slots.default?.(), slots.footer?.(),
      ]),
    })
  }
  const root = { children: [] }
  mountedApps.push(app)
  app.mount(root)
  await settle()
  return { root, errors, messages, requests, navigations }
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve))
  await Vue.nextTick()
}
function findNodes(root, tag) {
  return [root, ...(root.children || []).flatMap((child) => findNodes(child))]
    .filter((node) => !tag || node.tag === tag)
}
function textOf(root) {
  return (root.text || '') + (root.children || []).map(textOf).join('')
}
async function submitLogin(view) {
  const inputs = findNodes(view.root, 'el-input')
  inputs[0].props['onUpdate:modelValue']('20260001')
  inputs[1].props['onUpdate:modelValue']('123456')
  await Vue.nextTick()
  await findNodes(view.root, 'el-form')[0].props.onSubmit({ preventDefault() {} })
  await settle()
}

const course = {
  id: 7, name: '规划设计', code: 'PLAN', status: 'active', invite_code: 'ABC123',
  student_count: 2, assignment_count: 3,
}

test('教师：非空课程列表显示课程和邀请码，无渲染异常', async () => {
  const view = await mountView('../src/views/teacher/TeacherCourses.vue', { response: [course] })
  assert.deepEqual(view.errors.map((error) => error.message), [])
  assert.match(textOf(view.root), /规划设计/)
  assert.match(textOf(view.root), /邀请码 ABC123/)
  findNodes(view.root, 'article')[0].props.onClick()
  assert.equal(view.navigations[0], '/teacher/courses/7')
})

test('教师：空列表正常显示空态', async () => {
  const view = await mountView('../src/views/teacher/TeacherCourses.vue')
  assert.deepEqual(view.errors, [])
  assert.match(textOf(view.root), /还没有课程/)
})

test('教师：切换归档筛选后展示已归档课程', async () => {
  const view = await mountView('../src/views/teacher/TeacherCourses.vue', {
    response: [{ ...course, status: 'archived', invite_code: null }],
  })
  findNodes(view.root, 'el-radio-group')[0].props['onUpdate:modelValue']('archived')
  await settle()
  assert.deepEqual(view.errors.map((error) => error.message), [])
  assert.equal(findNodes(view.root, 'article').length, 1)
  assert.doesNotMatch(textOf(view.root), /邀请码 null/)
})

for (const mustChangePassword of [0, 1]) {
  test(`学生登录：must_change_password=${mustChangePassword} 时保存会话并正确跳转`, async () => {
    const user = { id: 2, role: 'student', must_change_password: mustChangePassword }
    const view = await mountView('../src/views/LoginView.vue', {
      userAgent: 'KexuStudent/1.3.2', response: { token: 'student-token', user },
    })
    await submitLogin(view)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.messages, [])
    assert.equal(view.requests[0].url, '/auth/login')
    assert.deepEqual(JSON.parse(view.requests[0].data), { username: '20260001', password: '123456' })
    assert.equal(readToken(), 'student-token')
    assert.deepEqual(readUser(), user)
    assert.deepEqual(view.navigations, [mustChangePassword
      ? { path: '/password', query: {} } : '/student/courses'])
    assert.equal(findNodes(view.root, 'el-button')[0].props.loading, false)
  })
}

test('学生登录：错误密码显示服务端错误，不保存会话、不跳转', async () => {
  const view = await mountView('../src/views/LoginView.vue', { failure: '账号或密码错误' })
  await submitLogin(view)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.messages, [{ level: 'error', text: '账号或密码错误' }])
  assert.equal(readToken(), '')
  assert.equal(readUser(), null)
  assert.deepEqual(view.navigations, [])
  assert.equal(findNodes(view.root, 'el-button')[0].props.loading, false)
})

test('学生登录：学生客户端拒绝教师账号并清除会话', async () => {
  const view = await mountView('../src/views/LoginView.vue', {
    userAgent: 'KexuStudent/1.3.2',
    response: { token: 'teacher-token', user: { role: 'teacher' } },
  })
  await submitLogin(view)
  assert.equal(readUser(), null)
  assert.equal(readToken(), '')
  assert.deepEqual(view.messages, [{ level: 'error', text: '该账号不能登录墨痕学生端' }])
  assert.deepEqual(view.navigations, [])
})

test('学生：登录落地页加载并展示课程，无渲染异常', async () => {
  const view = await mountView('../src/views/student/StudentCourses.vue', { response: [course] })
  assert.deepEqual(view.errors, [])
  assert.equal(view.requests[0].url, '/my/courses')
  assert.match(textOf(view.root), /规划设计/)
  findNodes(view.root, 'article')[0].props.onClick()
  assert.equal(view.navigations[0], '/student/courses/7')
})

for (const redirect of ['/student/courses/7', '//outside.example', '/login', 'https://outside.example']) {
  test(`登录跳转：${redirect}`, async () => {
    const view = await mountView('../src/views/LoginView.vue', {
      query: { redirect }, response: { token: 'token', user: { role: 'student' } },
    })
    await submitLogin(view)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.navigations, [
      redirect === '/student/courses/7' ? redirect : '/student/courses',
    ])
  })
}

test('首次登录：改密路径保留原始目标地址', async () => {
  const view = await mountView('../src/views/LoginView.vue', {
    query: { redirect: '/student/courses/7' },
    response: { token: 'token', user: { role: 'student', must_change_password: 1 } },
  })
  await submitLogin(view)
  assert.deepEqual(view.navigations, [
    { path: '/password', query: { redirect: '/student/courses/7' } },
  ])
})

test('教师登录：正确角色跳转教师课程页', async () => {
  const view = await mountView('../src/views/LoginView.vue', {
    userAgent: 'KexuTeacher/1.3.2',
    response: { token: 'token', user: { role: 'teacher' } },
  })
  await submitLogin(view)
  assert.deepEqual(view.messages, [])
  assert.deepEqual(view.navigations, ['/teacher/courses'])
})

for (const viewPath of ['teacher/TeacherCourses', 'student/StudentCourses']) {
  test(`${viewPath}：课程请求失败显示错误且无渲染崩溃`, async () => {
    const view = await mountView(`../src/views/${viewPath}.vue`, { failure: '登录状态已失效' })
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.messages, [{ level: 'error', text: '登录状态已失效' }])
    assert.equal(findNodes(view.root, 'article').length, 0)
  })
}

test('学生课程筛选：进行中、已归档、全部', async () => {
  const view = await mountView('../src/views/student/StudentCourses.vue', {
    response: [course, { ...course, id: 8, status: 'archived' }],
  })
  assert.equal(findNodes(view.root, 'article').length, 1)
  for (const [status, count] of [['archived', 1], ['all', 2]]) {
    findNodes(view.root, 'el-radio-group')[0].props['onUpdate:modelValue'](status)
    await settle()
    assert.equal(findNodes(view.root, 'article').length, count)
  }
  assert.deepEqual(view.errors, [])
})

for (const matchingPasswords of [false, true]) {
  test(`改密：确认密码${matchingPasswords ? '一致' : '不一致'}`, async () => {
    const view = await mountView('../src/views/PasswordView.vue', {
      query: { redirect: '/student/courses/7' }, response: {},
    })
    saveSession('token', { role: 'student', must_change_password: 1 })
    const inputs = findNodes(view.root, 'el-input')
    for (const [index, value] of ['123456', 'new-password', matchingPasswords ? 'new-password' : 'different'].entries()) {
      inputs[index].props['onUpdate:modelValue'](value)
    }
    await Vue.nextTick()
    await findNodes(view.root, 'el-button')[0].props.onClick()
    await settle()
    assert.deepEqual(view.errors, [])
    if (matchingPasswords) {
      assert.equal(view.requests[0].url, '/auth/password')
      assert.equal(view.requests[0].method, 'put')
      assert.equal(readUser(), null)
      assert.equal(readToken(), '')
      assert.deepEqual(view.navigations, [
        { path: '/login', query: { redirect: '/student/courses/7' } },
      ])
    } else {
      assert.equal(view.requests.length, 0)
      assert.deepEqual(view.messages, [{ level: 'warning', text: '两次输入的新密码不一致' }])
      assert.equal(readToken(), 'token')
    }
  })
}

function loadRouteGuard() {
  let guard
  const source = readFileSync(new URL('../src/router/index.js', import.meta.url), 'utf8')
    .replace(/^import .+$/gm, '')
    .replace('export default router', 'return router')
  new Function('createRouter', 'createWebHistory', 'LoginView', 'readUser', source)(
    () => ({ beforeEach: (callback) => { guard = callback } }),
    () => ({}), {}, readUser,
  )
  return guard
}

const guardCases = [
  { name: '匿名可访问登录页', user: null, path: '/login', meta: { public: true }, expected: true },
  { name: '匿名访问受保护页返回登录', user: null, path: '/student/courses', meta: { role: 'student' }, expected: { path: '/login', query: { redirect: '/student/courses' } } },
  { name: '学生禁止进入教师页', user: { role: 'student' }, path: '/teacher/courses', meta: { role: 'teacher' }, expected: '/student/courses' },
  { name: '教师禁止进入学生页', user: { role: 'teacher' }, path: '/student/courses', meta: { role: 'student' }, expected: '/teacher/courses' },
  { name: '首次登录强制改密', user: { role: 'student', must_change_password: 1 }, path: '/student/courses', meta: { role: 'student' }, expected: { path: '/password', query: { redirect: '/student/courses' } } },
  { name: '改密页不循环重定向', user: { role: 'student', must_change_password: 1 }, path: '/password', meta: {}, expected: undefined },
  { name: '已有学生会话可访问课程', user: { role: 'student' }, path: '/student/courses', meta: { role: 'student' }, expected: undefined },
]
for (const scenario of guardCases) {
  test(`路由守卫：${scenario.name}`, async () => {
    await mountView('../src/views/LoginView.vue')
    if (scenario.user) saveSession('token', scenario.user)
    assert.deepEqual(loadRouteGuard()({
      path: scenario.path, fullPath: scenario.path, meta: scenario.meta,
    }), scenario.expected)
  })
}

test('会话：损坏的用户 JSON 清除会话，受保护页退回登录', async () => {
  await mountView('../src/views/LoginView.vue')
  localStorage.setItem('hw_user', '{broken')
  localStorage.setItem('hw_token', 'token')
  assert.equal(readUser(), null)
  assert.equal(readToken(), '')
  assert.deepEqual(loadRouteGuard()({ path: '/student/courses', fullPath: '/student/courses', meta: {} }),
    { path: '/login', query: { redirect: '/student/courses' } })
})

test('请求：携带会话令牌，非登录请求 401 清除会话并保留回跳地址', async () => {
  const view = await mountView('../src/views/LoginView.vue', { failure: '登录状态已失效' })
  saveSession('expired-token', { role: 'student' })
  Object.assign(location, { pathname: '/student/courses', search: '?page=2', hash: '#list' })
  await assert.rejects(api.get('/my/courses'))
  assert.equal(view.requests[0].headers.Authorization, 'Bearer expired-token')
  assert.equal(readToken(), '')
  assert.equal(readUser(), null)
  assert.deepEqual(view.navigations, [
    '/login?redirect=' + encodeURIComponent('/student/courses?page=2#list'),
  ])
})
