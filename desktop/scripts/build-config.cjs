const fs = require('node:fs')
const path = require('node:path')
const YAML = require('yaml')
const { normalizeUpdateBase, updateDirectory } = require('../src/update-policy.cjs')

function makeBuildConfig(role, baseUrl) {
  if (!['teacher', 'student'].includes(role)) throw new Error('Invalid client role')
  const base = normalizeUpdateBase(baseUrl)
  const config = YAML.parse(fs.readFileSync(path.join(__dirname, `../electron-builder.${role}.yml`), 'utf8'))
  config.extraMetadata = { ...config.extraMetadata, updateBaseUrl: base }
  config.win.publish = base ? { provider: 'generic', url: updateDirectory(base, role, 'win32', 'x64') } : null
  if (config.mac) config.mac.publish = null
  return config
}

function configuredBuild(role) {
  const saved = require('../update-config.json')
  const base = process.env.MOHEN_UPDATE_BASE_URL ?? saved.baseUrl
  if (!base) console.warn('未配置更新地址：本次安装包的检查更新功能将提示联系发布者。')
  return makeBuildConfig(role, base)
}

module.exports = { makeBuildConfig, configuredBuild }
