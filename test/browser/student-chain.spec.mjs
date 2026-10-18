import { test, expect } from '@playwright/test'
import ExcelJS from 'exceljs'
import fs from 'node:fs/promises'

const password = 'Browser-student-160'
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
)

async function api(request, actor, method, route, data, status = 200) {
  const response = await request.fetch('/api' + route, {
    method,
    headers: actor ? { Authorization: 'Bearer ' + actor.token } : {},
    data,
  })
  expect(response.status(), method + ' ' + route + ': ' + (await response.text())).toBe(status)
  return response.json()
}
async function fixture(request, { group = false, online = false } = {}) {
  const teacher = await api(request, null, 'POST', '/auth/login', {
    username: 'teacher',
    password: '123456',
  })
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const course = await api(
    request,
    teacher,
    'POST',
    '/courses',
    { name: '浏览器验收-' + suffix },
    201,
  )
  const users = []
  for (const role of ['leader', 'member', 'other']) {
    const username = role + '-' + suffix
    await api(
      request,
      teacher,
      'POST',
      `/courses/${course.id}/students`,
      { username, name: role },
      201,
    )
    const actor = await api(request, null, 'POST', '/auth/login', {
      username,
      password: '123456',
    })
    await api(request, actor, 'PUT', '/auth/password', {
      oldPassword: '123456',
      newPassword: password,
    })
    users.push(await api(request, null, 'POST', '/auth/login', { username, password }))
  }
  const [student, member, other] = users
  const assignment = await api(
    request,
    teacher,
    'POST',
    `/courses/${course.id}/assignments`,
    {
      title: '浏览器作业',
      type: online ? 'online' : 'document',
      status: group ? 'draft' : 'published',
      work_mode: group ? 'group' : 'individual',
      total_score: 100,
      allow_resubmit_count: 0,
      max_file_mb: 20,
      allowed_extensions: 'zip',
      require_preview_image: !online,
      preview_max_count: 2,
    },
    201,
  )
  if (group) {
    const team = await api(
      request,
      teacher,
      'POST',
      `/courses/${course.id}/groups`,
      {
        name: '浏览器小组',
        member_ids: [student.user.id, member.user.id],
        leader_id: student.user.id,
      },
      201,
    )
    await api(request, teacher, 'POST', `/assignments/${assignment.id}/groups/snapshot`, {
      group_ids: [team.id],
    })
    await api(request, teacher, 'POST', `/assignments/${assignment.id}/publish`)
  }
  await api(request, teacher, 'PUT', `/courses/${course.id}/grade-config`, {
    daily_ratio: 100,
    final_ratio: 0,
    grade_absent_mode: 'zero',
    final_assignment_id: null,
    weights: [{ assignment_id: assignment.id, grade_weight: 100 }],
  })
  return { teacher, student, member, other, course, assignment }
}
async function login(page, actor, target) {
  await page.goto('/login?redirect=' + encodeURIComponent(target))
  await page.getByPlaceholder('教师工号 / 学生学号').fill(actor.user.username)
  await page
    .getByPlaceholder('请输入密码')
    .fill(actor.user.role === 'teacher' ? '123456' : password)
  await page.getByRole('button', { name: '进入墨痕', exact: true }).click()
  if (actor.user.must_change_password) {
    await expect(page).toHaveURL((url) => url.pathname === '/password')
    await page.getByLabel('原密码', { exact: true }).fill('123456')
    await page.getByLabel('新密码', { exact: true }).fill('123456')
    await page.getByLabel('确认新密码', { exact: true }).fill('123456')
    await page.getByRole('button', { name: '保存新密码', exact: true }).click()
    await expect(page).toHaveURL((url) => url.pathname === '/login')
    await page.getByPlaceholder('教师工号 / 学生学号').fill(actor.user.username)
    await page.getByPlaceholder('请输入密码').fill('123456')
    await page.getByRole('button', { name: '进入墨痕', exact: true }).click()
  }
  await expect(page).toHaveURL((url) => url.pathname === target)
  // A first-login password change invalidates the fixture's earlier token.
  Object.assign(
    actor,
    await page.evaluate(() => ({
      token: localStorage.getItem('hw_token'),
      user: JSON.parse(localStorage.getItem('hw_user')),
    })),
  )
}
async function selectFiles(page, content) {
  // Real file inputs trigger FileDropZone and PreviewImagePicker change handlers.
  await page.locator('input[type=file]:not([multiple])').setInputFiles({
    name: 'answer.zip',
    mimeType: 'application/zip',
    buffer: content,
  })
  await page
    .locator('input[type=file][multiple]')
    .setInputFiles({ name: 'preview.png', mimeType: 'image/png', buffer: png })
  await expect(page.getByAltText('第 1 张预览图')).toBeVisible()
  await expect
    .poll(() =>
      page.getByAltText('第 1 张预览图').evaluate((img) => img.complete && img.naturalWidth > 0),
    )
    .toBe(true)
}
async function submit(page) {
  const edit = page.getByRole('button', {
    name: /^(修改提交|修改并重新提交)$/,
  })
  if (await edit.isVisible()) await edit.click()
  await page
    .getByRole('button', {
      name: /^(确认提交|确认提交修改|确认重新提交|仍要迟交)$/,
    })
    .click()
  const confirm = page.getByRole('button', {
    name: /^(确认替换|仍要提交)$/,
  })
  if (await confirm.isVisible()) await confirm.click()
  const receipt = page.getByRole('dialog', { name: '提交成功', exact: true })
  await expect(receipt).toContainText('回执编号')
  await receipt.getByRole('button', { name: '关闭', exact: true }).click()
}

async function setLateOnly(page, checked) {
  const checkbox = page.getByRole('checkbox', { name: '只看迟交' })
  if ((await checkbox.isChecked()) !== checked)
    await page.locator('.el-checkbox').filter({ hasText: '只看迟交' }).click()
  if (checked) await expect(checkbox).toBeChecked()
  else await expect(checkbox).not.toBeChecked()
}

async function expectSubmissionCount(page, count) {
  await page.getByRole('button', { name: '历史与回执', exact: true }).click()
  const history = page.getByRole('dialog', {
    name: '提交历史与回执',
    exact: true,
  })
  await expect(history.locator('article').first()).toContainText(new RegExp(`第\\s*${count}\\s*次`))
  await history.getByRole('button', { name: 'Close this dialog' }).click()
}

for (const group of [false, true])
  test(`${group ? '小组' : '个人'}：真实文件选择→提交→批改→汇总改分及下载→退回重交`, async ({
    browser,
    request,
    baseURL,
  }, testInfo) => {
    test.setTimeout(120_000)
    const f = await fixture(request, { group })
    await api(request, f.teacher, 'PUT', `/assignments/${f.assignment.id}`, {
      deadline: '2020-01-01 00:00:00',
    })
    const studentContext = await browser.newContext({ baseURL })
    const teacherContext = await browser.newContext({ baseURL })
    const student = await studentContext.newPage(),
      teacher = await teacherContext.newPage()
    const errors = []
    for (const page of [student, teacher]) page.on('pageerror', (e) => errors.push(e.message))
    async function expectCategories(submitted, returned, graded) {
      for (const [label, count] of [
        ['未交', group ? 0 : 2],
        ['待批改', submitted],
        ['已退回', returned],
        ['已经评分', graded],
      ])
        await expect(
          teacher.locator('.el-radio-button').filter({ hasText: `${label}（${count}）` }),
        ).toHaveCount(1)
    }
    try {
      await login(student, f.student, `/student/assignments/${f.assignment.id}`)
      await expect(student.getByRole('button', { name: /^(确认提交|仍要迟交)$/ })).toBeDisabled()
      await student.locator('input[type=file]:not([multiple])').setInputFiles({
        name: 'bad.exe',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from('bad'),
      })
      await expect(student.locator('.el-message')).toContainText('后缀')
      const original = Buffer.concat([
        Buffer.alloc(8 * 1024 * 1024, 65),
        Buffer.from('browser-tail'),
      ])
      await selectFiles(student, original)
      if (!group) {
        await student.getByRole('button', { name: '放大查看第 1 张预览图', exact: true }).click()
        const localPreview = student.getByRole('dialog', {
          name: '预览图片',
          exact: true,
        })
        await expect(localPreview.locator('.preview-gallery-stage img')).toBeVisible()
        await localPreview.getByRole('button', { name: '放大', exact: true }).click()
        await localPreview.getByRole('button', { name: '旋转', exact: true }).click()
        await localPreview.getByRole('button', { name: 'Close this dialog' }).click()
      }
      await submit(student)
      const saved = await api(
        request,
        f.student,
        'GET',
        `/assignments/${f.assignment.id}/my-submission`,
      )
      expect(saved.submit_count).toBe(1)
      const file = await request.get('/api' + saved.api_base + '/file', {
        headers: { Authorization: 'Bearer ' + f.student.token },
      })
      expect(file.status()).toBe(200)
      expect(await file.body()).toEqual(original)
      await student.reload()
      await expect(student.getByRole('button', { name: '修改提交', exact: true })).toBeDisabled()
      await expectSubmissionCount(student, 1)

      await login(teacher, f.teacher, `/teacher/assignments/${f.assignment.id}`)
      await expectCategories(1, 0, 0)
      await teacher.locator('.el-radio-button').filter({ hasText: '待批改' }).click()
      const row = teacher
        .locator('.el-table__body-wrapper .el-table__row:visible')
        .filter({ hasText: group ? '浏览器小组' : f.student.user.username })
      await setLateOnly(teacher, true)
      await expect(row).toBeVisible()
      await setLateOnly(teacher, false)
      await row.getByRole('button', { name: '评分', exact: true }).click()
      const grading = teacher.getByRole('dialog', { name: /作业批改 ·/ })
      await expect(grading.locator('.preview-gallery-stage img')).toBeVisible()
      await expect
        .poll(() =>
          grading
            .locator('.preview-gallery-stage img')
            .evaluate((image) => image.complete && image.naturalWidth > 0),
        )
        .toBe(true)
      await grading.getByRole('spinbutton').fill('88')
      await grading.locator('textarea').fill('教师私密评语 browser')
      await grading.getByRole('button', { name: '保存评分', exact: true }).click()
      await expect(grading).not.toBeVisible()
      await expectCategories(0, 0, 1)
      await teacher.locator('.el-radio-button').filter({ hasText: '已经评分' }).click()
      await expect(row).toContainText('已评分')
      const safe = await api(
        request,
        f.student,
        'GET',
        `/assignments/${f.assignment.id}/my-submission`,
      )
      expect(safe).not.toHaveProperty('score')
      expect(safe).not.toHaveProperty('comment')
      await student.reload()
      await expect(student.getByText('老师已完成批改')).toBeVisible()
      await expect(student.getByText('教师私密评语 browser')).toHaveCount(0)

      await teacher.goto(`/teacher/courses/${f.course.id}`)
      await teacher.getByRole('tab', { name: '成绩汇总' }).click()
      const summaryRow = teacher
        .locator('.el-table__body-wrapper .el-table__row:visible')
        .filter({ hasText: f.student.user.username })
      await expect(summaryRow.locator('td').last()).toHaveText('88.0')
      await summaryRow.getByRole('button', { name: '查看评分', exact: true }).click()
      const summaryGrading = teacher.getByRole('dialog', {
        name: /作业批改 ·/,
      })
      await summaryGrading.getByRole('button', { name: '修改评分', exact: true }).click()
      await summaryGrading.getByRole('spinbutton').fill('90')
      await summaryGrading.getByRole('button', { name: '保存评分', exact: true }).click()
      await expect(summaryRow.locator('td').last()).toHaveText('90.0')
      await summaryRow.getByRole('button', { name: '查看评分', exact: true }).click()
      await summaryGrading.getByRole('button', { name: '修改评分', exact: true }).click()
      await expect(summaryGrading.getByRole('spinbutton')).toHaveValue('90')
      await summaryGrading.locator('textarea').fill('仅修改评语 browser')
      await summaryGrading.getByRole('button', { name: '保存评分', exact: true }).click()
      await expect(summaryRow.locator('td').last()).toHaveText('90.0')
      await teacher.reload()
      await teacher.getByRole('tab', { name: '成绩汇总' }).click()
      await summaryRow.getByRole('button', { name: '查看评分', exact: true }).click()
      await expect(summaryGrading).toContainText('仅修改评语 browser')
      await summaryGrading.getByRole('button', { name: '关闭', exact: true }).click()
      await teacher.screenshot({
        path: testInfo.outputPath('summary.png'),
        fullPage: true,
      })
      const downloading = teacher.waitForEvent('download')
      await teacher.getByRole('button', { name: '导出成绩表', exact: true }).click()
      const download = await downloading
      expect(download.suggestedFilename()).toBe(f.course.name + '-成绩汇总.xlsx')
      const filename = testInfo.outputPath('summary.xlsx')
      await download.saveAs(filename)
      const book = new ExcelJS.Workbook()
      await book.xlsx.load(await fs.readFile(filename))
      const rows = book.getWorksheet('成绩汇总').getSheetValues().slice(2)
      expect(rows.find((r) => r[2] === f.student.user.username)[5]).toBe(90)
      if (group) expect(rows.find((r) => r[2] === f.member.user.username)[5]).toBe(90)

      await teacher.goto(`/teacher/assignments/${f.assignment.id}`)
      await teacher.locator('.el-radio-button').filter({ hasText: '已经评分' }).click()
      await row.getByRole('button', { name: '查看评分', exact: true }).click()
      const returning = teacher.getByRole('dialog', { name: /作业批改 ·/ })
      await returning.getByRole('button', { name: '修改评分', exact: true }).click()
      await returning.getByRole('button', { name: '退回重做', exact: true }).click()
      await returning.locator('textarea').fill('请补充说明 browser')
      await returning.getByRole('button', { name: '确认退回', exact: true }).click()
      const confirmation = teacher.getByRole('dialog', {
        name: '确认退回作业',
      })
      await confirmation.getByRole('button', { name: '确认退回', exact: true }).click()
      await expect(returning).not.toBeVisible()
      await expectCategories(0, 1, 0)
      await teacher.locator('.el-radio-button').filter({ hasText: '已退回' }).click()
      await expect(row).toContainText('已退回')
      const afterReturn = await api(request, f.teacher, 'GET', `/courses/${f.course.id}/summary`)
      const returnedStudent = afterReturn.students.find((item) => item.id === f.student.user.id)
      expect(returnedStudent.cells[f.assignment.id].status).toBe('returned')
      expect(returnedStudent.cells[f.assignment.id].score).toBeNull()
      expect(returnedStudent.cells[f.assignment.id].comment).toBe('')
      expect(returnedStudent.scores.total_score).toBe(0)
      await student.reload()
      await expect(student.getByText('请补充说明 browser', { exact: true })).toBeVisible()
      await student.getByRole('button', { name: '修改并重新提交', exact: true }).click()
      await selectFiles(student, Buffer.from('browser-revised'))
      await submit(student)
      const revised = await api(
        request,
        f.student,
        'GET',
        `/assignments/${f.assignment.id}/my-submission`,
      )
      expect(revised.submit_count).toBe(2)
      expect(revised.status).toBe('submitted')
      expect((await api(request, f.student, 'GET', revised.api_base + '/receipts')).length).toBe(2)
      const revisedFile = await request.get('/api' + revised.api_base + '/file', {
        headers: { Authorization: 'Bearer ' + f.student.token },
      })
      expect(await revisedFile.body()).toEqual(Buffer.from('browser-revised'))
      await expect(student.getByRole('button', { name: '修改提交', exact: true })).toBeDisabled()
      if (group) {
        const member = await studentContext.newPage()
        await login(member, f.member, `/student/assignments/${f.assignment.id}`)
        await expect(member.getByRole('button', { name: '修改提交', exact: true })).toBeDisabled()
        await expectSubmissionCount(member, 2)
        await api(request, f.other, 'GET', revised.api_base + '/receipts', undefined, 403)
      }
      await teacher.reload()
      await expectCategories(1, 0, 0)
      await teacher.locator('.el-radio-button').filter({ hasText: '待批改' }).click()
      await row.getByRole('button', { name: '评分', exact: true }).click()
      await grading.getByRole('spinbutton').fill('76')
      await grading.locator('textarea').fill('重交后重新评价 browser')
      await grading.getByRole('button', { name: '保存评分', exact: true }).click()
      await expectCategories(0, 0, 1)
      await teacher.goto(`/teacher/courses/${f.course.id}`)
      await teacher.getByRole('tab', { name: '成绩汇总' }).click()
      await expect(summaryRow.locator('td').last()).toHaveText('76.0')
      const finalDownloading = teacher.waitForEvent('download')
      await teacher.getByRole('button', { name: '导出成绩表', exact: true }).click()
      await (await finalDownloading).saveAs(testInfo.outputPath('summary-regraded.xlsx'))
      await book.xlsx.load(await fs.readFile(testInfo.outputPath('summary-regraded.xlsx')))
      const finalRows = book.getWorksheet('成绩汇总').getSheetValues().slice(2)
      expect(finalRows.find((item) => item[2] === f.student.user.username)[5]).toBe(76)
      if (group) expect(finalRows.find((item) => item[2] === f.member.user.username)[5]).toBe(76)
      await teacher.screenshot({
        path: testInfo.outputPath('summary-regraded.png'),
        fullPage: true,
      })
      expect(errors).toEqual([])
    } finally {
      await studentContext.close()
      await teacherContext.close()
    }
  })

test('教师分类：只看迟交排除正常提交，切换后恢复全部待批改', async ({ page, request }) => {
  const f = await fixture(request, { online: true })
  await api(
    request,
    f.student,
    'POST',
    `/assignments/${f.assignment.id}/submit`,
    {
      content: '按时提交',
      base_version: 0,
    },
    201,
  )
  await api(request, f.teacher, 'PUT', `/assignments/${f.assignment.id}`, {
    deadline: '2020-01-01 00:00:00',
  })
  await api(
    request,
    f.member,
    'POST',
    `/assignments/${f.assignment.id}/submit`,
    {
      content: '迟交答案',
      base_version: 0,
    },
    201,
  )
  await login(page, f.teacher, `/teacher/assignments/${f.assignment.id}`)
  await page.locator('.el-radio-button').filter({ hasText: '待批改（2）' }).click()
  const rows = page.locator('.el-table__body-wrapper .el-table__row:visible')
  await expect(rows).toHaveCount(2)
  await setLateOnly(page, true)
  await expect(rows).toHaveCount(1)
  await expect(rows).toContainText(f.member.user.username)
  await setLateOnly(page, false)
  await expect(rows).toHaveCount(2)
  await page.locator('.el-radio-button').filter({ hasText: '未交（1）' }).click()
  await expect(rows).toHaveCount(1)
  await expect(rows).toContainText(f.other.user.username)
})

test('教师统计：不同满分折算后按40/60加权，页面与Excel一致', async ({
  page,
  request,
}, testInfo) => {
  const f = await fixture(request, { online: true })
  await api(request, f.teacher, 'PUT', `/assignments/${f.assignment.id}`, {
    total_score: 50,
  })
  const final = await api(
    request,
    f.teacher,
    'POST',
    `/courses/${f.course.id}/assignments`,
    {
      title: '期末作业',
      type: 'online',
      total_score: 200,
      status: 'published',
    },
    201,
  )
  for (const [assignmentId, score] of [
    [f.assignment.id, 40],
    [final.id, 180],
  ]) {
    const submission = await api(
      request,
      f.student,
      'POST',
      `/assignments/${assignmentId}/submit`,
      {
        content: '统计验收答案',
        base_version: 0,
      },
      201,
    )
    const graded = await api(
      request,
      f.teacher,
      'POST',
      `/assignments/${assignmentId}/batch-grade`,
      {
        score,
        comment: '统计验收',
        items: [
          {
            id: submission.id,
            kind: 'individual',
            expected_status: 'submitted',
            expected_submit_count: 1,
          },
        ],
      },
    )
    expect(graded.success_count).toBe(1)
  }
  await api(request, f.teacher, 'PUT', `/courses/${f.course.id}/grade-config`, {
    daily_ratio: 40,
    final_ratio: 60,
    grade_absent_mode: 'zero',
    final_assignment_id: final.id,
    weights: [
      { assignment_id: f.assignment.id, grade_weight: 40 },
      { assignment_id: final.id, grade_weight: 0 },
    ],
  })
  await login(page, f.teacher, `/teacher/courses/${f.course.id}`)
  await page.getByRole('tab', { name: '成绩汇总' }).click()
  const row = page
    .locator('.el-table__body-wrapper .el-table__row:visible')
    .filter({ hasText: f.student.user.username })
  await expect(row.locator('td').nth(-3)).toHaveText('80.0')
  await expect(row.locator('td').nth(-2)).toHaveText('90.0')
  await expect(row.locator('td').last()).toHaveText('86.0')
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出成绩表', exact: true }).click()
  const filename = testInfo.outputPath('weighted-summary.xlsx')
  await (await downloading).saveAs(filename)
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(await fs.readFile(filename))
  const exported = book
    .getWorksheet('成绩汇总')
    .getSheetValues()
    .slice(2)
    .find((item) => item[2] === f.student.user.username)
  expect(exported.slice(3, 6)).toEqual([80, 90, 86])
})

test('文件提交：首片真实落盘后点击暂停，继续上传从服务器断点恢复', async ({ page, request }) => {
  const f = await fixture(request)
  const size = 8 * 1024 * 1024
  const bytes = Buffer.concat([Buffer.alloc(size, 67), Buffer.from('browser-resume-tail')])
  await login(page, f.student, `/student/assignments/${f.assignment.id}`)
  await selectFiles(page, bytes)
  let paused = false,
    sessionId
  const sent = []
  // Delay the second source request only. All responses and persisted bytes come from the real API.
  await page.route('**/upload-sessions/*/files/*/chunk', async (route) => {
    const range = route.request().headers()['content-range']
    sessionId = route
      .request()
      .url()
      .match(/upload-sessions\/([^/]+)/)[1]
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
  expect(session.files.find((file) => file.file_role === 'source').uploaded_bytes).toBe(size)
  expect(
    await api(request, f.student, 'GET', `/assignments/${f.assignment.id}/my-submission`),
  ).toBeNull()
  await page.getByRole('button', { name: '继续上传', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '提交成功', exact: true })).toBeVisible()
  expect(sent).toEqual([
    `bytes 0-${size - 1}/${bytes.length}`,
    `bytes ${size}-${bytes.length - 1}/${bytes.length}`,
  ])
  const saved = await api(
    request,
    f.student,
    'GET',
    `/assignments/${f.assignment.id}/my-submission`,
  )
  expect(saved.submit_count).toBe(1)
  const downloaded = await request.get('/api' + saved.api_base + '/file', {
    headers: { Authorization: 'Bearer ' + f.student.token },
  })
  expect(await downloaded.body()).toEqual(bytes)
  expect((await api(request, f.student, 'GET', saved.api_base + '/receipts')).length).toBe(1)
})

test('成绩舍入边界：2.55 分在真实页面与下载的 Excel 中都应显示 2.6', async ({
  page,
  request,
}, testInfo) => {
  const f = await fixture(request, { online: true })
  await login(page, f.student, `/student/assignments/${f.assignment.id}`)
  await page.getByPlaceholder('在此输入作答内容').fill('舍入边界样本')
  await submit(page)
  const saved = await api(
    request,
    f.student,
    'GET',
    `/assignments/${f.assignment.id}/my-submission`,
  )
  await api(request, f.teacher, 'POST', `/assignments/${f.assignment.id}/batch-grade`, {
    score: 2.55,
    comment: '',
    items: [{ id: saved.id, kind: 'individual' }],
  })
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
  const exported = book
    .getWorksheet('成绩汇总')
    .getSheetValues()
    .slice(2)
    .find((r) => r[2] === f.student.user.username)[5]
  await testInfo.attach('rounding-evidence', {
    body: JSON.stringify({
      input: 2.55,
      expected: 2.6,
      page: await row.locator('td').last().innerText(),
      exported,
    }),
    contentType: 'application/json',
  })
  await page.screenshot({
    path: testInfo.outputPath('rounding.png'),
    fullPage: true,
  })
  expect(exported).toBe(2.6)
  // Keep this regression enabled: a mismatch must fail the release gate, not be skipped or marked expected.
  await expect(row.locator('td').last()).toHaveText('2.6')
})

test('在线作答：空答案、真实断网失败、刷新恢复草稿、重试后只生成一张回执', async ({
  page,
  context,
  request,
}) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const f = await fixture(request, { online: true })
  await login(page, f.student, `/student/assignments/${f.assignment.id}`)
  await page.getByRole('button', { name: '确认提交', exact: true }).click()
  await expect(page.locator('.el-message')).toContainText('填写在线')
  await page.getByPlaceholder('在此输入作答内容').fill('浏览器在线作答，断网草稿必须保留')
  await context.setOffline(true)
  await page.getByRole('button', { name: '确认提交', exact: true }).click()
  const submissionError = page.locator('.el-alert').filter({ hasText: '提交未完成' })
  await expect(submissionError).toContainText('网络连接中断')
  await expect(submissionError).toContainText('问题编号')
  await expect(submissionError.getByRole('button', { name: '按当前内容重试' })).toBeVisible()
  await context.setOffline(false)
  await page.reload()
  await expect(page.getByPlaceholder('在此输入作答内容')).toHaveValue(
    '浏览器在线作答，断网草稿必须保留',
  )
  await submit(page)
  const saved = await api(
    request,
    f.student,
    'GET',
    `/assignments/${f.assignment.id}/my-submission`,
  )
  expect(saved.content).toBe('浏览器在线作答，断网草稿必须保留')
  expect(saved.submit_count).toBe(1)
  expect((await api(request, f.student, 'GET', saved.api_base + '/receipts')).length).toBe(1)
  await page.goto('/teacher/courses')
  await expect(page).toHaveURL(/\/student\/courses$/)
  expect(errors).toEqual([])
})

test('图片接口兼容：旧字段、无票据接口、已评分与汇总原图及失败重试', async ({
  page,
  request,
}, testInfo) => {
  const f = await fixture(request)
  const uploaded = await request.post(`/api/assignments/${f.assignment.id}/submit`, {
    headers: { Authorization: 'Bearer ' + f.student.token },
    multipart: {
      base_version: '0',
      file: {
        name: 'answer.zip',
        mimeType: 'application/zip',
        buffer: Buffer.from('compat'),
      },
      previews: { name: 'preview.png', mimeType: 'image/png', buffer: png },
    },
  })
  expect(uploaded.status()).toBe(201)
  const saved = await uploaded.json()
  await page.route('**/api/previews/view-ticket', (route) =>
    route.fulfill({ status: 404, json: { message: 'old server' } }),
  )
  const oldRows = (rows) =>
    rows.map((row) => ({
      ...row,
      previews: (row.previews || []).map((image) => ({
        id: image.id,
        original_name: image.name,
        file_url: image.preview,
        thumbnail_url: image.thumbnail,
      })),
    }))
  await page.route(`**/api/assignments/${f.assignment.id}/submissions*`, async (route) => {
    const response = await route.fetch()
    const data = await response.json()
    await route.fulfill({
      response,
      json: Array.isArray(data) ? oldRows(data) : { ...data, rows: oldRows(data.rows) },
    })
  })
  await page.route(`**/api/courses/${f.course.id}/students/*/submissions`, async (route) => {
    const response = await route.fetch()
    await route.fulfill({
      response,
      json: { rows: oldRows(await response.json()) },
    })
  })
  let blocked = false,
    failedOriginalRequests = 0
  await page.route('**/api/submission-previews/*/file', (route) => {
    if (blocked) {
      failedOriginalRequests++
      return route.fulfill({
        status: 404,
        json: { message: '预览图文件不存在' },
      })
    }
    return route.continue()
  })
  await login(page, f.teacher, `/teacher/assignments/${f.assignment.id}`)
  await page.locator('.el-radio-button').filter({ hasText: '待批改' }).click()
  const row = page.locator('.el-table__row:visible').filter({ hasText: f.student.user.username })
  await row.locator('.submission-preview').click()
  let dialog = page.getByRole('dialog', { name: /作业图片/ })
  await expect
    .poll(() =>
      dialog
        .locator('.preview-gallery-stage img')
        .evaluate((image) => image.complete && image.naturalWidth > 0),
    )
    .toBe(true)
  await dialog.getByRole('button', { name: 'Close this dialog' }).click()
  await row.getByRole('button', { name: '评分', exact: true }).click()
  const grading = page.getByRole('dialog', { name: /作业批改/ })
  await expect(grading.locator('.preview-gallery-stage img')).toBeVisible()
  await grading.getByRole('spinbutton').fill('85')
  await grading.getByRole('button', { name: '保存评分', exact: true }).click()
  await page.locator('.el-radio-button').filter({ hasText: '已经评分' }).click()
  await row.locator('.submission-preview').click()
  dialog = page.getByRole('dialog', { name: /作业图片/ })
  await expect(dialog.locator('.preview-gallery-stage img')).toBeVisible()
  await dialog.getByRole('button', { name: 'Close this dialog' }).click()
  await page.goto(`/teacher/courses/${f.course.id}`)
  await page.getByRole('tab', { name: '成绩汇总' }).click()
  const summaryRow = page
    .locator('.el-table__row:visible')
    .filter({ hasText: f.student.user.username })
  await summaryRow.getByRole('button', { name: '查看评分', exact: true }).click()
  await expect(grading.locator('.preview-gallery-stage img')).toBeVisible()
  await grading.getByRole('button', { name: '关闭', exact: true }).click()
  blocked = true
  // Reload clears the in-memory image cache so the failure actually reaches the network.
  await page.reload()
  await page.getByRole('tab', { name: '成绩汇总' }).click()
  await summaryRow.locator('.submission-preview').click()
  dialog = page.getByRole('dialog', {
    name: new RegExp(f.student.user.name + ' · 浏览器作业'),
  })
  await expect(dialog.getByRole('status')).toContainText('原图加载失败：图片文件不存在')
  await expect(dialog.locator('.preview-gallery-stage img')).toBeVisible()
  await expect(dialog.getByRole('button', { name: '放大', exact: true })).toBeDisabled()
  expect(failedOriginalRequests).toBeGreaterThan(0)
  blocked = false
  await dialog.getByRole('button', { name: '重试原图' }).click()
  await expect(dialog.locator('.preview-gallery-stage img')).toBeVisible()
  await expect(dialog.getByRole('button', { name: '放大', exact: true })).toBeEnabled()
  await page.screenshot({
    path: testInfo.outputPath('compatible-image-gallery.png'),
    fullPage: true,
  })
  const rows = await api(
    request,
    f.teacher,
    'GET',
    `/assignments/${f.assignment.id}/submissions?status=graded`,
  )
  const actual = rows.rows.find((row) => row.id === saved.id)
  expect(actual.score).toBe(85)
  expect(actual.submit_count).toBe(1)
})

test('教师资料通过界面分片上传，编辑说明与下载字节一致', async ({ page, request }) => {
  const f = await fixture(request)
  const bytes = Buffer.from('material-upload-ui-integrity')
  await login(page, f.teacher, `/teacher/courses/${f.course.id}`)
  await page.getByRole('tab', { name: '学习资料' }).click()
  await page.getByRole('button', { name: '上传资料', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: '上传资料', exact: true })
  await dialog.locator('input.el-input__inner').fill('界面上传资料')
  await dialog
    .locator('input[type=file]')
    .setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: bytes })
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  const row = page.locator('.el-table__row:visible').filter({ hasText: '界面上传资料' })
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: '编辑', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '编辑资料', exact: true })
  await dialog.locator('textarea').fill('仅改说明，不替换文件')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  const materials = await api(request, f.student, 'GET', `/courses/${f.course.id}/materials`)
  expect(materials).toHaveLength(1)
  expect(materials[0].description).toBe('仅改说明，不替换文件')
  const download = await request.get(`/api/materials/${materials[0].id}/file`, {
    headers: { Authorization: 'Bearer ' + f.student.token },
  })
  expect(download.status()).toBe(200)
  expect(await download.body()).toEqual(bytes)
})

test('资料排序持久保存与成员选择器：搜索、成员冲突和组长移除', async ({
  page,
  request,
}, testInfo) => {
  const f = await fixture(request)
  for (const title of ['资料甲', '资料乙']) {
    expect(
      (
        await request.post(`/api/courses/${f.course.id}/materials`, {
          headers: { Authorization: 'Bearer ' + f.teacher.token },
          multipart: {
            title,
            file: {
              name: 'notes.txt',
              mimeType: 'text/plain',
              buffer: Buffer.from(title),
            },
          },
        })
      ).status(),
    ).toBe(201)
  }
  await login(page, f.teacher, `/teacher/courses/${f.course.id}`)
  await page.getByRole('tab', { name: '学习资料' }).click()
  await page
    .locator('.el-table__row:visible')
    .filter({ hasText: '资料乙' })
    .getByRole('button', { name: '下移', exact: true })
    .click()
  await expect(page.locator('.el-table__row:visible').first()).toContainText('资料甲')
  await page.reload()
  await page.getByRole('tab', { name: '学习资料' }).click()
  await expect(page.locator('.el-table__row:visible').first()).toContainText('资料甲')
  const list = await api(request, f.student, 'GET', `/courses/${f.course.id}/materials`)
  expect(list.map((row) => row.title)).toEqual(['资料甲', '资料乙'])
  await page.getByRole('tab', { name: '分组', exact: true }).click()
  await page.getByRole('button', { name: '创建小组' }).click()
  let dialog = page.getByRole('dialog', { name: '课程分组', exact: true })
  await dialog.getByPlaceholder('请输入小组名称').fill('验收一组')
  await dialog.getByPlaceholder('搜索姓名或学号').fill(f.student.user.username)
  await dialog.locator('.member-list .el-checkbox').click()
  await expect(dialog.getByRole('checkbox')).toBeChecked()
  await dialog.getByPlaceholder('搜索姓名或学号').fill(f.member.user.username)
  await dialog.locator('.member-list .el-checkbox').click()
  await expect(dialog.getByRole('checkbox')).toBeChecked()
  await expect(dialog.locator('.member-selected')).toContainText('已选 2 人')
  await dialog.locator('.el-select').click()
  await page
    .getByRole('option', {
      name: `leader（${f.student.user.username}）`,
      exact: true,
    })
    .click()
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await page
    .locator('.group-card')
    .filter({ hasText: '验收一组' })
    .getByRole('button', { name: '编辑', exact: true })
    .click()
  dialog = page.getByRole('dialog', { name: '课程分组', exact: true })
  await dialog
    .locator('.member-tags .el-tag')
    .filter({ hasText: f.student.user.username })
    .locator('.el-tag__close')
    .click()
  await expect(dialog.locator('.el-select')).toContainText('请选择组长')
  await expect(dialog.locator('.member-selected')).toContainText('已选 1 人')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('button', { name: '创建小组' }).click()
  dialog = page.getByRole('dialog', { name: '课程分组', exact: true })
  await dialog.getByPlaceholder('搜索姓名或学号').fill(f.student.user.username)
  await expect(dialog.getByRole('checkbox')).toBeDisabled()
  await expect(dialog.locator('.member-list')).toContainText('验收一组')
  await page.screenshot({
    path: testInfo.outputPath('group-picker.png'),
    fullPage: true,
  })
})
