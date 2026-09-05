const semver = require('semver')

function normalizeUpdateBase(value) {
  if (!value || !String(value).trim()) return ''
  const url = new URL(String(value).trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('更新地址必须是无账号、查询参数和片段的 HTTP/HTTPS 目录地址')
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.href
}

function updateDirectory(base, role, platform, arch) {
  if (!['teacher', 'student'].includes(role)) throw new Error('客户端角色无效')
  const folder = platform === 'win32' && arch === 'x64' ? 'win-x64'
    : platform === 'darwin' && role === 'student' && arch === 'arm64' ? 'mac-arm64' : null
  if (!folder) throw new Error('当前系统或处理器暂未提供更新包')
  return new URL(`${role}/${folder}/`, normalizeUpdateBase(base)).href
}

function validateMacManifest(value, directory, currentVersion) {
  if (!value || value.role !== 'student' || value.platform !== 'darwin' || value.arch !== 'arm64') {
    throw new Error('更新清单与当前客户端不匹配')
  }
  if (typeof value.version !== 'string' || !semver.valid(value.version) || semver.prerelease(value.version)) {
    throw new Error('更新清单版本号无效')
  }
  if (!semver.valid(currentVersion)) throw new Error('当前客户端版本号无效')
  if (typeof value.file !== 'string' || value.file.length > 240 ||
      !/^[^/\\:%?#\x00-\x1f\x7f]+\.dmg$/.test(value.file) || value.file.includes('..')) {
    throw new Error('更新文件名无效')
  }
  if (value.notes !== undefined && (typeof value.notes !== 'string' || value.notes.length > 4000)) {
    throw new Error('更新说明无效')
  }
  const root = new URL(directory)
  const target = new URL(encodeURIComponent(value.file), root)
  if (target.origin !== root.origin || !target.pathname.startsWith(root.pathname)) {
    throw new Error('更新文件地址无效')
  }
  return { ...value, url: target.href, available: semver.gt(value.version, currentVersion) }
}

async function fetchMacManifest(directory, currentVersion, fetchImpl = fetch) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  let reader
  try {
    const response = await fetchImpl(new URL('latest.json', directory), {
      signal: controller.signal, redirect: 'error', cache: 'no-store',
    })
    if (!response.ok) throw new Error(`更新服务器返回 ${response.status}`)
    if (Number(response.headers.get('content-length')) > 65536 || !response.body) {
      throw new Error('更新清单大小无效')
    }
    reader = response.body.getReader()
    const chunks = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 65536) throw new Error('更新清单过大')
      chunks.push(Buffer.from(value))
    }
    return validateMacManifest(JSON.parse(Buffer.concat(chunks).toString('utf8')), directory, currentVersion)
  } finally {
    clearTimeout(timeout)
    await reader?.cancel().catch(() => {})
  }
}

module.exports = { normalizeUpdateBase, updateDirectory, validateMacManifest, fetchMacManifest }
