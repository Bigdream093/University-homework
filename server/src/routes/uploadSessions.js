import { Router } from 'express'
import { auth } from '../middleware/auth.js'
import {
  cancelUploadSession,
  completeUploadSession,
  createUploadSession,
  getUploadSession,
  writeChunk,
} from '../services/uploadSessionService.js'
import { httpError } from '../utils/httpError.js'

const router = Router()
router.post('/upload-sessions', auth, (req, res) =>
  res.status(201).json(createUploadSession(req.body, req.user)),
)
router.get('/upload-sessions/:id', auth, (req, res) =>
  res.json(getUploadSession(req.params.id, req.user)),
)
router.put('/upload-sessions/:id/files/:fileId/chunk', auth, async (req, res) => {
  if (
    !String(req.get('Content-Type') || '')
      .toLowerCase()
      .startsWith('application/octet-stream')
  )
    throw httpError(415, '分片必须使用 application/octet-stream')
  const result = await writeChunk({
    sessionId: req.params.id,
    fileId: req.params.fileId,
    user: req.user,
    range: req.get('Content-Range'),
    chunkHash: req.get('X-Chunk-SHA256'),
    stream: req,
  })
  res.json(result)
})
router.post('/upload-sessions/:id/complete', auth, async (req, res) => {
  res.json(await completeUploadSession(req.params.id, req.user, req.body?.metadata))
})
router.delete('/upload-sessions/:id', auth, (req, res) =>
  res.json(cancelUploadSession(req.params.id, req.user)),
)
export default router
