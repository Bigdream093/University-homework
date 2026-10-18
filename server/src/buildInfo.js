import fs from 'node:fs'

const packageUrl = [
  new URL('../../package.json', import.meta.url),
  new URL('../source-package.json', import.meta.url),
].find((url) => fs.existsSync(url))
if (!packageUrl) throw new Error('缺少项目版本信息')
const { version } = JSON.parse(fs.readFileSync(packageUrl, 'utf8'))
const metadataUrl = new URL('../build-info.json', import.meta.url)
const metadata = fs.existsSync(metadataUrl)
  ? JSON.parse(fs.readFileSync(metadataUrl, 'utf8'))
  : null
if (metadata && (metadata.version !== version || !/^[a-f0-9]{64}$/.test(metadata.source_sha256)))
  throw new Error('构建记录与项目版本不一致，请重新构建')
export const buildInfo = {
  version,
  source_sha256: metadata?.source_sha256 || null,
  built_at: metadata?.built_at || null,
}
