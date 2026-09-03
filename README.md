# 墨痕 · 高校作业管理系统（university-homework）

面向单教师、约 300 名学生的轻量作业管理系统。支持课程与名单管理、Excel 原序导入、作业发布、文件/在线提交、文件名自动规范化、截止前 24 小时提醒、迟交确认与标记、重交替换、教师筛选批改、退回和成绩表导出。

服务端与前端由 Express 单进程同时提供（生产模式），同一套 Web 界面打包为教师端 / 学生端 Electron 桌面客户端，也提供 Docker 镜像用于 NAS 部署。

## 功能特性

**课程与名单**
- 课程创建、归档与复制（课程复制可携带作业与资料设置）
- Excel 名单原序导入（A 列学号、B 列姓名，首行为表头），已有学生账号直接加入课程
- 分组管理与小组作业

**作业与提交**
- 作业发布、课程资料上传（资料单文件最大 10 GB）
- 文件提交与在线作答，支持分片上传、断点续传、分片安全重试与上传进度显示
- 学生重交替换：新文件替换上一次实体文件，提交历史保留文件名、时间与迟交状态
- 提交回执：上传完成后返回服务端确认的文件清单与指纹
- 截止前 24 小时黄色提醒；截止后仍可提交，红色提醒并标记迟交；提交时间以服务器时间为准

**批改与成绩**
- 教师筛选批改、评语与成绩、退回重做
- 单个学生或全班作业打包下载，附件、在线作答与预览照片按学生及提交版本分目录存放
- 成绩汇总表导出
- 学生接口不返回成绩与教师评语；文件下载校验角色、当前课程成员资格与个人/小组归属

**通知、问答与延期**
- 通知发布、已读跟踪与未读提醒、修订/撤回
- 私人/公开问答
- 个人/小组延期申请与审批，支持定时通知

**帮助手册**
- 登录后点击“帮助”可查看与角色对应的完整说明，支持站内搜索与 Markdown 下载，浏览器可直接打印。手册源文件位于 [`server/help/`](server/help/)。

## 技术栈

| 端 | 技术 |
| --- | --- |
| 服务端 [`server/`](server/) | Node.js 20+、Express 5、better-sqlite3、Multer、ExcelJS、Sharp、bcryptjs、JWT |
| Web 前端 [`web/`](web/) | Vue 3、Vite、Element Plus、Pinia、Vue Router、Axios、hash-wasm |
| 桌面端 [`desktop/`](desktop/) | Electron + electron-builder（教师端 / 学生端，Windows & macOS arm64） |
| 部署 | Docker Compose、绿联 NAS 离线包 |

npm workspaces 单仓结构：

```
university-homework/
├── server/        # Express API、SQLite 迁移、帮助手册、验收脚本
│   ├── src/       # 路由、中间件、服务、迁移
│   ├── help/      # 角色 help 手册（Markdown）
│   └── scripts/   # 大文件/并发上传、迁移验收脚本
├── web/           # Vue 3 前端（学生端 + 教师端视图）
├── desktop/       # Electron 桌面端（含首次使用设置向导）
└── release/       # 离线发布包（不提交 Git）
```

## 本地开发

需要 Node.js 20 或更高版本。

```bash
npm install
npm run dev
```

浏览器访问 `http://localhost:5173`。首次运行会自动创建数据库和教师账号：

- 教师：`teacher` / `123456`
- 新导入的学生默认密码为 `123456`

首次登录后请立即修改密码。

## 生产构建

```bash
npm run build
npm start
```

生产环境由 Express 同时提供 API 和 `web/dist` 静态页面，访问 `http://localhost:3000`（端口由 `PORT` 配置）。

桌面客户端构建：

```bash
npm run build:desktop:teacher        # 教师端
npm run build:desktop:student        # 学生端（Windows）
npm run build:desktop:student:mac    # 学生端（macOS arm64）
```

安装桌面端后填写 NAS/服务器地址即可使用。

## Docker / 绿联 NAS 部署

1. 复制 `.env.example` 为 `.env`，把 `JWT_SECRET` 改为至少 32 字节的随机字符串。生产环境漏配、过短或仍使用示例值时服务会拒绝启动。
2. 启动：

   ```bash
   docker compose up -d --build
   ```

3. 访问 `http://NAS地址:34567`。

如果 HTTPS 由应用前方的一层反向代理终止，在 `.env` 中设置 `TRUST_PROXY_HOPS=1`；直接访问应用端口时保持 `0`。该值必须等于客户端到应用之间受信任的代理层数，否则登录限流可能把多个用户误判为同一地址，或信任伪造的转发地址。

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 服务监听端口 |
| `JWT_SECRET` | 无 | JWT 签名密钥，生产环境必须为至少 32 字节的非示例值，否则拒绝启动 |
| `UPLOAD_MAX_MB` | `200` | 作业单文件上限，教师可在 100M / 200M / 500M / 1G 中设置 |
| `MATERIAL_UPLOAD_MAX_MB` | `10240` | 课程资料单文件上限（10 GB） |
| `UPLOAD_REQUEST_TIMEOUT_MS` | `7200000` | 服务端允许的上传请求时长（2 小时） |
| `TRUST_PROXY_HOPS` | `0` | 受信任的反向代理层数 |
| `DATA_DIR` | `./data` | 数据库目录（Docker 内为 `/app/data`） |
| `UPLOAD_DIR` | `./uploads` | 附件目录（Docker 内为 `/app/uploads`） |
| `TZ` | — | 生产环境必须为 `Asia/Shanghai`，否则拒绝启动 |

### 数据与备份

- Docker 数据库保存在 `data/`，附件保存在 `uploads/`；本地开发默认在 `server/data/`、`server/uploads/`。
- 备份前停止写入，保存数据库（含存在的 WAL/SHM 文件）、全部附件、配置及对应的镜像/代码版本。
- 数据库使用有版本的兼容迁移，升级前先备份；不要部分覆盖服务端或前端文件。
- NAS 改名升级、离线包导入等步骤见 [`server/help/maintenance.md`](server/help/maintenance.md)。旧容器需保持停止，不能让新旧服务同时写同一数据库。
- 正式暴露到公网前应配置 HTTPS，并关闭路由器公网管理入口。HTTP 不加密账号和文件内容，公网使用建议在 NAS 前配置 HTTPS 或 VPN。

## 学生名单模板

Excel 首行为表头，A 列为学号、B 列为姓名，从第二行开始读取。新学生默认密码 `123456`，已有学生账号会直接加入课程。

## 测试与验收

```sh
npm test
npm run build
node server/scripts/verify-large-upload.mjs
LOAD_STUDENTS=30 LOAD_FILE_MB=500 node server/scripts/verify-concurrent-upload.mjs
node server/scripts/verify-existing-migration.mjs server/data/homework.sqlite
```

大文件和并发验收均使用独立临时目录并在完成后清理；30 人、每人 500 MB 的并发测试需预留约 16 GiB 临时空间。它验证服务端并发写盘、流式指纹、回执和残留清理，但不能代替 NAS 真实网络测试。现有数据库校验通过只读备份在副本上迁移，不更改源数据库；首次运行无原数据库时略过副本验证。

## 安全要点

- 密码使用 bcrypt 哈希，JWT 默认 24 小时失效。
- 学生成绩与教师评语不会由学生接口返回；文件下载同时校验角色、课程成员资格和个人/小组归属。
- 上传文件流式落盘并在写入时同步计算指纹，不为去重再次完整读盘；前端不设固定超时。
- 局域网或公网 HTTP 页面也支持分片上传、断点续传和分片重试：浏览器没有 WebCrypto 时自动使用兼容哈希实现。
- 上传文件对教师显示并下载为“姓名_学号_提交时间_准时或迟交.扩展名”，服务器内部文件名保持唯一。
- 提交时间与超时状态只按服务器时间计算。
- 学生退出课程后不再访问该课程历史资源。
- 不要把 `.env`、`data/`、`uploads/` 或备份提交到 GitHub。

## 维护文档

- 部署与维护：[`server/help/maintenance.md`](server/help/maintenance.md)
- 各功能使用说明：见 [`server/help/`](server/help/)（也可在应用内“帮助”页面查看）
