import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mohen-browser-'))
const child = spawn(process.execPath, ['server/src/index.js'], {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'production', TZ: 'Asia/Shanghai', PORT: '39061',
    JWT_SECRET: 'browser-tests-isolated-only-secret-123456789',
    DATA_DIR: directory, UPLOAD_DIR: path.join(directory, 'uploads') },
})
const stop = () => child.kill('SIGTERM')
process.once('SIGTERM', stop)
process.once('SIGINT', stop)
child.once('exit', code => {
  fs.rmSync(directory, { recursive: true, force: true })
  process.exit(code || 0)
})
