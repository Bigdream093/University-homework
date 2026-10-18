import { test, expect } from '@playwright/test'

test('拆分课程页：新建与编辑作业、学生弹窗、成绩设置及 CSP', async ({
  page,
  request,
}, testInfo) => {
  const login = await request.post('/api/auth/login', {
    data: { username: 'teacher', password: '123456' },
  })
  const actor = await login.json()
  const headers = { Authorization: 'Bearer ' + actor.token }
  const response = await request.post('/api/courses', {
    headers,
    data: { name: '前端拆分验收-' + Date.now() },
  })
  expect(response.status()).toBe(201)
  const course = await response.json()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    window.cspViolations = []
    document.addEventListener('securitypolicyviolation', (event) =>
      window.cspViolations.push(event.effectiveDirective),
    )
  })
  const html = await page.goto('/login')
  expect(
    html.headers()['content-security-policy'] ||
      html.headers()['content-security-policy-report-only'],
  ).toContain("script-src 'self' 'wasm-unsafe-eval'")
  await page.evaluate((actor) => {
    localStorage.setItem('hw_token', actor.token)
    localStorage.setItem('hw_user', JSON.stringify({ ...actor.user, must_change_password: 0 }))
  }, actor)
  await page.goto(`/teacher/courses/${course.id}`)
  await expect(page.getByText('A列学号，B列姓名，首行为表头')).not.toBeVisible()
  await page.getByRole('button', { name: '发布新作业', exact: true }).click()
  const form = page.getByRole('dialog', { name: '创建作业', exact: true })
  await form.getByLabel('作业标题', { exact: true }).fill('独立表单测试')
  await form.getByLabel('允许的文件后缀名（留空表示不限制）').fill('.ZIP；dwg')
  await form.getByRole('button', { name: '保存', exact: true }).click()
  await expect(form).not.toBeVisible()
  await expect(page.getByRole('heading', { name: '独立表单测试', exact: true })).toBeVisible()
  await page.locator('.card-head').click()
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  const edit = page.getByRole('dialog', { name: '编辑作业', exact: true })
  await expect(edit.getByLabel('作业标题', { exact: true })).toHaveValue('独立表单测试')
  await expect(edit.getByLabel('允许的文件后缀名（留空表示不限制）')).toHaveValue('zip,dwg')
  await edit.getByLabel('作业标题', { exact: true }).fill('已编辑作业')
  await edit.getByRole('button', { name: '保存', exact: true }).click()
  await expect(edit).not.toBeVisible()
  await expect(page.getByRole('heading', { name: '已编辑作业', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '添加学生', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '添加学生', exact: true })).toBeVisible()
  await page
    .getByRole('dialog', { name: '添加学生', exact: true })
    .getByRole('button', { name: '取消', exact: true })
    .click()
  await page.getByRole('tab', { name: '成绩汇总', exact: true }).click()
  await page.getByRole('button', { name: '占比设置', exact: true }).click()
  await expect(
    page.getByRole('dialog', { name: '成绩占比设置（平时作业）', exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: '完成', exact: true }).click()
  expect(errors).toEqual([])
  expect(await page.evaluate(() => window.cspViolations)).toEqual([])
  await page.screenshot({
    path: testInfo.outputPath('refactored-course.png'),
    fullPage: true,
  })
})

test('CSP enforce: blocks inline script injection and permits WASM hashing', async ({ page }) => {
  const response = await page.goto('/login')
  expect(response.headers()['content-security-policy']).toContain(
    "script-src 'self' 'wasm-unsafe-eval'",
  )
  expect(response.headers()['content-security-policy-report-only']).toBeUndefined()
  await page.evaluate(() => {
    window.cspBlocked = []
    document.addEventListener('securitypolicyviolation', (event) =>
      window.cspBlocked.push(event.effectiveDirective),
    )
    const script = document.createElement('script')
    script.textContent = 'window.injectedScriptExecuted = true'
    document.head.appendChild(script)
  })
  await expect.poll(() => page.evaluate(() => window.cspBlocked)).toContain('script-src-elem')
  expect(await page.evaluate(() => window.injectedScriptExecuted)).toBeUndefined()
  expect(
    await page.evaluate(async () => {
      const module = await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))
      return module instanceof WebAssembly.Module
    }),
  ).toBe(true)
})

for (const client of [
  { name: '教师端', role: 'Teacher', username: 'teacher' },
  { name: '学生端', role: 'Student', username: '20260001' },
]) {
  test(`${client.name}登录：密码记忆与清除操作对齐且适配窄屏`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({
      baseURL,
      userAgent: `Kexu${client.role}/1.7.5`,
    })
    const page = await context.newPage()
    await page.addInitScript((username) => {
      window.kexuDesktop = {
        getSavedCredentials: async () => ({
          available: true,
          credentials: { username, password: 'demo-only' },
        }),
        saveCredentials: async () => {},
        clearCredentials: async () => {},
      }
    }, client.username)
    await page.goto('/login')

    const controls = page.locator('.credential-controls')
    await expect(controls.getByRole('checkbox', { name: '记住账号和密码' })).toBeChecked()
    const clearButton = controls.getByRole('button', {
      name: '清除已保存密码',
    })
    await expect(clearButton).toBeVisible()
    const aligned = await controls.evaluate((element) => {
      const checkbox = element.querySelector('.el-checkbox').getBoundingClientRect()
      const button = element.querySelector('.credential-clear-button').getBoundingClientRect()
      return {
        centerDifference: Math.abs(checkbox.y + checkbox.height / 2 - button.y - button.height / 2),
        buttonInside: button.right <= element.getBoundingClientRect().right + 1,
      }
    })
    expect(aligned.centerDifference).toBeLessThan(1)
    expect(aligned.buttonInside).toBe(true)
    expect(await controls.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe(
      '0px',
    )
    expect(await controls.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
      'rgba(0, 0, 0, 0)',
    )

    await page.setViewportSize({ width: 375, height: 812 })
    await expect(controls).toBeVisible()
    const mobile = await controls.evaluate((element) => ({
      overflows: element.scrollWidth > element.clientWidth,
      buttonInside:
        element.querySelector('.credential-clear-button').getBoundingClientRect().right <=
        element.getBoundingClientRect().right + 1,
    }))
    expect(mobile).toEqual({ overflows: false, buttonInside: true })
    await context.close()
  })
}
