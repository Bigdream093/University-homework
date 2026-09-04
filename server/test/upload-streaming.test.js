import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import request from 'supertest'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mohen-streaming-upload-'))
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'streaming-upload-test'
process.env.DATA_DIR = path.join(dir, 'data')
process.env.UPLOAD_DIR = path.join(dir, 'uploads')
const { uploadSingle } = await import('../src/middleware/upload.js')
const { fingerprint } = await import('../src/services/operations.js')
const { config } = await import('../src/config.js')
const { configureHttpServer } = await import('../src/index.js')
const { db } = await import('../src/db.js')
after(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('upload hashes bytes while streaming to disk and fingerprint reuses that digest', async () => {
  const app = express()
  app.post(
    '/upload',
    (req, _res, next) => {
      req.uploadLimit = 1024 * 1024
      next()
    },
    uploadSingle,
    (req, res) => res.json(req.file),
  )
  const bytes = Buffer.from('streamed upload content')
  const expected = createHash('sha256').update(bytes).digest('hex')
  const uploaded = await request(app)
    .post('/upload')
    .attach('file', bytes, { filename: 'answer.zip' })
  assert.equal(uploaded.status, 200, uploaded.text)
  assert.equal(uploaded.body.sha256, expected)
  assert.equal(fs.readFileSync(uploaded.body.path, 'utf8'), bytes.toString())
  const operationHash = await fingerprint(
    { content: 'answer' },
    { ...uploaded.body, path: path.join(dir, 'file-must-not-be-read') },
  )
  assert.match(operationHash, /^[a-f0-9]{64}$/)
})

test('slow upload timeout defaults to two hours and is applied to the HTTP server', () => {
  assert.equal(config.uploadRequestTimeoutMs, 7_200_000)
  const server = { requestTimeout: 300_000 }
  assert.equal(configureHttpServer(server), server)
  assert.equal(server.requestTimeout, 7_200_000)
})
