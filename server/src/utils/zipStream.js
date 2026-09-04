import fs from 'node:fs'
import archiver from 'archiver'
import { pipeline } from 'node:stream/promises'
import { safeName } from './fileFilter.js'

function appendEntries(archive, entries) {
  for (const entry of entries) {
    const name = String(entry.name || 'file')
      .split('/')
      .filter((part) => part && part !== '.' && part !== '..')
      .map(safeName)
      .join('/')
    if (entry.content !== undefined && entry.content !== null)
      archive.append(Buffer.from(String(entry.content), 'utf8'), { name })
    else archive.file(entry.path, { name, stats: fs.statSync(entry.path) })
  }
}

// ZIP64 is selected automatically for archives exceeding 4GiB.
// STORE avoids recompressing videos and compressed student attachments.
export async function pipeZipToResponse(entries, response) {
  const archive = archiver('zip', { store: true })
  archive.on('warning', (error) => archive.emit('error', error))
  response.once('close', () => {
    if (!response.writableFinished) archive.abort()
  })
  const completion = pipeline(archive, response)
  // Attach a rejection handler immediately, including while queuing files.
  completion.catch(() => {})
  try {
    appendEntries(archive, entries)
    await Promise.all([archive.finalize(), completion])
  } catch (error) {
    archive.abort()
    if (!response.destroyed) response.destroy()
    if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error('作业打包失败', error.message)
  }
}

export async function writeZipFile(entries, target) {
  const archive = archiver('zip', { store: true })
  archive.on('warning', (error) => archive.emit('error', error))
  const output = fs.createWriteStream(target, { flags: 'wx' }),
    completion = pipeline(archive, output)
  completion.catch(() => {})
  try {
    appendEntries(archive, entries)
    await Promise.all([archive.finalize(), completion])
  } catch (error) {
    archive.abort()
    fs.rmSync(target, { force: true })
    throw error
  }
}
