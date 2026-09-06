const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const assert = require('node:assert/strict')
const YAML = require('../../desktop/node_modules/yaml')

const root = path.resolve(__dirname, '../..')
const release = path.join(root, 'release/1.6.6')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mohen-nas-test-'))
const project = `mohen-update-test-${Date.now()}`
const file = path.join(temp, 'compose.yml')
const passed = []
function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
function compose(...args) { return docker(['compose', '-p', project, '-f', file, ...args]) }

async function main() {
  const config = YAML.parse(fs.readFileSync(path.join(release, 'docker-compose.yml'), 'utf8'))
  for (const service of Object.values(config.services)) delete service.container_name
  const backend = config.services['university-homework']
  backend.environment.JWT_SECRET = crypto.randomBytes(48).toString('hex')
  for (const [index, name] of ['data', 'uploads'].entries()) {
    const folder = path.join(temp, name)
    fs.mkdirSync(folder)
    backend.volumes[index].source = folder
  }
  config.services.nginx.ports = ['127.0.0.1::80']
  config.services.nginx.volumes[0].source = path.join(release, 'nginx.conf')
  config.services.nginx.volumes[1].source = path.join(release, 'update')
  fs.writeFileSync(file, YAML.stringify(config))
  try {
    console.log('Starting isolated NAS deployment with temporary data...')
    compose('up', '-d', '--wait', '--wait-timeout', '90')
    compose('exec', '-T', 'nginx', 'nginx', '-t')
    passed.push('compose_start_and_nginx_config')
    const origin = `http://${compose('port', 'nginx', '80')}`
    let r = await fetch(`${origin}/api/health`)
    const health = await r.json()
    assert.equal(health.ok, true)
    assert.equal(health.version, '1.6.6')
    passed.push('backend_health_1.6.6')
    r = await fetch(`${origin}/login`)
    assert.equal(r.status, 200)
    assert.ok(r.headers.get('content-security-policy'))
    assert.match(await r.text(), /墨痕/)
    passed.push('business_page_and_CSP_proxied')
    for (const role of ['teacher', 'student']) {
      r = await fetch(`${origin}/update/${role}/win-x64/latest.yml`)
      assert.equal(r.status, 200)
      assert.equal(r.headers.get('cache-control'), 'no-store')
      const info = YAML.parse(await r.text())
      assert.equal(info.version, '1.6.6')
      const artifact = info.files[0]
      const url = `${origin}/update/${role}/win-x64/${encodeURIComponent(artifact.url)}`
      r = await fetch(url, { headers: { Range: 'bytes=0-31' } })
      assert.equal(r.status, 206)
      assert.equal(r.headers.get('content-range'), `bytes 0-31/${artifact.size}`)
      assert.equal((await r.arrayBuffer()).byteLength, 32)
      r = await fetch(url)
      assert.equal(r.status, 200)
      const hash = crypto.createHash('sha512')
      for await (const chunk of r.body) hash.update(chunk)
      assert.equal(hash.digest('base64'), artifact.sha512)
      passed.push(`${role}_manifest_range_and_complete_download_hash`)
    }
    r = await fetch(`${origin}/update/student/mac-arm64/latest.json`)
    const mac = await r.json()
    assert.equal(mac.version, '1.6.5')
    assert.ok(mac.file.endsWith('-1.6.5.dmg'))
    r = await fetch(`${origin}/update/student/mac-arm64/${encodeURIComponent(mac.file)}`, { method: 'HEAD' })
    assert.equal(r.status, 200)
    passed.push('original_mac_dmg_available_without_false_version')
    assert.equal((await fetch(`${origin}/update/not-existing.yml`)).status, 404)
    assert.equal((await fetch(`${origin}/update/`)).status, 403)
    assert.equal((await fetch(`${origin}/update/not-allowed.txt`, { method: 'PUT', body: 'test' })).status, 403)
    passed.push('missing_404_directory_listing_and_writes_denied')
    fs.writeFileSync(path.join(release, 'DEPLOYMENT-VALIDATION.json'), JSON.stringify({
      testedAt: new Date().toISOString(), environment: 'isolated local Docker linux/amd64',
      nasModified: false, productionDataUsed: false, passed,
      notTested: ['NAS live deployment', 'Windows installed A-to-B upgrade', 'Mac 1.6.6 build and real-device install', '10GB concurrent upload'],
    }, null, 2) + '\n')
    console.log(`Passed ${passed.length} deployment checks.`)
  } finally {
    compose('down')
    // Only the exact mkdtemp directory owned by this test is removed.
    if (!temp.startsWith(path.join(os.tmpdir(), 'mohen-nas-test-'))) throw new Error('Unsafe cleanup path')
    fs.rmSync(temp, { recursive: true, force: true })
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1 })
