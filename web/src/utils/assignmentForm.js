export function normalizeExtensions(input) {
  const list = String(input || '')
    .split(/[,，;；\s]+/)
    .map((token) => token.replace(/^\.+/, '').trim().toLowerCase())
    .filter(Boolean)
  for (const ext of list) if (!/^[a-z0-9]{1,12}$/.test(ext)) return { error: ext }
  if (list.length > 20) return { error: '后缀名超过 20 个' }
  return { list: [...new Set(list)] }
}
