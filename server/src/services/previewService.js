import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { config } from '../config.js'
import { validatePreviewImage, buildThumbnail } from '../utils/imageValidate.js'
import { toStorageKey } from '../utils/uploadPath.js'

export async function preparePreview(file) {
  const image = await validatePreviewImage(file.path)
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file.path)) hash.update(chunk)
  const directory = path.join(config.uploadDir, 'previews')
  await fs.promises.mkdir(directory, { recursive: true })
  const thumbnailPath = path.join(directory, `${randomUUID()}.jpg`)
  if (!(await buildThumbnail(file.path, thumbnailPath))) {
    return { ...file, image, sha256: hash.digest('hex') }
  }
  return {
    ...file,
    image,
    sha256: hash.digest('hex'),
    thumbnailPath,
    thumbnailKey: toStorageKey(thumbnailPath),
  }
}
