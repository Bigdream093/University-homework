import { db } from '../db.js'
import { fail } from './access.js'

export function nextOrder(table, scopeColumn, scopeId) {
  return db
    .prepare(`SELECT COALESCE(MIN(sort_order),0)-1 value FROM ${table} WHERE ${scopeColumn}=?`)
    .get(scopeId).value
}

export function moveContent({
  table,
  id,
  scopeColumn,
  scopeId,
  direction,
  extraWhere = '',
  extraArgs = [],
}) {
  if (!['up', 'down'].includes(direction)) fail(400, '移动方向无效')
  const current = db
    .prepare(`SELECT id,sort_order FROM ${table} WHERE id=? AND ${scopeColumn}=? ${extraWhere}`)
    .get(id, scopeId, ...extraArgs)
  if (!current) fail(404, '内容不存在')
  const operator = direction === 'up' ? '<' : '>'
  const order = direction === 'up' ? 'DESC' : 'ASC'
  const sibling = db
    .prepare(
      `SELECT id,sort_order FROM ${table} WHERE ${scopeColumn}=? ${extraWhere} AND sort_order ${operator} ? ORDER BY sort_order ${order},id ${order} LIMIT 1`,
    )
    .get(scopeId, ...extraArgs, current.sort_order)
  if (!sibling) return false
  db.transaction(() => {
    db.prepare(`UPDATE ${table} SET sort_order=? WHERE id=?`).run(sibling.sort_order, current.id)
    db.prepare(`UPDATE ${table} SET sort_order=? WHERE id=?`).run(current.sort_order, sibling.id)
  })()
  return true
}
