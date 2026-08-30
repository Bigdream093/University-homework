const DEADLINE_WARNING_HOURS = 24;

function parseChinaTime(value) {
  if (!value) return null;
  const timestamp = Date.parse(String(value).replace(' ', 'T') + '+08:00');
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function createServerClock(serverTime) {
  const serverTimestamp = parseChinaTime(serverTime) ?? Date.now();
  const clientTimestamp = Date.now();
  return () => serverTimestamp + (Date.now() - clientTimestamp);
}

export function deadlineState(deadline, now = Date.now()) {
  const deadlineTimestamp = parseChinaTime(deadline);
  if (!deadlineTimestamp) return { kind: 'none', text: '不限时间', remainingMs: null };

  const remainingMs = deadlineTimestamp - now;
  if (remainingMs <= 0) {
    return { kind: 'late', text: '已超过截止时间，提交将记为迟交', remainingMs };
  }

  if (remainingMs <= DEADLINE_WARNING_HOURS * 60 * 60 * 1000) {
    const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    const timeText = hours > 0 ? `${hours}小时${minutes ? `${minutes}分钟` : ''}` : `${minutes}分钟`;
    return { kind: 'warning', text: `距离截止还有${timeText}`, remainingMs };
  }

  return { kind: 'normal', text: `截止：${deadline}`, remainingMs };
}
