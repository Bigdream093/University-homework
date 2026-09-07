# 墨痕教师端、学生端自动更新实施计划

审核日期：2026-09-05。本文是待实施计划，不代表已修改客户端或 NAS。

执行记录：桌面源码现已实现菜单手动检查、Windows 下载与确认安装、Mac DMG 手动更新、打包配置注入和发布文件整理。实际使用方式以 [desktop/UPDATES.md](desktop/UPDATES.md) 为准。NAS 未部署，正式更新地址仍待填写；下面保留原审核时的现状与设计依据。

## 1. 审核结论与项目现状

采用 NAS 静态目录 + Nginx + electron-updater generic provider 可行，无需编写更新业务接口。

已核对本地项目：

- desktop/package.json：版本 1.6.5，Electron 44.0.0、electron-builder 26.15.3，尚未安装 electron-updater。
- 两端共享 desktop/src/main.cjs，打包时用 clientRole 区分角色；分别有独立 appId、包名和输出目录。
- 两端 Windows 均为 NSIS x64，适合本方案；两份 builder 配置目前都是 publish: null。
- 学生端还有 macOS arm64 的 dmg + zip，但 identity: null，尚不具备正式 Mac 自动更新的签名前提。
- docker-compose.yml 仅声明业务容器，34567 映射到业务端口 3000；未发现项目管理的 Nginx 配置。不能假定该端口已经经过 Nginx。
- 主窗口通过 loadURL 加载 NAS 页面。网页功能更新主要随 NAS 部署生效，桌面更新负责主进程、preload、Electron 及本地能力。两类版本要兼容。

## 2. 确定的实施范围与行为

第一阶段完成 Windows 教师端、学生端由帮助菜单手动触发检查、发现新版后后台下载；下载完成后显示“重启并更新 / 稍后”。不在授课、批改、作业提交或资料传输途中自动退出。

应用启动时和运行期间均不自动检查，不设轮询、延时检查或恢复网络后检查。仅在用户点击“帮助 → 检查更新”时发起检查。Windows 发现新版后后台下载，下载完成后帮助菜单提供“重启并更新”；点击后执行安装。Mac 检查到新版后提供“下载 DMG / 稍后”，由用户手动安装，不提供“重启并更新”。

Mac 学生端同期实现“检测更新 + 浏览器下载 DMG + 用户手动替换应用”。使用主进程 fetch 检查独立 JSON 清单，不调用 Mac autoUpdater、不后台安装。不将签名和公证作为此功能的开发前提，但未签名应用仍可能被系统拦截，必须实测下载后的安装体验。

按用户确定的部署方案，NAS 保持 HTTP，不增加 HTTPS 证书配置。HTTP 无法防止清单和安装包被网络中间人同时替换，同一 HTTP 清单中的哈希也不能证明来源；这是本方案保留的部署限制。Windows 自动更新同样受此限制，代码签名仍建议保留。

## 3. NAS 目录与网络配置

使用 NAS 的真实持久化目录，例如 /volume1/electron_update（示例路径，部署时替换）：

```text
electron_update/
  teacher/
    win-x64/
      latest.yml
      墨痕教师端-Setup-1.6.6.exe
      墨痕教师端-Setup-1.6.6.exe.blockmap
  student/
    win-x64/
      latest.yml
      墨痕学生端-Setup-1.6.6.exe
      墨痕学生端-Setup-1.6.6.exe.blockmap
    mac-arm64/
      latest.json
      墨痕学生端-macOS-arm64-1.6.6.dmg
```

不能让两端共用一个 latest.yml，否则后发布的一端会覆盖另一端的版本入口。当前 NSIS 方案不用 nupkg，它属于另一套更新格式。保留 builder 生成的文件名、哈希和元数据，不手写 latest.yml。

在实际负责对外访问的 Nginx 容器中添加只读挂载，合并进原服务的 volumes，不能覆盖原列表：

```yaml
volumes:
  - /volume1/electron_update:/usr/share/nginx/electron_update:ro
```

在实际提供 HTTP 访问的 server 块添加：

```nginx
location ^~ /update/ {
    alias /usr/share/nginx/electron_update/;
    autoindex off;
    default_type application/octet-stream;
    add_header Cache-Control "no-store" always;
    limit_except GET HEAD { deny all; }
}
```

第一版统一不缓存以降低发布错误；后续可仅让版本清单不缓存、带版本号的安装文件长期缓存。^~ 用于避免一般的扩展名正则规则抢走此路径，仍须检查实际 server 中的重写、鉴权及错误页回退。

部署要求：

1. 更新地址采用固定 HTTP 域名或稳定 IP、端口。校外使用时必须从校外网络实测，内网 NAS IP 不能满足公网用户。不能因为业务端口可用，就假定相同端口的 /update/ 已接入 Nginx。
2. /update/ 下文件无需业务登录或 Cookie；如现有入口有统一鉴权，单独配置静态更新路径例外，不取消业务接口鉴权。
3. 更新目录仅放可公开分发的产物；配置、数据、证书私钥及上传临时文件留在目录外。
4. 文件不存在应返回 404，不返回登录页面或网页首页；保留 Range 请求能力。
5. 新增 Docker 挂载通常需要重新创建对应 Nginx 容器，仅 reload 配置不会增加挂载。随后先检查 Nginx 配置，再重载；重新创建期间安排短暂维护窗口。
6. 保留现有 /api/ 路由，并验证业务健康检查、登录和下载仍正常。静态服务不经过业务代码，但共享 NAS 带宽和磁盘，需评估整班同时下载。

## 4. 打包改动

在 desktop 目录安装 electron-updater 为生产依赖，并同步提交锁文件；可配 electron-log 记录本地更新日志。选择并锁定与现有 Electron/builder 实测兼容的版本，不依赖部署时自动选择最新版。

教师端 electron-builder.teacher.yml 用以下配置替换 publish: null（域名是占位符）：

```yaml
publish:
  provider: generic
  url: http://updates.example.com/update/teacher/win-x64/
```

学生端删除顶层 publish: null，在现有 win、mac 块内合并配置，不重复创建 win/mac 键：

```yaml
win:
  # 保留现有 icon、target、artifactName
  publish:
    provider: generic
    url: http://updates.example.com/update/student/win-x64/

mac:
  # 保留现有 dmg、zip、arm64 等配置，使用独立手动更新清单
  publish: null
```

Windows 固定更新地址随安装包内的 app-update.yml 分发，主进程无需再调用 setFeedURL。Mac 的固定清单地址写入受打包控制的主进程配置。不要从用户可修改的业务服务器地址推导安装包来源。未来变更域名应保留旧入口过渡。上面的域名需要替换成实际地址和端口。

保持既有 appId、extraMetadata.name、productName 和安装身份稳定，避免安装成另一款应用或改变用户配置目录。Windows 正式分发建议配置代码签名并验证发布者身份，证书密钥不能放 NAS 静态目录；HTTPS 与文件哈希不能替代发布者签名。

## 5. 主进程改动要求

建议新增 desktop/src/updater.cjs，由 main.cjs 在 app.whenReady() 后初始化一次，并接入现有帮助菜单。初始化只注册事件和菜单，不发起网络检查。不要用示例代码替换现有主进程。

执行顺序：

1. 非打包环境直接跳过，正式逻辑不设置 forceDevUpdateConfig；开发调试使用独立测试地址和 dev-app-update.yml。
2. 按平台分支：Windows 启动 electron-updater；Mac 启动下文的手动更新检查器。以下第 3—9 项的安装控制针对 Windows。
3. 配置 autoDownload = true、autoInstallOnAppQuit = false、allowDowngrade = false。
4. 先注册 error、checking-for-update、update-available、update-not-available、download-progress、update-downloaded，仅在用户点击菜单时发起检查。事件名使用普通 ASCII 连字符“-”对应的代码字符 `-`，不能复制原示例中的 Unicode 非断行连字符。
5. 检查调用使用 try/catch 或 Promise.catch，同时保留 error 监听；失败不妨碍启动、登录及使用。
6. 维护 idle/checking/downloading/downloaded/error 状态；检查和下载期间合并重复请求，下载完成后保留“重启并更新”入口。
7. 下载完成只提示；用户明确选择安装后才调用 quitAndInstall。安装前检查主进程资料下载，以及页面上传、提交和未保存编辑状态。当前 downloads Map 不能覆盖网页上传/未保存内容，需增加页面协调或保存确认；无法确认安全时默认“稍后”。
8. 用户主动检查时显示检查中、已是最新版或可理解的失败原因和重试入口。记录版本、角色、状态和错误，不记录登录令牌。
9. 不创建自动检查计时器；使用单实例锁或等效机制避免同一角色多进程重复更新，并验证两端仍能同时运行。

具体实现必须基于最终锁定的 electron-updater 版本验证安装/退出行为，不只以开发环境事件模拟作为成功依据。

### Mac 手动更新检查器

NAS 的 /update/student/mac-arm64/latest.json 示例：

```json
{
  "version": "1.6.6",
  "role": "student",
  "platform": "darwin",
  "arch": "arm64",
  "file": "墨痕学生端-macOS-arm64-1.6.6.dmg",
  "notes": "修复已知问题"
}
```

由发布脚本读取 desktop/package.json 和真实 DMG 产物自动生成 JSON；不用 Mac electron-updater，也不依赖 latest-mac.yml。

1. 仅在用户点击“帮助 → 检查更新”后，主进程请求固定清单地址，设置约 10 秒超时、响应大小限制，拒绝重定向；检查 HTTP 状态并验证字段类型、角色、系统和架构。
2. 使用直接声明的 semver 生产依赖比较版本，不做字符串比较；稳定通道拒绝预发布版本。只有新版本高于 app.getVersion() 才提示。
3. file 只允许单个 DMG 文件名，不允许斜杠、反斜杠、路径穿越或完整 URL；对文件名编码后与固定目录拼接，最终复核 origin 和目录。不要把清单提供的任意 URL 直接传给 shell.openExternal。
4. 弹窗显示当前版本、新版本和纯文本更新说明，按钮为“打开下载页面 / 稍后”（直接 DMG 下载可将按钮命名为“下载 DMG”）。只有点击下载才打开系统浏览器；捕获打开失败并提示重试。
5. 提示文字：“下载并打开 DMG 后，请退出墨痕学生端，将其中的墨痕学生端.app 拖入“应用程序”文件夹（或原安装位置），确认替换，再从安装位置重新打开，最后推出磁盘映像。”下载点击不代表安装成功，不自动关闭应用或删除用户数据。
6. 不自动检查或自动提醒；帮助菜单允许手动检查，正在检查时合并重复点击。当前仅提供 arm64 包，Intel Mac 不应收到 arm64 下载链接；未来增加 x64 时使用独立目录。
7. DMG 在构建 Mac 的环境中生成并检查，验证挂载后 .app 完整、Applications 快捷入口可用。用浏览器实际下载到 Mac 后检查挂载、拖拽替换和系统拦截情况，不能仅测试构建机上的原始 .app。手动更新不依赖 ZIP，可保留现有 ZIP 构建产物供其他用途，但更新清单只指向 DMG。

## 6. 首次启用与后续发布

当前 1.6.5 没有 updater，无法仅靠 NAS 放一个新文件就让旧客户端自更新。建议用 1.6.6 作为首次具备更新能力的版本；如果此版本已被其他工作占用，则选更高的未发布版本。

首次上线：

1. 完成 NAS 测试目录和客户端更新模块。
2. 为教师、学生各构建一个带 updater 的低版本测试安装包 A，以及更高版本 B，均指向隔离测试目录。
3. 分别安装 A，再通过更新升级到 B；验收通过才构建正式引导版本。
4. 分发引导安装包，通知现有用户关闭应用后手动覆盖安装一次；验证设置和登录状态保留。
5. 以后用户从引导版本开始，通过“帮助 → 检查更新”获取后续版本。

每次正式发布：

1. 提升 desktop/package.json 的版本号；目前两端共用该版本，默认同步发布两端。
2. 在 desktop 目录执行现有 npm run build，检查 release/teacher、release/student 中实际生成的安装文件、blockmap 和 latest.yml；确认包内 app-update.yml 的地址与角色匹配。未生成元数据就停止发布、排查配置。
3. generic provider 不会替你上传到 NAS。通过受控管理通道先上传安装文件和相关 blockmap；临时文件放公开目录外、同一文件系统上，上传完整后移动到正式目录。
4. 核对 Windows 文件大小、SHA-512 与清单一致，确认所有被引用文件通过最终 HTTP URL 可下载。Mac 在适用构建环境执行学生端 Mac 构建，检查 DMG 并生成 latest.json。
5. 最后将 Windows latest.yml 原子替换到公开目录；Mac 先发布 DMG，最后原子替换 latest.json。不要直接覆盖正在公开提供的不完整清单。
6. 用试点设备确认升级成功，再通知用户。保留旧安装包和 blockmap，避免正在下载或跨版本更新的客户端遇到文件消失。
7. 若新版本有问题，先恢复旧清单以停止更多用户获取问题版本；已升级用户不会因此自动降级。将修复代码发布为更高版本处理，例如 1.6.7 出错则发布 1.6.8；另保留手动恢复渠道。

NAS 业务部署和客户端发布需要版本兼容窗口：先上线兼容旧客户端的后端，再发新客户端，确认旧版本退出后再移除兼容接口。

## 7. 验收清单

| 项目 | 通过条件 |
| --- | --- |
| 静态地址 | Windows 清单返回 200 和 YAML，Mac 返回 JSON；无登录跳转、无 HTML 首页回退 |
| 文件下载 | 清单引用的所有文件可下载，哈希与大小匹配；Range 请求返回正确的 206/Content-Range |
| 角色隔离 | 教师端只请求 teacher，学生端只请求 student；安装后名称和身份不串端 |
| 真实升级 | 已安装 A 检测到 B、下载并按用户选择安装，重启后版本确实增加 |
| 数据保留 | 服务器地址、用户配置、登录状态及已下载资料保持正常 |
| 稍后安装 | 点击稍后不退出；普通退出不偷偷安装；再次启动不检查，用户手动检查后可重新获得安装入口 |
| 工作保护 | 上传、提交、批改、资料下载过程中不强制关闭；未保存内容得到处理 |
| 异常处理 | 离线、超时、404、损坏包、磁盘不足时不中断业务，不安装损坏文件，可重试 |
| 检查触发 | 启动、持续运行、恢复网络均不请求更新地址；只有点击帮助菜单才检查，Windows 下载后显示“重启并更新” |
| 版本行为 | 同版本不反复更新；旧清单不触发降级；连续点击不重复下载 |
| 部署回归 | /api/health、登录、提交、下载在 Nginx 变更后正常；校外地址可达 |
| Mac 手动更新 | arm64 真机 A 检测到 B，点击才打开正确 DMG，手动替换后显示 B，设置保留；取消不退出 |
| Mac 清单异常 | 无效 JSON、非法版本、错架构、越界文件名及重定向被拒绝，不打开任意外部链接 |
| Mac 系统拦截 | 从 HTTP 浏览器下载后的 DMG 在目标 Mac 上实测；如系统阻止运行，不将该版本标记为交付验收通过 |

## 8. 实施前需要补齐的部署信息

实施者需要取得实际 Nginx 容器/配置位置、NAS 持久化绝对路径、最终 HTTP 域名或 IP 及端口。当前本地文件无法证明这些线上条件已经存在。需要确认 Windows 签名安排与 Mac 构建/测试环境；本期不要求为了 Mac 手动更新配置 HTTPS 或 Developer ID。

## 官方依据

- [electron-builder v26 自动更新说明](https://www.electron.build/v26/docs/features/auto-update/)：generic 静态发布、NSIS、应用依赖、内置更新配置与 Mac 签名前提。
- [electron-builder 发布配置](https://www.electron.build/docs/publish/)：发布配置与更新元数据。
- [Nginx alias 与 location](https://nginx.org/en/docs/http/ngx_http_core_module.html#alias)：静态路径映射。
- [Apple：安全打开 Mac 应用](https://support.apple.com/en-gb/102445)：未签名、未公证应用仍可能被系统阻止运行。
- [Electron 安全说明](https://www.electronjs.org/docs/latest/tutorial/security)：不要向 shell.openExternal 传入不可信内容。


