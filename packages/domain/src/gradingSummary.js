// 批改列表的纯数据变换：缺勤记0 分的合并与提交统计口径。
// 不触碰 req/res 与数据库，供路由复用；导出后其他接口（如未交名单导出）可直接沿用同一口径。

// 把缺勤记0 分记录并入提交行：个人提交按 student_id 匹配，小组提交按 assignment_group_id 匹配，
// 命中即覆盖为0 分并标记 absence_graded。marks 为同一作业的缺勤记录集合。
export function mergeAbsenceMarks(rows, marks) {
  const byStudent = new Map(
    marks.filter((mark) => mark.student_id).map((mark) => [mark.student_id, mark]),
  )
  const byGroup = new Map(
    marks
      .filter((mark) => mark.assignment_group_id)
      .map((mark) => [mark.assignment_group_id, mark]),
  )
  return rows.map((row) => {
    const mark = row.student_id
      ? byStudent.get(row.student_id)
      : byGroup.get(row.assignment_group_id)
    return mark ? { ...row, absence_graded: true, score: 0, graded_at: mark.graded_at } : row
  })
}

// 列表计数与统计口径：counts 用于筛选面板，stats 用于进度条。
// 测试账号（is_test_student）不计入应交人数，避免污染班级统计。
export function submissionCounts(rows, assignment) {
  const counts = {
    all: rows.length,
    unsubmitted: 0,
    submitted: 0,
    late: 0,
    returned: 0,
    graded: 0,
    missingPreview: 0,
  }
  let expected = 0,
    submitted = 0,
    graded = 0
  for (const row of rows) {
    if (!Number(row.is_test_student)) {
      expected++
      if (row.id) submitted++
      else counts.unsubmitted++
      if (row.status === 'graded') graded++
    }
    if (row.id && row.status === 'submitted') counts.submitted++
    if (row.id && Number(row.is_late) === 1) counts.late++
    if (row.status === 'returned') counts.returned++
    if (row.status === 'graded') counts.graded++
    if (row.id && !(row.preview_count > 0)) counts.missingPreview++
  }
  return {
    counts,
    stats: {
      all: assignment.unsubmitted_expected_count ?? expected,
      submitted,
      unsubmitted: counts.unsubmitted,
      graded,
    },
  }
}
