import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { crc32 } from 'node:zlib'
import express from 'express'
import sharp from 'sharp'
import request from 'supertest'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mohen-preview-parity-'))
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATA_DIR: path.join(directory, 'data'),
  UPLOAD_DIR: path.join(directory, 'uploads'),
  JWT_SECRET: 'preview-parity-only',
})
const { uploadSubmissionFiles } = await import('../src/middleware/upload.js')
const { preparePreview } = await import('../src/services/previewService.js')
const { buildThumbnail } = await import('../src/utils/imageValidate.js')
const { db } = await import('../src/db.js')
after(() => {
  db.close()
  fs.rmSync(directory, { recursive: true, force: true })
})
const app = express()
app.post('/direct', uploadSubmissionFiles, (req, res) => res.json(req.stagedPreviews[0]))
app.use((error, _req, res, _next) =>
  res.status(error.status || 500).json({ message: error.message }),
)
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

test('multipart 对源文件与预览图分别执行大小限制', async () => {
  const limited = express()
  limited.post(
    '/upload',
    (req, _res, next) => {
      req.uploadLimit = 100
      next()
    },
    uploadSubmissionFiles,
    (req, res) =>
      res.json({
        sourceSize: req.stagedSource.size,
        previewSize: req.stagedPreviews[0].size,
      }),
  )
  limited.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ message: error.message }),
  )
  const image = await sharp({
    create: { width: 720, height: 300, channels: 3, background: 'white' },
  })
    .png()
    .toBuffer()
  assert.ok(image.length > 100)
  const accepted = await request(limited)
    .post('/upload')
    .attach('file', Buffer.alloc(100), 'answer.zip')
    .attach('previews', image, 'preview.png')
    .expect(200)
  assert.equal(accepted.body.sourceSize, 100)
  assert.equal(accepted.body.previewSize, image.length)
  const rejected = await request(limited)
    .post('/upload')
    .attach('file', Buffer.alloc(101), 'too-large.zip')
    .expect(400)
  assert.match(rejected.body.message, /文件限制单文件不超过/)
})

for (const format of ['png', 'jpeg']) {
  test(`${format}: direct and chunk preparation preserve image metadata, hashes and thumbnails`, async () => {
    const bytes = await sharp({
      create: { width: 720, height: 300, channels: 3, background: '#c8a080' },
    })
      .toFormat(format)
      .toBuffer()
    const input = path.join(directory, `input.${format}`)
    fs.writeFileSync(input, bytes)
    const direct = await request(app)
      .post('/direct')
      .attach('previews', bytes, `preview.${format}`)
      .expect(200)
    const chunked = await preparePreview({
      path: input,
      originalname: `preview.${format}`,
      size: bytes.length,
    })
    assert.deepEqual(direct.body.image, chunked.image)
    assert.equal(direct.body.sha256, digest(bytes))
    assert.equal(chunked.sha256, digest(bytes))
    const thumbnail = await sharp(chunked.thumbnailPath).metadata()
    assert.equal(thumbnail.format, 'jpeg')
    assert.equal(thumbnail.width, 480)
    assert.equal(thumbnail.height, 200)
    assert.deepEqual(
      fs.readFileSync(direct.body.thumbnailPath),
      fs.readFileSync(chunked.thumbnailPath),
    )
  })
}

test('both entry points reject disguised formats and oversized dimensions identically', async () => {
  const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'white' } })
    .png()
    .toBuffer()
  const oversized = Buffer.from(png)
  oversized.writeUInt32BE(60000, 16)
  oversized.writeUInt32BE(60000, 20)
  oversized.writeUInt32BE(crc32(oversized.subarray(12, 29)), 29)
  const gif = await sharp(png).gif().toBuffer()
  for (const [index, bytes] of [Buffer.from('not an image'), gif, oversized].entries()) {
    const input = path.join(directory, `invalid-${index}.png`)
    fs.writeFileSync(input, bytes)
    const direct = await request(app)
      .post('/direct')
      .attach('previews', bytes, 'preview.png')
      .expect(400)
    await assert.rejects(preparePreview({ path: input }), (error) => {
      assert.equal(error.status, 400)
      assert.equal(error.message, direct.body.message)
      return true
    })
  }
})

test('thumbnail fallback removes a partial destination and keeps original bytes', async () => {
  const source = path.join(directory, 'corrupt.png'),
    destination = path.join(directory, 'partial.jpg')
  fs.writeFileSync(source, 'corrupt-image')
  fs.writeFileSync(destination, 'partial-output')
  assert.equal(await buildThumbnail(source, destination), null)
  assert.equal(fs.existsSync(destination), false)
  assert.equal(fs.readFileSync(source, 'utf8'), 'corrupt-image')
})
