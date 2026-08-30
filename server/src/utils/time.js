const formatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
});

export function nowText() {
  return formatter.format(new Date()).replace('T', ' ');
}

export function isLate(deadline, now = nowText()) {
  return deadline ? Number(new Date(now.replace(' ', 'T') + '+08:00') > new Date(deadline.replace(' ', 'T') + '+08:00')) : 0;
}
