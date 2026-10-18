import { submissionCounts } from '@university-homework/domain/gradingSummary'

const isTester = (row) => {
  if (row.is_test_student != null) return Boolean(Number(row.is_test_student))
  if (row.kind === 'group' || row.assignment_group_id)
    return (
      Boolean(row.members?.length) && row.members.every((member) => member.name?.includes('测试员'))
    )
  return Boolean(row.name?.includes('测试员'))
}

export function legacySubmissionPage(
  data,
  assignment,
  { status, keyword, page, pageSize, lateOnly = false },
) {
  const all = data.map((row) => ({ ...row, is_test_student: isTester(row) ? 1 : 0 }))
  const { counts, stats } = submissionCounts(all, assignment)
  const search = keyword.trim().toLowerCase()
  const filtered = all.filter((row) => {
    if (
      search &&
      ![
        row.name,
        row.username,
        ...(row.members || []).flatMap((member) => [member.name, member.username]),
      ]
        .join(' ')
        .toLowerCase()
        .includes(search)
    )
      return false
    if (status === 'unsubmitted') {
      if (row.id) return false
    } else if (status === 'late') {
      return Boolean(row.id) && Number(row.is_late) === 1
    } else if (!row.id || row.status !== status) return false
    return !lateOnly || (Boolean(row.id) && Number(row.is_late) === 1)
  })
  const current = Math.min(page, Math.max(1, Math.ceil(filtered.length / pageSize)))
  return {
    rows: filtered.slice((current - 1) * pageSize, current * pageSize),
    total: filtered.length,
    page: current,
    page_size: pageSize,
    counts,
    stats,
  }
}

export function validateSubmissionPage(data) {
  if (
    !data ||
    !Array.isArray(data.rows) ||
    !Number.isFinite(data.total) ||
    !data.counts ||
    !data.stats
  )
    throw new Error('提交列表返回格式异常，请刷新重试或检查服务器版本')
  return data
}
