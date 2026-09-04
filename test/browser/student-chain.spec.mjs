import { test, expect } from '@playwright/test'
import ExcelJS from 'exceljs'
import fs from 'node:fs/promises'

const password = 'Browser-student-160'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')

async function api(request, actor, method, route, data, status = 200) {
  const response = await request.fetch('/api' + route, {
    method, headers: actor ? { Authorization: 'Bearer ' + actor.token } : {}, data,
  })
  expect(response.status(), method + ' ' + route + ': ' + await response.text()).toBe(status)
  return response.json()
}
async function fixture(request, { group = false, online = false } = {}) {
  const teacher = await api(request, null, 'POST', '/auth/login', { username: 'teacher', password: '123456' })
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const course = await api(request, teacher, 'POST', '/courses', { name: '浏览器验收-' + suffix }, 201)
  const users = []
  for (const role of ['leader', 'member', 'other']) {
    const username = role + '-' + suffix
    await api(request, teacher, 'POST', `/courses/${course.id}/students`, { username, name: role }, 201)
    const actor = await api(request, null, 'POST', '/auth/login', { username, password: '123456' })
    await api(request, actor, 'PUT', '/auth/password', { oldPassword: '123456', newPassword: password })
    users.push(await api(request, null, 'POST', '/auth/login', { username, password }))
  }
  const [student, member, other] = users
  const assignment = await api(request, teacher, 'POST', `/courses/${course.id}/assignments`, {
    title: '浏览器作业', type: online ? 'online' : 'document', status: group ? 'draft' : 'published',
    work_mode: group ? 'group' : 'individual', total_score: 100, allow_resubmit_count: 0,
    max_file_mb: 20, allowed_extensions: 'zip', require_preview_image: !online, preview_max_count: 2,
  }, 201)
  if (group) {
    const team = await api(request, teacher, 'POST', `/courses/${course.id}/groups`, {
      name: '浏览器小组', member_ids: [student.user.id, member.user.id], leader_id: student.user.id,
    }, 201)
    await api(request, teacher, 'POST', `/assignments/${assignment.id}/groups/snapshot`, { group_ids: [team.id] })
    await api(request, teacher, 'POST', `/assignments/${assignment.id}/publish`)
  }
  await api(request, teacher, 'PUT', `/courses/${course.id}/grade-config`, {
    daily_ratio: 100, final_ratio: 0, grade_absent_mode: 'zero', final_assignment_id: null,
    weights: [{ assignment_id: assignment.id, grade_weight: 100 }],
  })
  return { teacher, student, member, other, course, assignment }
}
async function login(page, actor, target) {
  await page.goto('/login?redirect=' + encodeURIComponent(target))
  await page.getByPlaceholder('教师工号 / 学生学号').fill(actor.user.username)
  await page.getByPlaceholder('请输入密码').fill(actor.user.role === 'teacher' ? '123456' : password)
  await page.getByRole('button', { name: '进入墨痕', exact: true }).click()
  if (actor.user.must_change_password) {
    await expect(page).toHaveURL(url => url.pathname === '/password')
    await page.getByLabel('原密码', { exact: true }).fill('123456')
    await page.getByLabel('新密码', { exact: true }).fill('123456')
    await page.getByLabel('确认新密码', { exact: true }).fill('123456')
    await page.getByRole('button', { name: '保存新密码', exact: true }).click()
    await expect(page).toHaveURL(url => url.pathname === '/login')
    await page.getByPlaceholder('教师工号 / 学生学号').fill(actor.user.username)
    await page.getByPlaceholder('请输入密码').fill('123456')
    await page.getByRole('button', { name: '进入墨痕', exact: true }).click()
  }
  await expect(page).toHaveURL(url => url.pathname === target)
}
async function selectFiles(page, content) {
  // Real file inputs trigger FileDropZone and PreviewImagePicker change handlers.
  await page.locator('input[type=file]:not([multiple])').setInputFiles({ name: 'answer.zip', mimeType: 'application/zip', buffer: content })
  await page.locator('input[type=file][multiple]').setInputFiles({ name: 'preview.png', mimeType: 'image/png', buffer: png })
  await expect(page.getByAltText('预览图缩略')).toBeVisible()
  await expect.poll(() => page.getByAltText('预览图缩略').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true)
}
async function submit(page) {
  await page.getByRole('button', { name: '确认提交', exact: true }).click()
  const confirm = page.getByRole('button', { name: '确认替换', exact: true })
  if (await confirm.isVisible()) await confirm.click()
  const receipt = page.getByRole('dialog', { name: '提交成功', exact: true })
  await expect(receipt).toContainText('回执编号')
  await receipt.getByRole('button', { name: '关闭', exact: true }).click()
}

for (const group of [false, true]) test(`${group ? '小组' : '个人'}：真实文件选择→提交→批改→汇总改分及下载→退回重交`, async ({ browser, request, baseURL }, testInfo) => {
  const f = await fixture(request, { group })
  const studentContext = await browser.newContext({ baseURL })
  const teacherContext = await browser.newContext({ baseURL })
  const student = await studentContext.newPage(), teacher = await teacherContext.newPage()
  const errors = []
  for (const page of [student, teacher]) page.on('pageerror', e => errors.push(e.message))
  try {
    await login(student, f.student, `/student/assignments/${f.assignment.id}`)
    await expect(student.getByRole('button', { name: '确认提交', exact: true })).toBeDisabled()
    await student.locator('input[type=file]:not([multiple])').setInputFiles({ name: 'bad.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('bad') })
    await expect(student.locator('.el-message')).toContainText('后缀')
    const original = Buffer.concat([Buffer.alloc(8 * 1024 * 1024, 65), Buffer.from('browser-tail')])
    await selectFiles(student, original)
    await submit(student)
    const saved = await api(request, f.student, 'GET', `/assignments/${f.assignment.id}/my-submission`)
    expect(saved.submit_count).toBe(1)
    const file = await request.get('/api' + saved.api_base + '/file', { headers: { Authorization: 'Bearer ' + f.student.token } })
    expect(file.status()).toBe(200)
    expect(await file.body()).toEqual(original)
    await student.reload()
    await expect(student.getByRole('button', { name: '确认提交', exact: true })).toBeDisabled()
    await expect(student.getByText('提交次数：1', { exact: false })).toBeVisible()

    await login(teacher, f.teacher, `/teacher/assignments/${f.assignment.id}`)
    const row = teacher.locator('.el-table__body-wrapper .el-table__row:visible').filter({ hasText: group ? '浏览器小组' : f.student.user.username })
    await row.getByRole('button', { name: '评分', exact: true }).click()
    const grading = teacher.getByRole('dialog', { name: /批改 ·/ })
    await grading.getByRole('spinbutton').fill('88')
    await grading.locator('textarea').fill('教师私密评语 browser')
    await grading.getByRole('button', { name: '确认', exact: true }).click()
    await expect(grading).not.toBeVisible()
    await expect(row).toContainText('已评分')
    const safe = await api(request, f.student, 'GET', `/assignments/${f.assignment.id}/my-submission`)
    expect(safe).not.toHaveProperty('score')
    expect(safe).not.toHaveProperty('comment')
    await student.reload()
    await expect(student.getByText('老师已完成批改')).toBeVisible()
    await expect(student.getByText('教师私密评语 browser')).toHaveCount(0)

    await teacher.goto(`/teacher/courses/${f.course.id}`)
    await teacher.getByRole('tab', { name: '成绩汇总' }).click()
    const summaryRow = teacher.locator('.el-table__body-wrapper .el-table__row:visible').filter({ hasText: f.student.user.username })
    await expect(summaryRow.locator('td').last()).toHaveText('88.0')
    await summaryRow.locator('[title="点击修改成绩"]').click()
    await summaryRow.getByRole('spinbutton').fill('90')
    await summaryRow.getByRole('spinbutton').press('Enter')
    await expect(summaryRow.locator('td').last()).toHaveText('90.0')
    await teacher.screenshot({ path: testInfo.outputPath('summary.png'), fullPage: true })
    const downloading = teacher.waitForEvent('download')
    await teacher.getByRole('button', { name: '导出成绩表', exact: true }).click()
    const download = await downloading
    expect(download.suggestedFilename()).toBe(f.course.name + '-成绩汇总.xlsx')
    const filename = testInfo.outputPath('summary.xlsx')
    await download.saveAs(filename)
    const book = new ExcelJS.Workbook()
    await book.xlsx.load(await fs.readFile(filename))
    const rows = book.getWorksheet('成绩汇总').getSheetValues().slice(2)
    expect(rows.find(r => r[2] === f.student.user.username)[5]).toBe(90)
    if (group) expect(rows.find(r => r[2] === f.member.user.username)[5]).toBe(90)

    await teacher.goto(`/teacher/assignments/${f.assignment.id}`)
    await row.getByRole('button', { name: '退回', exact: true }).click()
    const returning = teacher.getByRole('dialog', { name: /退回 ·/ })
    await returning.locator('textarea').fill('请补充说明 browser')
    await returning.getByRole('button', { name: '确认', exact: true }).click()
    await expect(returning).not.toBeVisible()
    await student.reload()
    await expect(student.getByText('请补充说明 browser', { exact: true })).toBeVisible()
    await selectFiles(student, Buffer.from('browser-revised'))
    await submit(student)
    const revised = await api(request, f.student, 'GET', `/assignments/${f.assignment.id}/my-submission`)
    expect(revised.submit_count).toBe(2)
    expect(revised.status).toBe('submitted')
    expect((await api(request, f.student, 'GET', revised.api_base + '/receipts')).length).toBe(2)
    const revisedFile = await request.get('/api' + revised.api_base + '/file', { headers: { Authorization: 'Bearer ' + f.student.token } })
    expect(await revisedFile.body()).toEqual(Buffer.from('browser-revised'))
    await expect(student.getByRole('button', { name: '确认提交', exact: true })).toBeDisabled()
    if (group) {
      const member = await studentContext.newPage()
      await login(member, f.member, `/student/assignments/${f.assignment.id}`)
      await expect(member.getByRole('button', { name: '确认提交', exact: true })).toBeDisabled()
      await expect(member.getByText('提交次数：2', { exact: false })).toBeVisible()
      await api(request, f.other, 'GET', revised.api_base + '/receipts', undefined, 403)
    }
    expect(errors).toEqual([])
  } finally {
    await studentContext.close()
    await teacherContext.close()
  }
})

test('文件提交：首片真实落盘后点击暂停，继续上传从服务器断点恢复', async ({ page, request }) => {
  const f = await fixture(request)
  const size = 8 * 1024 * 1024
  const bytes = Buffer.concat([Buffer.alloc(size, 67), Buffer.from('browser-resume-tail')])
  await login(page, f.student, `/student/assignments/${f.assignment.id}`)
  await selectFiles(page, bytes)
  let paused = false, sessionId
  const sent = []
  // Delay the second source request only. All responses and persisted bytes come from the real API.
  await page.route('**/upload-sessions/*/files/*/chunk', async route => {
    const range = route.request().headers()['content-range']
    sessionId = route.request().url().match(/upload-sessions\/([^/]+)/)[1]
    if (!paused && range.startsWith(`bytes ${size}-`)) {
      paused = true
      await page.getByRole('button', { name: '暂停', exact: true }).click()
      await route.abort('aborted')
      return
    }
    if (range.endsWith('/' + bytes.length)) sent.push(range)
    await route.continue()
  })
  await page.getByRole('button', { name: '确认提交', exact: true }).click()
  await expect(page.getByRole('button', { name: '继续上传', exact: true })).toBeVisible()
  const session = await api(request, f.student, 'GET', '/upload-sessions/' + sessionId)
  expect(session.files.find(file => file.file_role === 'source').uploaded_bytes).toBe(size)
  expect(await api(request, f.student, 'GET', `/assignments/${f.assignment.id}/my-submission`)).toBeNull()
  await page.getByRole('button', { name: '继续上传', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '提交成功', exact: true })).toBeVisible()
  expect(sent).toEqual([`bytes 0-${size - 1}/${bytes.length}`, `bytes ${size}-${bytes.length - 1}/${bytes.length}`])
  const saved = await api(request, f.student, 'GET', `/assignments/${f.assignment.id}/my-submission`)
  expect(saved.submit_count).toBe(1)
  const downloaded = await request.get('/api' + saved.api_base + '/file', { headers: { Authorization: 'Bearer ' + f.student.token } })
  expect(await downloaded.body()).toEqual(bytes)
  expect((await api(request, f.student, 'GET', saved.api_base + '/receipts')).length).toBe(1)
})

test('成绩舍入边界：2.55 分在真实页面与下载的 Excel 中都应显示 2.6', async ({ page, request }, testInfo) => {
  const f = await fixture(request, { online: true })
  await login(page, f.student, `/student/assignments/${f.assignment.id}`)
  await page.getByPlaceholder('在此输入作答内容').fill('舍入边界样本')
  await submit(page)
  const saved = await api(request, f.student, 'GET', `/assignments/${f.assignment.id}/my-submission`)
  await api(request, f.teacher, 'POST', saved.api_base + '/grade', { score: 2.55, comment: '' })
  await login(page, f.teacher, `/teacher/courses/${f.course.id}`)
  await page.getByRole('tab', { name: '成绩汇总' }).click()
  const row = page.locator('.el-table__row:visible').filter({ hasText: f.student.user.username })
  await expect(row.locator('td').last()).not.toBeEmpty()
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出成绩表', exact: true }).click()
  const download = await downloading
  const filename = testInfo.outputPath('rounding.xlsx')
  await download.saveAs(filename)
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(await fs.readFile(filename))
  const exported = book.getWorksheet('成绩汇总').getSheetValues().slice(2).find(r => r[2] === f.student.user.username)[5]
  await testInfo.attach('rounding-evidence', { body: JSON.stringify({ input: 2.55, expected: 2.6, page: await row.locator('td').last().innerText(), exported }), contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath('rounding.png'), fullPage: true })
  expect(exported).toBe(2.6)
  // Keep this regression enabled: a mismatch must fail the release gate, not be skipped or marked expected.
  await expect(row.locator('td').last()).toHaveText('2.6')
})

test('在线作答：空答案、真实断网失败、刷新恢复草稿、重试后只生成一张回执', async ({ page, context, request }) => {
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  const f = await fixture(request, { online: true })
  await login(page, f.student, `/student/assignments/${f.assignment.id}`)
  await page.getByRole('button', { name: '确认提交', exact: true }).click()
  await expect(page.locator('.el-message')).toContainText('填写在线')
  await page.getByPlaceholder('在此输入作答内容').fill('浏览器在线作答，断网草稿必须保留')
  await context.setOffline(true)
  await page.getByRole('button', { name: '确认提交', exact: true }).click()
  await expect(page.locator('.el-message--error')).toBeVisible()
  await context.setOffline(false)
  await page.reload()
  await expect(page.getByPlaceholder('在此输入作答内容')).toHaveValue('浏览器在线作答，断网草稿必须保留')
  await submit(page)
  const saved = await api(request, f.student, 'GET', `/assignments/${f.assignment.id}/my-submission`)
  expect(saved.content).toBe('浏览器在线作答，断网草稿必须保留')
  expect(saved.submit_count).toBe(1)
  expect((await api(request, f.student, 'GET', saved.api_base + '/receipts')).length).toBe(1)
  await page.goto('/teacher/courses')
  await expect(page).toHaveURL(/\/student\/courses$/)
  expect(errors).toEqual([])
})


