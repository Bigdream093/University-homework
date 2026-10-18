const DEADLINE_WARNING_HOURS = 24

function parseChinaTime(value) {
  if (!value) return null
  const timestamp = Date.parse(String(value).replace(' ', 'T') + '+08:00')
  return Number.isFinite(timestamp) ? timestamp : null
}

export function createServerClock(serverTime) {
  const serverTimestamp = parseChinaTime(serverTime) ?? Date.now()
  const clientTimestamp = Date.now()
  return () => serverTimestamp + (Date.now() - clientTimestamp)
}

export function closestDeadlineAssignment(assignments, now = Date.now()) {
  const currentSecond = Math.floor(now / 1000) * 1000
  let upcoming = null,
    upcomingTime = Infinity,
    latest = null,
    latestTime = -Infinity
  for (const assignment of assignments) {
    if (assignment.status !== 'published' || assignment.not_assigned) continue
    const timestamp = parseChinaTime(assignment.effective_deadline)
    if (timestamp === null) continue
    if (timestamp >= currentSecond && timestamp < upcomingTime) {
      upcoming = assignment
      upcomingTime = timestamp
    } else if (timestamp < currentSecond && timestamp > latestTime) {
      latest = assignment
      latestTime = timestamp
    }
  }
  return upcoming || latest
}

export function deadlineState(deadline, now = Date.now()) {
  const deadlineTimestamp = parseChinaTime(deadline)
  if (!deadlineTimestamp) return { kind: 'none', text: '不限时间', remainingMs: null }

  const remainingMs = deadlineTimestamp - Math.floor(now / 1000) * 1000
  if (remainingMs < 0) {
    return { kind: 'late', text: '已超过截止时间，提交将记为迟交', remainingMs }
  }

  if (remainingMs <= DEADLINE_WARNING_HOURS * 60 * 60 * 1000) {
    const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60000))
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    const timeText = hours > 0 ? `${hours}小时${minutes ? `${minutes}分钟` : ''}` : `${minutes}分钟`
    return { kind: 'warning', text: `距离截止还有${timeText}`, remainingMs }
  }

  return { kind: 'normal', text: `截止：${deadline}`, remainingMs }
}

export function deadlineRemainingText(state) {
  const remaining = state?.remainingMs
  if (remaining == null) return ''
  if (remaining < 0) return '已截止'
  if (state.kind === 'warning') return state.text.replace('距离截止还有', '剩余 ')

  const totalHours = Math.floor(remaining / 3_600_000)
  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  return `剩余 ${days} 天${hours ? ` ${hours} 小时` : ''}`
}
