export function contentFormat(value = 'plain') {
  if (!['plain', 'markdown'].includes(value))
    throw Object.assign(new Error('正文格式无效'), { status: 400 })
  return value
}
