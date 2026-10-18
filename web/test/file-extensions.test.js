import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeExtensions } from '../src/utils/assignmentForm.js'
import { parseAllowedExtensions } from '../../server/src/utils/fileFilter.js'

test('后缀名按唯一类型计数：重复输入不占用20种类型限额', () => {
  const input = Array(21).fill('.PDF').join('，') + '; Zip'
  assert.deepEqual(normalizeExtensions(input), { list: ['pdf', 'zip'] })
  assert.deepEqual(parseAllowedExtensions(input), ['pdf', 'zip'])
  assert.ok(normalizeExtensions(Array.from({ length: 21 }, (_, i) => `ext${i}`).join(',')).error)
  assert.throws(
    () => parseAllowedExtensions(Array.from({ length: 21 }, (_, i) => `ext${i}`).join(','), false),
    /超过 20 个/,
  )
  assert.ok(normalizeExtensions('pdf,exe/path').error)
  assert.throws(() => parseAllowedExtensions('pdf,exe/path'), /格式无效/)
  assert.throws(() => parseAllowedExtensions('exe'), /系统支持/)
})
