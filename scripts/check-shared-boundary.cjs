const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
// Tests may exercise server-only code; this guard protects the browser runtime bundle.
const frontendRoots = ['web/src']
const forbiddenImport =
  /\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)['"]([^'"]*server\/src\/[^'"]*)['"]/g
const violations = []

function checkFile(file) {
  const source = fs.readFileSync(file, 'utf8').replaceAll('\\', '/')
  for (const match of source.matchAll(forbiddenImport)) {
    const line = source.slice(0, match.index).split('\n').length
    violations.push(`${path.relative(root, file)}:${line}: ${match[1]}`)
  }
}

function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) visit(file)
    else if (/\.(?:[cm]?js|vue|ts|tsx)$/.test(entry.name)) checkFile(file)
  }
}

for (const directory of frontendRoots) visit(path.join(root, directory))

if (violations.length) {
  console.error('前端运行时代码不能直接依赖 server/src：')
  for (const violation of violations) console.error(`  ${violation}`)
  process.exitCode = 1
} else {
  console.log('前端共享边界检查通过。')
}
