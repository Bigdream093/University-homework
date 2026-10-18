const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { buildInfo } = require('./build-info.cjs')
const kinds = ['server', 'teacher-win', 'student-win', 'student-mac']

function fileHash(file) {
  const hash = createHash('sha256'),
    buffer = Buffer.alloc(1024 * 1024),
    fd = fs.openSync(file, 'r')
  try {
    let bytes
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, bytes))
    return hash.digest('hex')
  } finally {
    fs.closeSync(fd)
  }
}

function artifacts(directory) {
  const result = []
  function walk(relative = '') {
    for (const name of fs.readdirSync(path.join(directory, relative)).sort()) {
      const key = path.posix.join(relative, name),
        full = path.join(directory, key)
      if (['release-manifest.json', 'SHA256SUMS.txt'].includes(key)) continue
      if (
        (/^\.env(?:\.|$)/i.test(name) && name !== '.env.example') ||
        /\.(?:sqlite|sqlite3|db)(?:-wal|-shm)?$/i.test(name) ||
        ['data', 'uploads', 'backups', 'node_modules'].includes(name)
      )
        throw new Error(`发布目录包含私有数据或运行文件：${key}`)
      const stat = fs.lstatSync(full)
      if (stat.isSymbolicLink()) throw new Error(`发布目录不能包含符号链接：${key}`)
      if (stat.isDirectory()) walk(key)
      else if (stat.isFile()) result.push({ path: key, bytes: stat.size, sha256: fileHash(full) })
    }
  }
  walk()
  return result
}
function components(files, serviceVersion, desktopVersion) {
  const names = files.filter((file) => file.bytes > 0).map((file) => file.path)
  const found = {
    server: names.some(
      (name) =>
        path.posix.basename(name) === `university-homework-${serviceVersion}-linux-amd64.tar`,
    ),
    'teacher-win': names.some(
      (name) => path.posix.basename(name) === `墨痕教师端-Setup-${desktopVersion}.exe`,
    ),
    'student-win': names.some(
      (name) => path.posix.basename(name) === `墨痕学生端-Setup-${desktopVersion}.exe`,
    ),
    'student-mac': names.some(
      (name) => path.posix.basename(name) === `墨痕学生端-macOS-arm64-${desktopVersion}.dmg`,
    ),
  }
  return Object.fromEntries(
    kinds.map((kind) => [
      kind,
      {
        version: kind === 'server' ? serviceVersion : desktopVersion,
        status: found[kind] ? 'included' : 'not-built',
      },
    ]),
  )
}
function createManifest(directory, targets = ['server'], root = path.resolve(__dirname, '..')) {
  if (!targets.length || targets.some((kind) => !kinds.includes(kind)))
    throw new Error('发布目标无效')
  const info = buildInfo(root),
    desktop = buildInfo(root, 'desktop')
  const files = artifacts(directory),
    items = components(files, info.version, desktop.version)
  for (const target of targets)
    if (items[target].status !== 'included') throw new Error(`缺少发布目标：${target}`)
  const manifest = {
    schema: 1,
    source: info,
    desktop,
    delivery:
      targets.length === 1 && targets[0] === 'server' ? 'server-only' : 'selected-components',
    targets,
    components: items,
    compatibility: { status: 'not-verified', evidence: [] },
    validation: { nas: 'pending', installed_desktop_upgrade: 'pending' },
    files,
  }
  fs.writeFileSync(
    path.join(directory, 'release-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  )
  fs.writeFileSync(
    path.join(directory, 'SHA256SUMS.txt'),
    files.map((file) => `${file.sha256}  ${file.path}`).join('\n') + '\n',
  )
  return manifest
}
function verifyManifest(directory) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(directory, 'release-manifest.json'), 'utf8'),
  )
  if (
    manifest.schema !== 1 ||
    !Array.isArray(manifest.files) ||
    !/^[a-f0-9]{64}$/.test(manifest.source?.source_sha256 || '')
  )
    throw new Error('发布清单格式无效')
  const actual = artifacts(directory)
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files))
    throw new Error('发布文件缺失、被修改或出现未记录文件')
  const items = components(actual, manifest.source.version, manifest.desktop?.version)
  if (
    JSON.stringify(items) !== JSON.stringify(manifest.components) ||
    !manifest.targets?.length ||
    manifest.targets.some((kind) => !kinds.includes(kind) || items[kind].status !== 'included')
  )
    throw new Error('发布组件与目标不匹配')
  const sums = actual.map((file) => `${file.sha256}  ${file.path}`).join('\n') + '\n'
  if (fs.readFileSync(path.join(directory, 'SHA256SUMS.txt'), 'utf8') !== sums)
    throw new Error('SHA256SUMS.txt 与清单不一致')
  return manifest
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2),
      directory = args[0]
    if (!directory)
      throw new Error(
        '用法：npm run release:manifest -- <发布目录> [--check] [--targets=server,teacher-win,student-win]',
      )
    const selected = args
      .find((value) => value.startsWith('--targets='))
      ?.slice(10)
      .split(',')
    const manifest = args.includes('--check')
      ? verifyManifest(path.resolve(directory))
      : createManifest(path.resolve(directory), selected)
    console.log(
      `发布清单${args.includes('--check') ? '校验通过' : '已生成'}：${manifest.source.version}（${manifest.delivery}）`,
    )
    console.log('文件清单校验不代表 NAS 或已安装桌面升级验收完成。')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
module.exports = { createManifest, verifyManifest }
