import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequiredQuestionId } from '../src/utils/requiredQuestionId.js'

test('必答题编号：HTTP 环境仅提供 getRandomValues 时仍可生成不重复的 UUID', () => {
  let seed = 0
  const insecureContextCrypto = {
    getRandomValues(bytes) {
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = seed++ & 0xff
      }
      return bytes
    },
  }

  const first = createRequiredQuestionId(insecureContextCrypto)
  const second = createRequiredQuestionId(insecureContextCrypto)

  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.notEqual(first, second)
})
