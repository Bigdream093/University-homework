import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acquireInstanceLease } from '../src/services/instanceLease.js'

test('single-instance lease rejects a live owner and permits release or stale recovery', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mohen-instance-'))
  try {
    const first = acquireInstanceLease(directory, { heartbeatMs: 60_000 })
    assert.throws(
      () => acquireInstanceLease(directory, { heartbeatMs: 60_000 }),
      /另一个作业管理服务实例/,
    )
    first.release()
    const second = acquireInstanceLease(directory, { heartbeatMs: 60_000 })
    second.release()
    const staleFile = path.join(directory, '.homework-instance.lock')
    fs.writeFileSync(staleFile, JSON.stringify({ hostname: 'stale-host', pid: 999999 }))
    fs.utimesSync(staleFile, new Date('2020-01-01'), new Date('2020-01-01'))
    const recovered = acquireInstanceLease(directory, { staleMs: 1, heartbeatMs: 60_000 })
    recovered.release()
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
