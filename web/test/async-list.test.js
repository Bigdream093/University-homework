import test from 'node:test'
import assert from 'node:assert/strict'
import { effectScope } from 'vue'
import { useAsyncList } from '../src/composables/useAsyncList.js'

function fixture(t) {
  const requests = [],
    commits = [],
    scope = effectScope()
  const list = scope.run(() =>
    useAsyncList(
      (signal) =>
        new Promise((resolve, reject) => {
          requests.push({ signal, resolve, reject })
        }),
      { onLoaded: (data) => commits.push(data) },
    ),
  )
  t.after(() => scope.stop())
  return { list, requests, commits, scope }
}

test('newer list wins even when the old transport ignores abort', async (t) => {
  const { list, requests, commits } = fixture(t)
  const first = list.load(),
    second = list.reload()
  assert.equal(requests[0].signal.aborted, true)
  requests[1].resolve(['new'])
  await second
  requests[0].resolve(['old'])
  await first
  assert.deepEqual(list.data.value, ['new'])
  assert.deepEqual(commits, [['new']])
  assert.equal(list.loading.value, false)
})

test('stale error/finally cannot clear a newer loading state or show an error', async (t) => {
  const { list, requests } = fixture(t)
  const first = list.load(),
    second = list.load()
  requests[0].reject(new Error('stale failure'))
  await first
  assert.equal(list.loading.value, true)
  assert.equal(list.loadError.value, '')
  requests[1].reject(new Error('current failure'))
  await second
  assert.match(list.loadError.value, /current failure/)
  const retry = list.load()
  assert.equal(list.loadError.value, '')
  requests[2].resolve([])
  await retry
  assert.equal(list.loaded.value, true)
})

test('deactivation and disposal invalidate pending work and callbacks', async (t) => {
  const { list, requests, commits, scope } = fixture(t)
  const pending = list.load()
  list.cancel()
  assert.equal(requests[0].signal.aborted, true)
  requests[0].resolve(['inactive'])
  await pending
  const next = list.load()
  scope.stop()
  requests[1].resolve(['unmounted'])
  await next
  await list.load()
  assert.deepEqual(list.data.value, [])
  assert.deepEqual(commits, [])
  assert.equal(requests.length, 2)
  assert.equal(list.loading.value, false)
})
