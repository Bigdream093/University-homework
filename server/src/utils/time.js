const formatter = new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
export function nowText() { return formatter.format(new Date()).replace('T',' '); }
export function parseTime(value) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(value||''))) return NaN;
  const date = new Date(String(value).replace(' ','T')+'+08:00');
  return Number.isFinite(date.getTime()) && formatter.format(date).replace('T',' ')===value ? date.getTime() : NaN;
}
export function validTime(value) { return Number.isFinite(parseTime(value)); }
export function isLate(deadline, now=nowText()) { return deadline ? Number(parseTime(now)>parseTime(deadline)) : 0; }
export function isFuture(value, now=nowText()) { return parseTime(value)>parseTime(now); }
