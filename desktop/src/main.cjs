const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const metadata = require('../package.json');

const clientRole = metadata.clientRole === 'student' ? 'student' : 'teacher';
const roleName = clientRole === 'teacher' ? '教师端' : '学生端';
const productName = `墨痕${roleName}`;
const appId = clientRole === 'teacher' ? 'com.kexu.homework.teacher' : 'com.kexu.homework.student';

let mainWindow;
let setupWindow;
let handlingLoadFailure = false;

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function safePathSegment(value, fallback) {
  const cleaned = String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  return cleaned || fallback;
}

function uniquePath(parent, name, isDirectory = false) {
  const extension = isDirectory ? '' : path.extname(name);
  const stem = isDirectory ? name : path.basename(name, extension);
  let candidate = path.join(parent, name);
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(parent, `${stem} (${index})${extension}`);
    index += 1;
  }
  return candidate;
}

async function saveAssignmentFiles(payload) {
  if (clientRole !== 'teacher') throw new Error('只有教师端可以批量保存作业');
  const serverUrl = readSettings().serverUrl;
  if (!serverUrl) throw new Error('尚未设置服务器地址');

  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  if (!entries.length) throw new Error('没有可以保存的学生作业');

  const assignmentName = safePathSegment(payload.assignmentTitle, '学生作业');
  const desktopPath = app.getPath('desktop');
  const folderPath = uniquePath(desktopPath, assignmentName, true);
  fs.mkdirSync(folderPath, { recursive: false });

  const allowedOrigin = new URL(serverUrl).origin;
  const token = String(payload.token || '');
  const failed = [];
  let saved = 0;

  for (const [index, entry] of entries.entries()) {
    const fileName = safePathSegment(entry.fileName, `学生作业_${index + 1}.txt`);
    const targetPath = uniquePath(folderPath, fileName);
    try {
      if (entry.url) {
        const downloadUrl = new URL(entry.url, serverUrl);
        if (downloadUrl.origin !== allowedOrigin) throw new Error('下载地址不属于当前服务器');
        const response = await fetch(downloadUrl, {
          headers: token ? { Authorization: `Bearer ${token}` } : {}
        });
        if (!response.ok) throw new Error(`服务器返回 ${response.status}`);
        fs.writeFileSync(targetPath, Buffer.from(await response.arrayBuffer()));
      } else {
        fs.writeFileSync(targetPath, String(entry.content || ''), 'utf8');
      }
      saved += 1;
    } catch (error) {
      failed.push({ fileName, message: error.message });
    }
  }

  if (saved > 0) await shell.openPath(folderPath);
  return { folderPath, saved, failed };
}

function normalizeServerUrl(input) {
  let value = String(input || '').trim();
  if (!value) throw new Error('请输入服务器地址');
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('服务器地址必须使用 http 或 https');
  if (parsed.username || parsed.password) throw new Error('服务器地址中不能包含账号或密码');
  parsed.hash = '';
  parsed.search = '';
  return parsed.href.replace(/\/$/, '');
}

async function testServer(input) {
  const serverUrl = normalizeServerUrl(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${serverUrl}/api/health`, {
      signal: controller.signal,
      headers: { 'User-Agent': `KexuDesktop/${app.getVersion()} (${clientRole})` }
    });
    if (!response.ok) throw new Error(`服务器返回 ${response.status}`);
    const result = await response.json();
    if (!result?.ok) throw new Error('服务器健康检查未通过');
    return { ok: true, serverUrl };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('连接超时，请检查地址和网络');
    throw new Error(`无法连接服务器：${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

function createMenu() {
  return Menu.buildFromTemplate([
    {
      label: '服务器',
      submenu: [
        { label: '重新加载', accelerator: 'F5', click: () => mainWindow?.reload() },
        { label: '设置服务器地址', click: () => openSetupWindow() },
        { label: '在浏览器中打开', click: () => {
          const serverUrl = readSettings().serverUrl;
          if (serverUrl) shell.openExternal(serverUrl);
        } },
        { type: 'separator' },
        { label: '退出', role: 'quit' }
      ]
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
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        { label: `关于${productName}`, click: () => dialog.showMessageBox({
          type: 'info', title: `关于${productName}`, message: productName,
          detail: `版本 ${app.getVersion()}\n页面与数据由您的 NAS Docker 服务提供。`
        }) }
      ]
    }
  ]);
}

function configureNavigation(window, serverUrl) {
  const allowedOrigin = new URL(serverUrl).origin;
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).origin === allowedOrigin) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== allowedOrigin) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
}

async function handleLoadFailure(serverUrl, errorDescription) {
  if (handlingLoadFailure || setupWindow) return;
  handlingLoadFailure = true;
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: '无法连接服务器',
    message: '墨痕暂时无法连接 NAS 服务',
    detail: `${serverUrl}\n\n${errorDescription || '请确认 NAS 和 Docker 容器正在运行。'}`,
    buttons: ['重试', '设置服务器地址', '退出'],
    defaultId: 0,
    cancelId: 2
  });
  handlingLoadFailure = false;
  if (result.response === 0) mainWindow?.loadURL(`${serverUrl}/?desktop=${clientRole}`);
  else if (result.response === 1) openSetupWindow();
  else app.quit();
}

function createMainWindow(serverUrl) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    mainWindow.loadURL(`${serverUrl}/?desktop=${clientRole}`);
    return;
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
      sandbox: true
    }
  });

  const currentAgent = mainWindow.webContents.getUserAgent();
  const roleAgent = clientRole === 'teacher' ? 'KexuTeacher' : 'KexuStudent';
  mainWindow.webContents.setUserAgent(`${currentAgent} ${roleAgent}/${app.getVersion()}`);
  configureNavigation(mainWindow, serverUrl);
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) handleLoadFailure(serverUrl, errorDescription);
  });
  mainWindow.on('closed', () => { mainWindow = undefined; });
  mainWindow.loadURL(`${serverUrl}/?desktop=${clientRole}`);
}

function openSetupWindow() {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.focus();
    return;
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
      sandbox: true
    }
  });
  setupWindow.removeMenu();
  setupWindow.loadFile(path.join(__dirname, 'setup.html'));
  setupWindow.on('closed', () => { setupWindow = undefined; });
}

app.setAppUserModelId(appId);
app.whenReady().then(() => {
  Menu.setApplicationMenu(createMenu());

  ipcMain.handle('settings:get', () => ({
    role: clientRole,
    roleName,
    productName,
    version: app.getVersion(),
    serverUrl: readSettings().serverUrl || ''
  }));
  ipcMain.handle('server:test', (_event, serverUrl) => testServer(serverUrl));
  ipcMain.handle('server:save', async (_event, input) => {
    const result = await testServer(input);
    writeSettings({ serverUrl: result.serverUrl });
    setupWindow?.close();
    createMainWindow(result.serverUrl);
    return result;
  });
  ipcMain.handle('assignment-files:save', (_event, payload) => saveAssignmentFiles(payload));

  const serverUrl = readSettings().serverUrl;
  if (serverUrl) createMainWindow(serverUrl);
  else openSetupWindow();

  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) {
      const savedUrl = readSettings().serverUrl;
      if (savedUrl) createMainWindow(savedUrl);
      else openSetupWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
