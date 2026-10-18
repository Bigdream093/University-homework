import { test, expect } from '@playwright/test'

test('资料使用紧凑表格，保留排序、管理和学生刷新下载操作', async ({ page, request }, testInfo) => {
  const teacher = await (
    await request.post('/api/auth/login', {
      data: { username: 'teacher', password: '123456' },
    })
  ).json()
  const headers = { Authorization: `Bearer ${teacher.token}` }
  const course = await (
    await request.post('/api/courses', {
      headers,
      data: { name: '资料布局验收' },
    })
  ).json()
  for (const title of ['资料乙', '资料甲']) {
    const response = await request.post(`/api/courses/${course.id}/materials`, {
      headers,
      multipart: {
        title,
        file: { name: `${title}.txt`, mimeType: 'text/plain', buffer: Buffer.from(title) },
      },
    })
    expect(response.status()).toBe(201)
  }
  await page.goto('/login')
  await page.evaluate((actor) => {
    localStorage.setItem('hw_token', actor.token)
    localStorage.setItem('hw_user', JSON.stringify({ ...actor.user, must_change_password: 0 }))
  }, teacher)
  await page.goto(`/teacher/courses/${course.id}`)
  await page.getByRole('tab', { name: '学习资料', exact: true }).click()
  const panel = page.getByRole('tabpanel', { name: '学习资料', exact: true })
  const rows = page.locator('.el-table__body-wrapper tbody tr')
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText('资料甲')
  await expect(rows.first().getByRole('button', { name: '上移', exact: true })).toBeDisabled()
  for (const name of ['查看下载记录', '下载', '编辑', '删除', '下移'])
    await expect(rows.first().getByRole('button', { name, exact: true })).toBeVisible()
  await rows.first().getByRole('button', { name: '下移', exact: true }).click()
  await expect(rows.first()).toContainText('资料乙')
  await rows.last().getByRole('button', { name: '上移', exact: true }).click()
  await expect(rows.first()).toContainText('资料甲')
  await page.screenshot({
    path: testInfo.outputPath('teacher-materials-compact.png'),
    fullPage: true,
  })

  const username = `material-${Date.now()}`
  expect(
    (
      await request.post(`/api/courses/${course.id}/students`, {
        headers,
        data: { username, name: '资料验收学生' },
      })
    ).status(),
  ).toBe(201)
  const student = await (
    await request.post('/api/auth/login', { data: { username, password: '123456' } })
  ).json()
  await page.evaluate((actor) => {
    localStorage.setItem('hw_token', actor.token)
    localStorage.setItem('hw_user', JSON.stringify({ ...actor.user, must_change_password: 0 }))
  }, student)
  await page.goto(`/student/courses/${course.id}`)
  await page.getByRole('tab', { name: '学习资料', exact: true }).click()
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText('资料甲')
  await expect(rows.first().getByRole('button', { name: '下载', exact: true })).toBeVisible()
  const refreshed = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/courses/${course.id}/materials`) &&
      response.request().method() === 'GET',
  )
  await panel.getByRole('button', { name: '刷新资料', exact: true }).click()
  expect((await refreshed).ok()).toBe(true)
  await page.screenshot({
    path: testInfo.outputPath('student-materials-compact.png'),
    fullPage: true,
  })
})
