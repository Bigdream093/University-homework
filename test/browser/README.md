# 真实浏览器测试

从仓库根目录运行 `npm ci`、`npx playwright install chromium`、`npm run test:browser`。
使用 Playwright Chromium 无头浏览器，运行完整生产构建和实际 Express 服务。
默认服务使用独立临时数据库/上传目录，端口 39061，不复用已运行服务。

| 用例 | 实际验证 |
| --- | --- |
| 个人作业链路 | UI 登录/首次教师改密、错误后缀阻止、真实文件输入和图片加载、跨 8 MiB 上传、回执、刷新状态、批改及评语隔离、汇总行内改分、浏览器下载并解析 XLSX、退回原因、重交次数和最终文件字节 |
| 小组作业链路 | 上述完整流程、小组成绩同步、非组长按钮禁用、组员共享次数、组外学生回执权限 |
| 分片暂停续传 | 第一片由真实服务保存；在第二片请求时点击暂停；查询服务器确认 8 MiB 偏移；恢复后不重传第一片；下载字节一致且只有一张回执 |
| 在线断网重试 | 空内容拦截、浏览器离线、失败提示、刷新恢复草稿、网络恢复后真实提交、一次回执、学生访问教师路由被重定向 |
| 成绩舍入边界 | 2.55 分在页面和 XLSX 中均为 2.6；源码已修复原页面显示 2.5 的差异，用例始终启用，旧发布包仍会失败 |

测试使用 HTTP API 准备课程、账号和作业数据；主要链路的提交、批改、导出、退回及重交均由浏览器操作。没有替换 Vue、Element Plus、FileDropZone、PreviewImagePicker 或业务 API 响应。暂停测试仅在第二片请求处控制时机并中断请求，其他请求实际到达服务端。

报告：`test-results/browser-source-report/index.html`；失败截图、trace、下载文件：`test-results/browser-source/`。`npm test` 不包含这套浏览器测试，发布验收需同时运行两项。

测试隔离的发布包容器（PowerShell）：

```powershell
docker load -i release/university-homework-1.6.0-linux-amd64.tar
docker run -d --name mohen-browser-release --pull never -p 127.0.0.1::3000 -e JWT_SECRET=browser-release-isolated-secret-123456789 university-homework:1.6.0
docker port mohen-browser-release
# 用上一步输出的实际本机端口；该容器不挂载现有 data 或 uploads。
$env:BROWSER_TEST_BASE_URL = 'http://127.0.0.1:实际端口'
npx playwright test
Remove-Item Env:BROWSER_TEST_BASE_URL
docker rm -f mohen-browser-release
```

外部目标仅允许 localhost/127.0.0.1，必须使用可丢弃测试实例；用例会写入测试课程、账号和作业。发布包报告独立存放在 `test-results/browser-release-report/` 和 `test-results/browser-release/`。同一套用例在两个目标运行不重复计入测试案例数量。

本轮未覆盖真实 NAS 硬件/代理网络、macOS 原生运行、Windows 安装/卸载向导，以及 Firefox/WebKit；不能用 Chromium 结果替代这些平台验收。
