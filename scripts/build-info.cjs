const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

function buildInfo(root = path.resolve(__dirname, '..'), scope = 'service') {
  const version = JSON.parse(
    fs.readFileSync(
      path.join(root, scope === 'desktop' ? 'desktop/package.json' : 'package.json'),
      'utf8',
    ),
  ).version
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version))
    throw new Error('项目版本号无效')
  const files = []
  function collect(relative) {
    const full = path.join(root, relative)
    if (!fs.existsSync(full)) return
    const stat = fs.lstatSync(full)
    if (stat.isSymbolicLink()) throw new Error(`源码不能包含符号链接：${relative}`)
    if (stat.isDirectory())
      for (const item of fs.readdirSync(full).sort()) collect(path.posix.join(relative, item))
    else if (stat.isFile()) files.push(relative)
  }
  const inputs =
    scope === 'desktop'
      ? [
          'desktop/package.json',
          'desktop/package-lock.json',
          'desktop/src',
          'desktop/scripts',
          'desktop/update-config.json',
          'desktop/electron-builder.teacher.cjs',
          'desktop/electron-builder.teacher.yml',
          'desktop/electron-builder.student.cjs',
          'desktop/electron-builder.student.yml',
          'desktop/build',
        ]
      : [
          'package.json',
          'package-lock.json',
          'server/package.json',
          'web/package.json',
          'web/vite.config.js',
          'web/index.html',
          'web/public',
          'Dockerfile',
          'scripts/build-info.cjs',
          'server/src',
          'server/help',
          'web/src',
          'packages/domain',
        ]
  for (const item of inputs) collect(item)
  const hash = createHash('sha256')
  for (const relative of files.sort()) {
    const bytes = fs.readFileSync(path.join(root, relative))
    hash
      .update(JSON.stringify([relative, bytes.length]))
      .update('\0')
      .update(bytes)
  }
  return {
    version,
    scope,
    source_sha256: hash.digest('hex'),
    source_files: files.length,
    built_at: new Date().toISOString(),
  }
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..'),
    info = buildInfo(root)
  fs.writeFileSync(path.join(root, 'server/build-info.json'), JSON.stringify(info, null, 2) + '\n')
  console.log(`构建记录：${info.version} ${info.source_sha256}`)
}
module.exports = { buildInfo }
