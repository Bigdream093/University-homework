import { test, expect } from '@playwright/test'

for (const role of ['teacher', 'student'])
  test(`${role} 登录帮助首次点击不受残留登录状态影响`, async ({ page }) => {
    await page.addInitScript((role) => {
      Object.defineProperty(navigator, 'userAgent', {
        value: `Kexu${role === 'teacher' ? 'Teacher' : 'Student'}`,
      })
      localStorage.setItem('hw_user', JSON.stringify({ role, name: '旧登录用户' }))
      localStorage.setItem('hw_token', 'expired-token')
    }, role)
    const helpRequests = []
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/help')) helpRequests.push(request.url())
    })
    await page.goto('/login')
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.getByRole('link', { name: '登录帮助', exact: true }).click()
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('登录帮助')
      await expect(page.locator('article')).toHaveAttribute('id', `${role}-login`)
      await expect(page.getByRole('navigation', { name: '说明书章节' })).toHaveCount(0)
      await expect(page.locator('.topbar')).toHaveCount(0)
      await page.getByRole('button', { name: '返回登录', exact: true }).click()
    }
    expect(helpRequests).toHaveLength(2)
    expect(helpRequests.every((url) => new URL(url).pathname === '/api/help/public')).toBe(true)
  })

test('登录前只展示对应身份的登录帮助，教师文案为审阅后的四条', async ({ page }, testInfo) => {
  await page.goto('/help')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('登录帮助')
  await expect(page.getByRole('navigation', { name: '说明书章节' })).toHaveCount(0)
  await expect(page.locator('article li')).toHaveCount(4)
  await expect(page.locator('article')).toContainText('忘记密码')
  await page.locator('.help-role-switch .el-radio-button').filter({ hasText: '教师端' }).click()
  await expect(page.locator('article li')).toHaveCount(4)
  await expect(page.locator('article')).toContainText('使用教师账号和密码登录')
  await expect(page.locator('article')).not.toContainText('忘记教师账号')
  await expect(page.getByRole('button', { name: /下载完整手册|打印|返回上一页/ })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('login-help.png'), fullPage: true })
  await page.getByRole('button', { name: '返回登录', exact: true }).click()
  await expect(page).toHaveURL(/\/login$/)
  const help = page.getByRole('link', { name: '登录帮助' })
  const loginButton = page.getByRole('button', { name: '进入墨痕', exact: true })
  expect((await help.boundingBox()).y).toBeGreaterThan((await loginButton.boundingBox()).y)
})

async function actor(request, role) {
  const teacher = await (
    await request.post('/api/auth/login', { data: { username: 'teacher', password: '123456' } })
  ).json()
  if (role === 'teacher') return teacher
  const headers = { Authorization: 'Bearer ' + teacher.token }
  const course = await (
    await request.post('/api/courses', { headers, data: { name: '说明书验收' } })
  ).json()
  const username = 'manual-' + Date.now()
  expect(
    (
      await request.post(`/api/courses/${course.id}/students`, {
        headers,
        data: { username, name: '说明书验收学生' },
      })
    ).status(),
  ).toBe(201)
  return (await request.post('/api/auth/login', { data: { username, password: '123456' } })).json()
}
for (const role of ['student', 'teacher'])
  test(`${role}：登录后帮助目录、旧链接和窄屏导航`, async ({ page, request }, testInfo) => {
    const user = await actor(request, role)
    await page.addInitScript((value) => {
      localStorage.setItem('hw_token', value.token)
      localStorage.setItem('hw_user', JSON.stringify(value.user))
    }, user)
    await page.goto(role === 'student' ? '/help#student-extension' : '/help#maintenance')
    const navigation = page.getByRole('navigation', { name: '说明书章节' })
    await expect(navigation.getByRole('link')).toHaveCount(role === 'student' ? 4 : 8)
    if (role === 'student') {
      await expect(page.getByRole('heading', { level: 2 })).toHaveText('一、查看与提交作业')
      await expect(navigation.getByRole('link')).toHaveText([
        '查看与提交作业',
        '通知',
        '学习资料',
        '课程提问',
      ])
      await expect(page.locator('article')).toContainText('不占自行重交额度')
    } else {
      await expect(navigation.getByRole('link').last()).toHaveText('更新与部署')
      await expect(page.getByRole('heading', { level: 2 })).toHaveText(
        '八、GitHub 更新、绿联 NAS 部署与备份',
      )
    }
    await expect(page.locator('.help-intro')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '返回登录', exact: true })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('manual-desktop.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await navigation.getByRole('link', { name: '通知', exact: true }).click()
    await expect(page.getByRole('heading', { level: 2 })).toHaveText('二、通知')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByRole('button', { name: '菜单', exact: true }).click()
    await expect(
      page.locator('#main-navigation').getByRole('button', { name: '帮助', exact: true }),
    ).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('manual-mobile.png'), fullPage: true })
  })
