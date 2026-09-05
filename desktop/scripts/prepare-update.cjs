const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const YAML = require('yaml')
const { validateMacManifest } = require('../src/update-policy.cjs')

async function fileHash(file) {
  const hash = crypto.createHash('sha512')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('base64')
}

async function prepareUpdate(role, platform, desktop = path.resolve(__dirname, '..')) {
  if (!['teacher', 'student'].includes(role) || !['win32', 'darwin'].includes(platform) ||
      (platform === 'darwin' && role !== 'student')) throw new Error('不支持的角色或平台')
  const { version } = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'))
  const source = path.join(desktop, 'release', role)
  const files = []
  let manifest, manifestName
  if (platform === 'win32') {
    manifestName = 'latest.yml'
    const text = fs.readFileSync(path.join(source, manifestName), 'utf8')
    const parsed = YAML.parse(text)
    if (parsed.version !== version || !Array.isArray(parsed.files) || !parsed.files.length) {
      throw new Error('Windows 清单版本与当前源码不一致或缺少文件')
    }
    const prefix = role === 'teacher' ? '墨痕教师端-Setup-' : '墨痕学生端-Setup-'
    for (const entry of parsed.files) {
      const file = decodeURIComponent(entry.url)
      if (file !== `${prefix}${version}.exe`) throw new Error('安装包角色、版本或路径不匹配')
      const full = path.join(source, file)
      if (fs.statSync(full).size !== entry.size || await fileHash(full) !== entry.sha512) {
        throw new Error(`安装包大小或哈希不匹配：${file}`)
      }
      if (!fs.existsSync(`${full}.blockmap`)) throw new Error(`缺少 blockmap：${file}`)
      files.push(file, `${file}.blockmap`)
    }
    manifest = text
  } else {
    manifestName = 'latest.json'
    const file = `墨痕学生端-macOS-arm64-${version}.dmg`
    if (fs.statSync(path.join(source, file)).size === 0) throw new Error('DMG 文件为空')
    const info = { version, role, platform, arch: 'arm64', file, notes: '' }
    validateMacManifest(info, 'http://validation.invalid/update/student/mac-arm64/', version)
    files.push(file)
    manifest = `${JSON.stringify(info, null, 2)}\n`
  }
  // New staging folder per run: never overwrite a previously prepared release.
  const staging = path.join(desktop, 'release', 'update-staging')
  fs.mkdirSync(staging, { recursive: true })
  const root = fs.mkdtempSync(path.join(staging, `${version}-`))
  const output = path.join(root, role, platform === 'win32' ? 'win-x64' : 'mac-arm64')
  fs.mkdirSync(output, { recursive: true })
  for (const file of files) fs.copyFileSync(path.join(source, file), path.join(output, file))
  fs.writeFileSync(path.join(output, manifestName), manifest)
  return output
}

if (require.main === module) {
  prepareUpdate(process.argv[2], process.argv[3]).then((output) => {
    console.log(`更新文件已整理：${output}\n请先上传安装文件，最后原子替换版本清单。`)
  }).catch((error) => { console.error(error.message); process.exitCode = 1 })
}
module.exports = { prepareUpdate }
