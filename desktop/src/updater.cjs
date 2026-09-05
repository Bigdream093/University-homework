const { updateDirectory, fetchMacManifest } = require('./update-policy.cjs')

// Construction registers no timers and performs no network requests.
function createUpdateController({ app, dialog, shell, role, baseUrl,
  platform = process.platform, arch = process.arch,
  getWindowsUpdater = () => require('electron-updater').autoUpdater,
  fetchImpl, onState = () => {}, canInstall = () => true, log = () => {} }) {
  let state = 'idle'
  let progress = 0
  let updater
  let operation = false
  let installing = false
  let failureShown = false

  function setState(next) {
    state = next
    log(next)
    onState()
  }
  function notify(message, detail = '', type = 'info') {
    return dialog.showMessageBox({ type, title: '软件更新', message, detail, buttons: ['确定'] })
  }
  async function fail(error) {
    setState('error')
    if (failureShown) return
    failureShown = true
    // Avoid logging server response bodies or request headers containing user data.
    log(`failure:${String(error?.code || error?.name || 'Error')}`)
    await notify('更新未完成，请稍后重试',
      '请检查网络、更新服务器和磁盘空间。当前版本仍可继续使用。', 'warning')
  }
  function initializeWindows() {
    if (updater) return updater
    updater = getWindowsUpdater()
    updater.autoDownload = true
    updater.autoInstallOnAppQuit = false
    updater.allowDowngrade = false
    updater.allowPrerelease = false
    updater.on('checking-for-update', () => setState('checking'))
    updater.on('update-available', () => setState('downloading'))
    updater.on('download-progress', (info) => {
      progress = Math.max(0, Math.min(100, Math.floor(info.percent || 0)))
      onState()
    })
    updater.on('update-not-available', () => {
      setState('idle')
      void notify('当前已是最新版本', `当前版本：${app.getVersion()}`).catch(log)
    })
    updater.on('update-downloaded', () => {
      setState('downloaded')
      void notify('新版本已下载', '保存当前工作后，请选择“帮助 → 重启并更新”。').catch(log)
    })
    updater.on('update-cancelled', () => setState('idle'))
    updater.on('error', (error) => { void fail(error).catch(log) })
    return updater
  }
  async function check() {
    if (operation || installing || ['checking', 'downloading', 'downloaded'].includes(state)) return
    operation = true
    failureShown = false
    try {
      if (!app.isPackaged) {
        await notify('请在已安装的正式客户端中检查更新')
        return
      }
      if (!baseUrl) {
        await notify('尚未配置更新地址', '请联系发布者提供已配置更新地址的安装包。')
        return
      }
      const directory = updateDirectory(baseUrl, role, platform, arch)
      setState('checking')
      if (platform === 'win32') {
        const result = await initializeWindows().checkForUpdates()
        if (result?.downloadPromise) await result.downloadPromise
        if (state === 'checking') setState('idle')
      } else {
        const info = await fetchMacManifest(directory, app.getVersion(), fetchImpl)
        if (!info.available) {
          await notify('当前已是最新版本', `当前版本：${app.getVersion()}`)
        } else {
          const choice = await dialog.showMessageBox({
            type: 'info', title: '软件更新', message: `发现新版本 ${info.version}`,
            detail: `当前版本：${app.getVersion()}\n${info.notes || ''}\n\n下载并打开 DMG 后，请退出墨痕学生端，将其中的应用拖入“应用程序”文件夹（或原安装位置）并替换，再从安装位置启动。`,
            buttons: ['下载 DMG', '稍后'], defaultId: 1, cancelId: 1,
          })
          if (choice.response === 0) await shell.openExternal(info.url)
        }
        setState('idle')
      }
    } catch (error) {
      await fail(error)
    } finally {
      operation = false
      onState()
    }
  }
  async function install() {
    if (platform !== 'win32' || state !== 'downloaded' || installing) return
    installing = true
    try {
      if (!canInstall()) {
        await notify('请先完成或取消资料下载', '当前还有未完成的资料下载，暂不能重启更新。', 'warning')
        return
      }
      const choice = await dialog.showMessageBox({
        type: 'question', title: '重启并更新', message: '已保存工作并完成所有上传、提交？',
        detail: '更新会关闭应用。请确认批改、编辑内容已经保存，作业提交和资料上传均已完成。',
        buttons: ['已确认，重启并更新', '稍后'], defaultId: 1, cancelId: 1,
      })
      if (choice.response !== 0) return
      if (!canInstall()) {
        await notify('仍有资料传输，请完成后再更新')
        return
      }
      updater.quitAndInstall(false, true)
    } catch (error) {
      await fail(error)
    } finally {
      installing = false
    }
  }
  return {
    check, install,
    getState: () => state,
    menuItems: () => [
      { id: 'check-for-updates', label: state === 'checking' ? '正在检查更新…'
        : state === 'downloading' ? `正在下载更新 ${progress}%` : '检查更新',
      enabled: !operation && !['checking', 'downloading', 'downloaded'].includes(state),
      click: () => { void check().catch(log) } },
      { id: 'install-update', label: '重启并更新',
        visible: platform === 'win32' && state === 'downloaded',
        enabled: state === 'downloaded', click: () => { void install().catch(log) } },
    ],
  }
}

module.exports = { createUpdateController }
