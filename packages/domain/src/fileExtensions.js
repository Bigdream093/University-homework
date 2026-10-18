// 前后端共用：先规范化、去重，再检查后缀名数量。全局类型白名单由服务端额外校验。
export function normalizeExtensions(input) {
  const list = [
    ...new Set(
      String(input ?? '')
        .split(/[,，;；\s]+/)
        .map((token) => token.replace(/^\.+/, '').trim().toLowerCase())
        .filter(Boolean),
    ),
  ]
  for (const ext of list) if (!/^[a-z0-9]{1,12}$/.test(ext)) return { error: ext }
  if (list.length > 20) return { error: '后缀名超过 20 个' }
  return { list }
}
