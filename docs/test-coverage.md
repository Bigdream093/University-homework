# 测试覆盖分工

删除重复中间层后，测试按风险归属维护；不再用模拟组件宿主连接真实服务器重复整条学生流程。

| 覆盖点 | 维护位置 |
|---|---|
| 学生业务规则、角色权限、次数及回执 | `server/test/unified-workflows.test.js` 等现有服务端测试 |
| 会话越权、错误摘要、缺片拒绝、物理清理 | `server/test/upload-sessions.test.js` |
| 分片完成幂等、资料与文件关联、资料取消 | `server/test/upload-sessions.test.js` |
| 分片完成响应丢失后恢复、立即暂停取消、缓存和重复运行 | `web/test/chunked-upload-client.test.js` |
| 普通上传流式摘要与超时 | 原 `server/test/upload-streaming.test.js`，保持独立 |
| 普通上传客户端重试 | 原 `web/test/upload-client.test.js`，保持独立 |
| 成绩纯计算及小数边界 | `web/test/grade-scores.test.js` |
| UI 交互、个人/小组链路、8 MB 续传、页面与 Excel 一致 | 现有浏览器测试，未扩充重复流程 |

## 本次删减

- 删除学生中间层的个人、小组、在线作答与暂停续传完整流程。
- 将其独有的协议和完成响应丢失断言迁入服务端及前端测试。
- 删除资料上传中间层三条链路：资料创建/关联/取消由服务端小数据案例检查，8 MB 分片与实际续传继续由现有浏览器测试检查。
- 删除通过源码截取函数的成绩一致性测试；现有纯计算测试吸收平时全部待评及小数权重案例，浏览器继续检查实际显示和 Excel。
- 删除中间层 package 文件和 `test:integration` 脚本；根目录 `npm test` 不再调用该层。

## 运行方式

日常完整检查：`npm test`。发布浏览器验收：`npm run test:browser`。

本次仅运行迁移及调整涉及的三个文件，未运行全量测试或浏览器测试：

```sh
node --test server/test/upload-sessions.test.js web/test/chunked-upload-client.test.js web/test/grade-scores.test.js
```

其中包含服务端 4 项、前端分片客户端 2 项、成绩计算 7 项，共 13 项，全部通过。性能未做同条件对照，不声称具体加速比例。
