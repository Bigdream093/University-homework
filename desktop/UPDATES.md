# 桌面端更新开发与发布

当前桌面版本：1.6.6。启动和运行期间均不自动检查；仅点击“帮助 → 检查更新”时访问更新服务器。

- Windows 教师端/学生端：发现新版后后台下载，帮助菜单显示进度；完成后出现“重启并更新”。安装前确认已保存工作，默认“稍后”。未完成的本地资料下载会阻止安装；网页上传、提交和未保存编辑需用户在确认框中确认已完成。普通退出不安装。
- Mac 学生端 arm64：读取 latest.json，点击“下载 DMG”才打开浏览器；用户退出旧版后将 DMG 内的 .app 拖到原位置替换。不会自动退出或安装。
- 帮助菜单不提供定时检查选项，客户端也没有检查计时器。下次启动后若要安装上次缓存的更新，先手动检查，由 updater 验证缓存后重新显示安装入口。

## 配置更新地址

desktop/update-config.json 的 baseUrl 当前已配置为 `http://nas.mchen.asia:34567/update/`。更换部署地址时应在构建前修改。若清空地址，客户端不会发起更新请求，会提示“尚未配置更新地址”；不要分发空地址构建并期待之后能远程启用更新。

也可在构建进程设置 MOHEN_UPDATE_BASE_URL 环境变量覆盖该文件。地址必须为 HTTP/HTTPS 目录，不能带账号、查询参数或片段。不从客户端可编辑的业务服务器地址推导更新源。

两份 electron-builder.*.cjs 读取原 YAML 配置，按角色注入固定地址和 extraMetadata.updateBaseUrl，Windows 更新器读取 builder 生成的 resources/app-update.yml。Mac 禁用原生更新发布配置，使用独立 DMG 清单。

请通过下列 npm 脚本构建；直接调用旧 YAML 会绕过更新配置注入。

## 构建与整理

在 desktop 目录运行：

```powershell
npm ci
npm test
npm run build
npm run prepare:update:teacher
npm run prepare:update:student
```

build 生成 Windows 两端安装包。prepare:update 脚本检查版本号、角色、安装文件大小和 SHA-512、blockmap 存在性，再放入独立的 release/update-staging/<版本-随机目录>/ 内，避免覆盖历史发布。

在具备 Mac 构建能力的环境中运行：

```sh
npm ci
npm run build:student:mac
```

该命令构建现有 dmg + zip 目标，并自动整理 DMG 和 latest.json。手动重新整理可运行 npm run prepare:update:mac。JSON 的 version、role、platform、arch、file 从源码版本和实际产物生成，notes 默认为空；需要更新说明时在发布前填写纯文本，最长 4000 字符。

每次发版提升 desktop/package.json 及其锁文件的版本；两端共用此版本。appId、包名和产品名保持稳定。当前没有 updater 的旧版用户需手动覆盖安装一次 1.6.6（或以后已配置更新地址的版本）。

## NAS 静态目录

```text
<NAS 更新目录>/
  teacher/win-x64/latest.yml
  teacher/win-x64/<教师端 exe 和 exe.blockmap>
  student/win-x64/latest.yml
  student/win-x64/<学生端 exe 和 exe.blockmap>
  student/mac-arm64/latest.json
  student/mac-arm64/<学生端 dmg>
```

将 NAS 持久化目录只读挂载至已有 Nginx 容器的 /usr/share/nginx/electron_update，并将 ../deploy/nginx-update.conf 合并到对应 HTTP server 块。此文件是配置片段，不能直接替换完整 nginx.conf。新增挂载需要重建对应容器；检查实际鉴权、错误页和反向代理规则，确保清单返回静态内容而非登录页或业务首页。

上传时先放 exe/blockmap 或 DMG，校验可下载后，最后在同一文件系统原子替换 latest.yml 或 latest.json。不要把临时上传放到公开目录；不要删除仍可能被旧客户端引用的历史产物。更新文件应返回 200，安装文件的 Range 请求应返回正确的 206。

NAS 保持 HTTP；HTTP 不能证明清单和包的来源，文件哈希不防止二者同时被替换。Windows 建议使用发布者代码签名。Mac 手动安装不依赖原生 updater 的签名前提，但未签名应用仍可能受系统限制；必须在真实 Mac 从浏览器下载 DMG 后验收。

## 验证范围

npm test 覆盖：启动无请求、手动检查、重复请求合并、下载/安装状态、稍后与传输保护、错误恢复、Mac 角色/架构/版本/路径校验、真实本地 HTTP 响应与重定向拒绝、发布文件哈希校验及两端打包配置隔离。

发版前还需要真实已安装 A→B 升级测试：Windows 确认安装成功、设置保留；Mac 确认 DMG 可挂载、替换后的版本正确。单元测试和构建成功不能替代这些测试。安装包和 NAS 部署均不由测试自动发布。

主进程在用户数据目录记录 updates.log，仅记录版本、角色、状态和错误类别；超过 256 KiB 时滚动保留一份历史日志。
