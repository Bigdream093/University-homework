# 前端三阶段改造记录

完成检查工具、按需加载、三个大页面拆分、共享成绩计算、登录样式归位和 CSP 配置。未部署，也未制作发布安装包。

## 第一阶段：检查与加载

- 引入 ESLint（JS + Vue）和 Prettier，处理既有静态检查问题及格式差异。
- 根目录 `npm run test:frontend` 依次运行 lint、格式检查和前端测试；`npm run check -w web` 额外执行构建。
- Element Plus 使用 `unplugin-vue-components` 和 `ElementPlusResolver` 解析模板组件/指令，使用 `unplugin-element-plus` 为显式导入的消息与确认框补齐样式。保留显式 JS API 导入，无需额外 API 自动导入插件。
- 移除入口全量注册和全量 CSS，保留路由懒加载。
- 登录请求显式标注 `skipSessionExpiry: true`，拦截器不再匹配登录路径字符串。

| 入口资源 | 改前 | 改后 | 减少 |
|---|---:|---:|---:|
| JS | 1,086.31 kB | 305.32 kB | 71.9% |
| CSS | 368.14 kB | 57.28 kB | 84.4% |
| JS gzip | 359.99 kB | 112.85 kB | 68.7% |
| CSS gzip | 50.20 kB | 9.15 kB | 81.8% |

口径是生产构建入口资源，不是全站异步资源总量。gzip 为估计，不代表服务器已启用压缩。未进行同条件首屏耗时对照，不承诺首屏加速比例。字节记录见 `frontend-build-comparison.json`。

## 第二阶段：职责拆分

| 入口文件 | 改前行数 | 改后行数 |
|---|---:|---:|
| `web/src/components/CourseSummary.vue` | 777 | 167 |
| `web/src/views/teacher/SubmissionsView.vue` | 589 | 159 |
| `web/src/views/teacher/CourseManage.vue` | 561 | 160 |

### 课程管理

- `CourseAssignmentForm.vue`：新建/编辑表单及保存，每次打开重新初始化草稿。
- `CourseAssignmentsPanel.vue`：作业卡片、发布、关闭和移动。
- `CourseStudentsPanel.vue`：名单、导入、学生操作和添加弹窗。名单显隐与弹窗独立，其他页签也可用顶部添加按钮。
- `utils/assignmentForm.js`：纯后缀校验函数。
- 页面保留课程加载、页签组织和跨区域刷新。
- 既有复制入口位于课程列表，复制课程及作业模板；本轮未新增单作业复制功能。

### 提交管理

- `SubmissionTable.vue`：列表展示并发出下载、评分等事件。
- `SubmissionGradeDialog.vue`：批改、退回、草稿恢复和关闭保护；修复“放弃草稿”重新恢复同一草稿的问题。
- `useSubmissions.js`：加载、筛选、统计和预览票据。
- `useSubmissionDownloads.js`：下载业务参数与导出，继续复用原有 `useDownload` 传输/桌面任务管理。
- `utils/submissionFiles.js`：文件列表和命名。

### 成绩汇总

- `CourseGradeTable.vue`：表格和行内编辑；成功后发出事件，由数据层更新成绩。
- `CourseGradeSettings.vue`：权重弹窗，以事件修改草稿，避免直接修改传入对象。
- `useGradeSettings.js`：草稿、脏检查、占比校验和平均分配。
- `useCourseSummary.js`：加载、保存、导出和预览成绩。
- `useSummaryPreviews.js`：图片访问票据。原来的“票据兑换”是图片鉴权，并非业务兑换弹窗。
- `useSummaryWorkspace.js`：看图评分工作区和刷新。
- `server/src/domain/gradeScores.js`：前后端共同引用的纯计算模块。前端转换未保存设置，后端提供正式保存及导出结果；计算过程保留精度，输出时舍入。
- Docker 的 Web 构建阶段增加共享 domain 源码复制。

## 第三阶段：样式与 CSP

- 登录覆盖规则移入 `LoginView.vue` 的 scoped 样式，移除独立覆盖文件。单次使用的布局数值不强行抽变量。
- 服务端通过响应头下发 CSP，现默认 `CSP_MODE=enforce`；排障时可临时切回 `report-only`。
- 脚本仅允许同源及 WebAssembly 编译，不放开普通 eval 或行内脚本。为 Element Plus 动态布局保留行内样式权限。
- 图片允许同源、data 和 blob；支持局域网 HTTP 场景的 WebAssembly 摘要回退。
- CSP 报告接口限制体积，限量记录合法指令名，不记录 URL、令牌或脚本内容。
- 桌面连接设置页增加本地 CSP，桌面主页面使用服务端响应头。

## 验证结果

- ESLint、Prettier 检查及生产构建通过。
- 前端 69 项测试通过：真实提取子组件交互、成绩边界、会话标记、评分草稿、桌面网络与续传等。
- 服务端 82 项测试通过：成绩汇总、导出、CSP 两种模式及报告处理等。
- `CSP_MODE=enforce` 下 6 项 Chromium 流程通过：新建/编辑与页签；个人/小组提交、批改、汇总改分和导出；上传暂停续传；2.55 舍入；断网草稿恢复。
- 已检查真实成绩汇总截图，保留原有设计。
- 浏览器报告：`test-results/browser-source-report/index.html`。

本轮不包括 HttpOnly Cookie 迁移、Pinia 写法迁移或下载系统整体重写。发布前已将默认模式切为 enforce；实际部署需确认响应头，并覆盖旧环境变量设置。
