const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const http = require('node:http')
const { once } = require('node:events')
const { createUpdateController } = require('../src/updater.cjs')
const { normalizeUpdateBase, validateMacManifest, fetchMacManifest } = require('../src/update-policy.cjs')
const { makeBuildConfig } = require('../scripts/build-config.cjs')

const mac = { version: '1.6.7', role: 'student', platform: 'darwin', arch: 'arm64',
  file: '墨痕学生端-macOS-arm64-1.6.7.dmg', notes: '更新说明' }
const directory = 'http://localhost/update/student/mac-arm64/'

function fixture(overrides = {}) {
  const calls = { checks: 0, installs: 0, dialogs: [], urls: [], constructed: 0 }
  const updater = new EventEmitter()
  updater.checkForUpdates = async () => {
    calls.checks++
    updater.emit('update-not-available')
    return {}
  }
  updater.quitAndInstall = () => { calls.installs++ }
  const controller = createUpdateController({
    app: { isPackaged: true, getVersion: () => '1.6.6' },
    role: 'student', platform: 'win32', arch: 'x64', baseUrl: 'http://localhost/update/',
    getWindowsUpdater: () => { calls.constructed++; return updater },
    dialog: { showMessageBox: async (options) => { calls.dialogs.push(options); return { response: 1 } } },
    shell: { openExternal: async (url) => calls.urls.push(url) },
    ...overrides,
  })
  return { calls, updater, controller }
}

test('startup and menu construction never initialize updater or access network', async () => {
  const { calls, controller } = fixture()
  controller.menuItems()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.constructed, 0)
  assert.equal(calls.checks, 0)
  assert.equal(calls.dialogs.length, 0)
  assert.equal(controller.menuItems()[1].visible, false)
})

test('manual check configures Windows without implicit install or downgrade', async () => {
  const { calls, updater, controller } = fixture()
  await controller.check()
  assert.equal(calls.checks, 1)
  assert.equal(updater.autoDownload, true)
  assert.equal(updater.autoInstallOnAppQuit, false)
  assert.equal(updater.allowDowngrade, false)
  assert.equal(updater.allowPrerelease, false)
  assert.equal(calls.installs, 0)
  assert.match(calls.dialogs[0].message, /最新/)
})

test('download locks repeated checks and only explicit confirmed install runs installer', async () => {
  let resolveDownload
  const { calls, updater, controller } = fixture({
    dialog: { showMessageBox: async () => ({ response: 0 }) },
  })
  updater.checkForUpdates = async () => {
    calls.checks++
    updater.emit('update-available')
    return { downloadPromise: new Promise((resolve) => { resolveDownload = resolve }) }
  }
  const checking = controller.check()
  await new Promise((resolve) => setImmediate(resolve))
  await controller.check()
  updater.emit('download-progress', { percent: 46.2 })
  assert.match(controller.menuItems()[0].label, /46%/)
  assert.equal(calls.checks, 1)
  updater.emit('update-downloaded')
  assert.equal(calls.installs, 0)
  assert.equal(controller.menuItems()[1].visible, true)
  resolveDownload()
  await checking
  await controller.install()
  assert.equal(calls.installs, 1)
})

test('cancel or active transfers prevent restart; transfer state is checked after confirmation', async () => {
  for (const mode of ['cancel', 'busy', 'became-busy']) {
    let guards = 0
    const { calls, updater, controller } = fixture({
      canInstall: () => { guards++; return mode === 'cancel' || (mode === 'became-busy' && guards === 1) },
      dialog: { showMessageBox: async () => ({ response: mode === 'cancel' ? 1 : 0 }) },
    })
    await controller.check()
    updater.emit('update-downloaded')
    await controller.install()
    assert.equal(calls.installs, 0, mode)
    assert.equal(controller.getState(), 'downloaded')
  }
})

test('error event plus promise rejection produces one failure and allows retry', async () => {
  const { calls, updater, controller } = fixture()
  updater.checkForUpdates = async () => {
    calls.checks++
    const error = new Error('offline')
    updater.emit('error', error)
    throw error
  }
  await controller.check()
  assert.equal(calls.dialogs.length, 1)
  assert.equal(controller.menuItems()[0].enabled, true)
  await controller.check()
  assert.equal(calls.checks, 2)
  assert.equal(calls.dialogs.length, 2)
})

test('development and missing configuration do not touch updater', async () => {
  for (const options of [{ baseUrl: '' }, { app: { isPackaged: false } }]) {
    const { calls, controller } = fixture(options)
    await controller.check()
    assert.equal(calls.constructed, 0)
    assert.equal(calls.dialogs.length, 1)
  }
})

test('Mac only opens validated DMG after confirmation and never initializes Windows updater', async () => {
  for (const response of [0, 1]) {
    let requests = 0
    const { calls, controller } = fixture({
      platform: 'darwin', arch: 'arm64',
      fetchImpl: async () => { requests++; return new Response(JSON.stringify(mac)) },
      dialog: { showMessageBox: async () => ({ response }) },
    })
    assert.equal(requests, 0)
    await controller.check()
    assert.equal(requests, 1)
    assert.equal(calls.constructed, 0)
    assert.equal(calls.urls.length, response === 0 ? 1 : 0)
    if (response === 0) assert.match(decodeURI(calls.urls[0]), /student\/mac-arm64\/墨痕.*\.dmg$/)
    assert.equal(controller.menuItems()[1].visible, false)
    await controller.install()
    assert.equal(calls.installs, 0)
  }
})

test('Mac equal/older versions and unsupported architecture never open a download', async () => {
  for (const version of ['1.6.6', '1.6.5']) {
    const { calls, controller } = fixture({ platform: 'darwin', arch: 'arm64',
      fetchImpl: async () => new Response(JSON.stringify({ ...mac, version })) })
    await controller.check()
    assert.equal(calls.urls.length, 0)
    assert.match(calls.dialogs[0].message, /最新/)
  }
  let fetched = false
  const { controller } = fixture({ platform: 'darwin', arch: 'x64', fetchImpl: () => { fetched = true } })
  await controller.check()
  assert.equal(fetched, false)
})

test('Mac rejects wrong role, prereleases and unsafe files; versions use semantic comparison', () => {
  for (const change of [{ role: 'teacher' }, { arch: 'x64' }, { version: 'bad' },
    { version: '2.0.0-beta.1' }, ...['../a.dmg', 'https://evil/a.dmg', 'a\\b.dmg', '%2e%2e.dmg',
      'a.zip', 'a.dmg?x', 'a\n.dmg'].map((file) => ({ file }))]) {
    assert.throws(() => validateMacManifest({ ...mac, ...change }, directory, '1.6.6'))
  }
  assert.equal(validateMacManifest({ ...mac, version: '1.10.0' }, directory, '1.9.0').available, true)
})

test('real HTTP manifest request rejects redirects, malformed and oversized content', async (t) => {
  let mode = 'ok'
  const server = http.createServer((_req, res) => {
    if (mode === 'redirect') { res.writeHead(302, { Location: '/another' }); return res.end() }
    if (mode === '404') { res.writeHead(404); return res.end() }
    res.end(mode === 'ok' ? JSON.stringify(mac) : mode === 'large' ? ' '.repeat(70000) : '<html>bad</html>')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const root = `http://127.0.0.1:${server.address().port}/update/student/mac-arm64/`
  assert.equal((await fetchMacManifest(root, '1.6.6')).available, true)
  for (mode of ['redirect', '404', 'large', 'malformed']) {
    await assert.rejects(fetchMacManifest(root, '1.6.6'))
  }
})

test('build configuration isolates roles and disables Mac native updating', () => {
  for (const role of ['teacher', 'student']) {
    const config = makeBuildConfig(role, 'http://localhost:9000/update')
    assert.equal(config.extraMetadata.updateBaseUrl, 'http://localhost:9000/update/')
    assert.equal(config.win.publish.url, `http://localhost:9000/update/${role}/win-x64/`)
    assert.equal(config.extraMetadata.clientRole, role)
    if (role === 'student') assert.equal(config.mac.publish, null)
  }
  assert.equal(makeBuildConfig('student', '').win.publish, null)
  for (const value of ['file:///tmp/', 'http://user:pass@localhost/', 'http://localhost/?x=1']) {
    assert.throws(() => normalizeUpdateBase(value))
  }
})
