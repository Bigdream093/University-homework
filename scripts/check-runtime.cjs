const assert = require('node:assert/strict')
assert.equal(process.versions.node.split('.')[0], '24', '请使用 Node.js 24.x，再重新运行 npm ci')
const Database = require('better-sqlite3')
const db = new Database(':memory:')
try {
  assert.equal(db.prepare('SELECT 1 value').get().value, 1)
  console.log(`Node ${process.versions.node}: better-sqlite3 加载及查询成功`)
} finally {
  db.close()
}
