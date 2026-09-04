import test from 'node:test'
import assert from 'node:assert/strict'
import { hashChunk } from '../src/composables/useChunkedUpload.js'

for (const [name, subtle] of [
  ['WebCrypto 缺失', null],
  ['WebCrypto 调用抛错', { digest: async () => { throw new Error('insecure context') } }],
]) {
  test('分片摘要：' + name + '时生成标准 SHA-256', async () => {
    assert.equal(await hashChunk(new Blob(['abc']), subtle),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
}
