import { httpError } from '../utils/httpError.js'

export function contentFormat(value = 'plain') {
  if (!['plain', 'html'].includes(value)) throw httpError(400, '正文格式无效')
  return value
}
