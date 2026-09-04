const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { Readable, Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const metadata = require('../package.json')

const clientRole = metadata.clientRole === 'student' ? 'student' : 'teacher'
const roleName = clientRole === 'teacher' ? '教师端' : '学生端'
const productName = `墨痕${roleName}`
const appId = clientRole === 'teacher' ? 'com.kexu.homework.teacher' : 'com.kexu.homework.student'

let mainWindow
let setupWindow
let handlingLoadFailure = false
const downloads = new Map()
const DOWNLOAD_RECORD_TTL_MS = 5000

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
  } catch {
    return {}
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
  fs.writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

function safePathSegment(value, fallback) {
  const cleaned = String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
  return cleaned || fallback
}

function uniquePath(parent, name, isDirectory = false) {
  const extension = isDirectory ? '' : path.extname(name)
  const stem = isDirectory ? name : path.basename(name, extension)
  let candidate = path.join(parent, name)
  let index = 2
  while (fs.existsSync(candidate)) {
    candidate = path.join(parent, `${stem} (${index})${extension}`)
    index += 1
  }
  return candidate
}

function sendDownloadProgress(webContents, payload) {
  if (!webContents.isDestroyed()) webContents.send('download:progress', payload)
}

function downloadView(record, message = record.message) {
  return {
    requestId: record.requestId,
    fileName: record.fileName,
    loaded: record.loaded,
    total: record.total,
    state: record.state,
    message: message || '',
  }
}

function publishDownload(record, message) {
  record.message = message || ''
  sendDownloadProgress(record.webContents, downloadView(record))
}

function clearDownloadCleanup(record) {
  if (!record.cleanupTimer) return
  clearTimeout(record.cleanupTimer)
  record.cleanupTimer = null
}

function removeDownloadRecord(record, removeTemporary = false) {
  clearDownloadCleanup(record)
  try {
    if (removeTemporary) fs.rmSync(record.temporaryPath, { force: true })
  } catch {
    // 临时文件若被杀毒软件短暂占用，不应阻止任务记录从界面和主进程释放。
  }
  if (downloads.get(record.requestId) === record) downloads.delete(record.requestId)
}

function scheduleDownloadCleanup(record, removeTemporary = false) {
  if (record.cleanupTimer) return
  record.cleanupTimer = setTimeout(() => {
    record.cleanupTimer = null
    removeDownloadRecord(record, removeTemporary)
  }, DOWNLOAD_RECORD_TTL_MS)
  record.cleanupTimer.unref?.()
}

function ownedDownload(event, requestId) {
  const record = downloads.get(String(requestId || ''))
  if (!record || record.webContentsId !== event.sender.id) throw new Error('下载任务不存在')
  return record
}

function readableBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)}MB`
  return `${Math.ceil(bytes / 1024)}KB`
}

function ensureDownloadSpace(record) {
  if (typeof fs.statfsSync !== 'function' || !record.total) return
  const remaining = Math.max(0, record.total - record.loaded)
  try {
    const stats = fs.statfsSync(path.dirname(record.targetPath), { bigint: true })
    const available = Number(stats.bavail * stats.bsize)
    if (remaining > available) {
      throw new Error(
        `磁盘空间不足：还需 ${readableBytes(remaining)}，当前可用 ${readableBytes(available)}`,
      )
    }
  } catch (error) {
    if (error.message.startsWith('磁盘空间不足')) throw error
    // Some network filesystems do not expose free-space statistics.
  }
}

async function transferFile(record) {
  clearDownloadCleanup(record)
  record.pauseRequested = false
  record.cancelRequested = false
  record.controller = new AbortController()
  record.loaded = fs.existsSync(record.temporaryPath) ? fs.statSync(record.temporaryPath).size : 0
  record.state = 'preparing'
  publishDownload(record, '服务器正在准备文件…')

  try {
    ensureDownloadSpace(record)
    const downloadUrl = new URL(record.endpoint, record.serverUrl)
    const headers = {
      Authorization: `Bearer ${record.token}`,
      'X-Download-Request-Id': record.requestId,
    }
    if (record.loaded > 0) {
      headers.Range = `bytes=${record.loaded}-`
      if (record.validator) headers['If-Range'] = record.validator
    }
    const response = await fetch(downloadUrl, { headers, signal: record.controller.signal })
    if (new URL(response.url).origin !== new URL(record.serverUrl).origin)
      throw new Error('下载地址不属于当前服务器')
    if (!response.ok || !response.body) {
      let message = `服务器返回 ${response.status}`
      try {
        message = JSON.parse(await response.text()).message || message
      } catch {}
      throw new Error(message)
    }
    record.state = 'downloading'
    publishDownload(record)

    if (record.loaded > 0 && response.status === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(
        response.headers.get('content-range') || '',
      )
      if (!range || Number(range[1]) !== record.loaded)
        throw new Error('服务器返回的断点位置不一致，请重试')
      if (range[3] !== '*') record.total = Number(range[3])
    } else {
      if (record.loaded > 0 || fs.existsSync(record.temporaryPath)) {
        fs.rmSync(record.temporaryPath, { force: true })
        record.loaded = 0
      }
      record.total = Number(response.headers.get('content-length')) || record.total
    }
    record.validator =
      response.headers.get('etag') || response.headers.get('last-modified') || record.validator
    ensureDownloadSpace(record)

    let lastProgressAt = 0
    const progress = new Transform({
      transform(chunk, _encoding, done) {
        record.loaded += chunk.length
        const now = Date.now()
        if (now - lastProgressAt >= 200 || (record.total && record.loaded >= record.total)) {
          lastProgressAt = now
          publishDownload(record)
        }
        done(null, chunk)
      },
    })
    await pipeline(
      Readable.fromWeb(response.body),
      progress,
      fs.createWriteStream(record.temporaryPath, {
        flags: fs.existsSync(record.temporaryPath) ? 'a' : 'wx',
      }),
    )
    if (record.total && record.loaded !== record.total) throw new Error('下载未完成，请重试')

    if (fs.existsSync(record.targetPath)) fs.rmSync(record.targetPath, { force: true })
    fs.renameSync(record.temporaryPath, record.targetPath)
    record.state = 'completed'
    publishDownload(record)
    scheduleDownloadCleanup(record)
    if (clientRole === 'student' && record.materialId) {
      fetch(new URL(`/api/materials/${record.materialId}/download-completed`, record.serverUrl), {
        method: 'POST',
        headers: { Authorization: `Bearer ${record.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ download_id: record.requestId }),
      }).catch(() => {})
    }
    return downloadView(record)
  } catch (error) {
    record.loaded = fs.existsSync(record.temporaryPath) ? fs.statSync(record.temporaryPath).size : 0
    if (record.cancelRequested) {
      record.state = 'cancelled'
      publishDownload(record, '下载已取消')
      scheduleDownloadCleanup(record, true)
      return downloadView(record, '下载已取消')
    }
    if (record.pauseRequested) {
      record.state = 'paused'
      publishDownload(record, '下载已暂停')
      return downloadView(record, '下载已暂停')
    }
    record.state = 'failed'
    publishDownload(record, error.message || '下载失败')
    scheduleDownloadCleanup(record, true)
    return downloadView(record, error.message || '下载失败')
  } finally {
    record.controller = null
  }
}

function allowedDownloadEndpoint(endpoint) {
  const parsed = new URL(endpoint, 'http://download.local')
  if (parsed.origin !== 'http://download.local') return false
  const pathWithQuery = `${parsed.pathname}${parsed.search}`
  if (/^\/api\/materials\/\d+\/file$/.test(pathWithQuery)) return true
  if (clientRole !== 'teacher') return false
  return (
    /^\/api\/(?:group-)?submissions\/\d+\/(?:file(?:\?history_id=\d+)?|package)$/.test(
      pathWithQuery,
    ) ||
    /^\/api\/(?:group-)?submissions\/\d+\/receipts\/[A-Za-z0-9_-]+\/file$/.test(pathWithQuery) ||
    /^\/api\/assignments\/\d+\/package$/.test(pathWithQuery)
  )
}

async function saveDownloadFile(event, payload) {
  const serverUrl = readSettings().serverUrl
  if (!serverUrl) throw new Error('尚未设置服务器地址')

  const requestId = String(payload?.requestId || '')
  const token = String(payload?.token || '')
  const endpoint = String(payload?.endpoint || '')
  if (!allowedDownloadEndpoint(endpoint)) throw new Error('下载地址无效')
  const materialMatch = /^\/api\/materials\/(\d+)\/file$/.exec(endpoint)
  const materialId = materialMatch ? Number(materialMatch[1]) : null
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) throw new Error('下载请求编号无效')
  if (!token) throw new Error('登录状态已失效，请重新登录')
  if (downloads.has(requestId)) throw new Error('该文件正在下载')

  const fileName = safePathSegment(payload?.fileName, '学习资料')
  const downloadFolder = app.getPath('downloads')
  fs.mkdirSync(downloadFolder, { recursive: true })
  const targetPath = uniquePath(downloadFolder, fileName)
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${requestId}.part`,
  )
  const webContents = event.sender
  fs.rmSync(temporaryPath, { force: true })
  const record = {
    requestId,
    endpoint,
    materialId,
    token,
    fileName,
    targetPath,
    temporaryPath,
    serverUrl,
    webContents,
    webContentsId: webContents.id,
    loaded: 0,
    total: Number(payload?.fileSize) || 0,
    state: 'starting',
    message: '',
    validator: '',
    controller: null,
    pauseRequested: false,
    cancelRequested: false,
    cleanupTimer: null,
  }
  downloads.set(requestId, record)
  return transferFile(record)
}

function pauseDownload(event, requestId) {
  const record = ownedDownload(event, requestId)
  if (record.state === 'downloading' && record.controller) {
    record.pauseRequested = true
    record.state = 'pausing'
    publishDownload(record, '正在暂停')
    record.controller.abort()
  }
  return downloadView(record)
}

async function resumeDownload(event, payload) {
  const record = ownedDownload(event, payload?.requestId)
  if (record.state !== 'paused') return downloadView(record)
  const token = String(payload?.token || '')
  if (!token) throw new Error('登录状态已失效，请重新登录')
  record.token = token
  return transferFile(record)
}

function cancelDownload(event, requestId) {
  const record = ownedDownload(event, requestId)
  record.cancelRequested = true
  if (record.controller) {
    record.state = 'cancelling'
    publishDownload(record, '正在取消')
    record.controller.abort()
  } else {
    record.state = 'cancelled'
    publishDownload(record, '下载已取消')
    scheduleDownloadCleanup(record, true)
  }
  return downloadView(record, record.state === 'cancelling' ? '正在取消' : '下载已取消')
}

function openDownloadFolder(event, requestId) {
  const record = ownedDownload(event, requestId)
  if (record.state !== 'completed' || !fs.existsSync(record.targetPath))
    throw new Error('下载文件不存在')
  shell.showItemInFolder(record.targetPath)
  return { opened: true }
}

async function openDownloadsFolder() {
  if (clientRole !== 'student') throw new Error('此功能仅供学生端使用')
  const downloadFolder = app.getPath('downloads')
  fs.mkdirSync(downloadFolder, { recursive: true })
  const error = await shell.openPath(downloadFolder)
  if (error) throw new Error(`无法打开下载文件夹：${error}`)
  return { opened: true }
}

function dismissDownload(event, requestId) {
  const record = ownedDownload(event, requestId)
  const removable = ['completed', 'failed', 'cancelled'].includes(record.state)
  if (removable) removeDownloadRecord(record, record.state !== 'completed')
  return { dismissed: removable }
}

function listDownloads(event) {
  return [...downloads.values()]
    .filter((record) => record.webContentsId === event.sender.id)
    .map((record) => downloadView(record))
}

function normalizeServerUrl(input) {
  let value = String(input || '').trim()
  if (!value) throw new Error('请输入服务器地址')
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`
  const parsed = new URL(value)
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new Error('服务器地址必须使用 http 或 https')
  if (parsed.username || parsed.password) throw new Error('服务器地址中不能包含账号或密码')
  parsed.hash = ''
  parsed.search = ''
  return parsed.href.replace(/\/$/, '')
}

async function testServer(input) {
  const serverUrl = normalizeServerUrl(input)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(`${serverUrl}/api/health`, {
      signal: controller.signal,
      headers: { 'User-Agent': `KexuDesktop/${app.getVersion()} (${clientRole})` },
    })
    if (!response.ok) throw new Error(`服务器返回 ${response.status}`)
    const result = await response.json()
    if (!result?.ok) throw new Error('服务器健康检查未通过')
    return { ok: true, serverUrl }
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('连接超时，请检查地址和网络')
    throw new Error(`无法连接服务器：${error.message}`)
  } finally {
    clearTimeout(timeout)
  }
}

function createMenu() {
  return Menu.buildFromTemplate([
    {
      label: '服务器',
      submenu: [
        { label: '重新加载', accelerator: 'F5', click: () => mainWindow?.reload() },
        { label: '设置服务器地址', click: () => openSetupWindow() },
        {
          label: '在浏览器中打开',
          click: () => {
            const serverUrl = readSettings().serverUrl
            if (serverUrl) shell.openExternal(serverUrl)
          },
        },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: `关于${productName}`,
          click: () =>
            dialog.showMessageBox({
              type: 'info',
              title: `关于${productName}`,
              message: productName,
              detail: `版本 ${app.getVersion()}\n页面与数据由您的 NAS Docker 服务提供。`,
            }),
        },
      ],
    },
  ])
}

function configureNavigation(window, serverUrl) {
  const allowedOrigin = new URL(serverUrl).origin
  const openExternalHttp = (url) => {
    try {
      const parsed = new URL(url)
      if (['http:', 'https:'].includes(parsed.protocol)) shell.openExternal(parsed.href)
    } catch {
      // 无效地址与系统协议均不交给操作系统处理。
    }
  }
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (new URL(url).origin === allowedOrigin) return { action: 'allow' }
    } catch {}
    openExternalHttp(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    let sameOrigin = false
    try {
      sameOrigin = new URL(url).origin === allowedOrigin
    } catch {}
    if (!sameOrigin) {
      event.preventDefault()
      openExternalHttp(url)
    }
  })
}

async function handleLoadFailure(serverUrl, errorDescription) {
  if (handlingLoadFailure || setupWindow) return
  handlingLoadFailure = true
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: '无法连接服务器',
    message: '墨痕暂时无法连接 NAS 服务',
    detail: `${serverUrl}\n\n${errorDescription || '请确认 NAS 和 Docker 容器正在运行。'}`,
    buttons: ['重试', '设置服务器地址', '退出'],
    defaultId: 0,
    cancelId: 2,
  })
  handlingLoadFailure = false
  if (result.response === 0) mainWindow?.loadURL(`${serverUrl}/?desktop=${clientRole}`)
  else if (result.response === 1) openSetupWindow()
  else app.quit()
}

function createMainWindow(serverUrl) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus()
    mainWindow.loadURL(`${serverUrl}/?desktop=${clientRole}`)
    return
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    title: productName,
    backgroundColor: '#f4f6f2',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })

  const currentAgent = mainWindow.webContents.getUserAgent()
  const roleAgent = clientRole === 'teacher' ? 'KexuTeacher' : 'KexuStudent'
  mainWindow.webContents.setUserAgent(`${currentAgent} ${roleAgent}/${app.getVersion()}`)
  configureNavigation(mainWindow, serverUrl)
  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) handleLoadFailure(serverUrl, errorDescription)
    },
  )
  mainWindow.on('closed', () => {
    mainWindow = undefined
  })
  mainWindow.loadURL(`${serverUrl}/?desktop=${clientRole}`)
}

function openSetupWindow() {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.focus()
    return
  }

  setupWindow = new BrowserWindow({
    width: 620,
    height: 570,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: `${productName}－服务器设置`,
    backgroundColor: '#f4f6f2',
    parent: mainWindow,
    modal: Boolean(mainWindow),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  setupWindow.removeMenu()
  setupWindow.loadFile(path.join(__dirname, 'setup.html'))
  setupWindow.on('closed', () => {
    setupWindow = undefined
  })
}

app.setAppUserModelId(appId)
app.whenReady().then(() => {
  Menu.setApplicationMenu(createMenu())

  ipcMain.handle('settings:get', () => ({
    role: clientRole,
    roleName,
    productName,
    version: app.getVersion(),
    serverUrl: readSettings().serverUrl || '',
  }))
  ipcMain.handle('server:test', (_event, serverUrl) => testServer(serverUrl))
  ipcMain.handle('server:save', async (_event, input) => {
    const result = await testServer(input)
    writeSettings({ serverUrl: result.serverUrl })
    setupWindow?.close()
    createMainWindow(result.serverUrl)
    return result
  })
  ipcMain.handle('download:save', (event, payload) => saveDownloadFile(event, payload))
  ipcMain.handle('download:pause', pauseDownload)
  ipcMain.handle('download:resume', resumeDownload)
  ipcMain.handle('download:cancel', cancelDownload)
  ipcMain.handle('download:open-folder', openDownloadFolder)
  ipcMain.handle('download:open-downloads-folder', openDownloadsFolder)
  ipcMain.handle('download:dismiss', dismissDownload)
  ipcMain.handle('download:list', listDownloads)

  const serverUrl = readSettings().serverUrl
  if (serverUrl) createMainWindow(serverUrl)
  else openSetupWindow()

  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) {
      const savedUrl = readSettings().serverUrl
      if (savedUrl) createMainWindow(savedUrl)
      else openSetupWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
