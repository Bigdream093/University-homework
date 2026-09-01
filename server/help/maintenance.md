# GitHub更新、绿联NAS部署与备份
版本：2026.09 统一更新版

## 发布前
本次功能作为一次完整版本更新，不要只复制其中部分文件。先在电脑执行完整测试与前端构建，确认变更清单。不要把data、uploads、.env、账号密码或备份包提交GitHub。
正式服务必须设置TZ=Asia/Shanghai，并设置至少32字节的随机JWT_SECRET；任一安全配置不合格时应用会拒绝启动。应用层时间固定北京时间。旧时间记录原样保留，不按猜测批量平移。

## 更新GitHub
在项目目录打开终端：
```powershell
git status
npm test
npm run build
git add server web Dockerfile docker-compose.yml package.json package-lock.json README.md docs
git diff --cached --stat
git commit -m "feat: complete unified course workflows update"
git push origin main
```
按实际文件清单调整git add；git diff确认没有秘密。若远程有更新，先git pull --rebase origin main并解决冲突、重新测试，再push。不要强制推送覆盖他人提交。推送只更新仓库，不会自动更新NAS容器。

## 绿联NAS一次性重新部署
以下针对当前docker-compose.yml中的university-homework服务，主机34567映射容器3000。若你的实际端口/目录不同，替换成现有配置，不要创建空的数据目录。
1. 在绿联Docker应用记录原项目路径、端口、环境变量、卷挂载与当前镜像。确认宿主目录中的data和uploads对应正在使用的数据，而非同名新目录。
2. 进入维护时间，使用原配置停止原项目容器，防止备份期间有人提交；项目改名前的容器可能仍使用旧名称。
3. 把整个data、uploads、.env、当前代码版本和旧镜像备份到另一位置。SQLite数据库若有-wal/-shm文件一起保留；不要只复制正在写入的主数据库文件。
4. 在NAS项目目录更新代码至已经测试的提交。SSH方式：
```sh
docker compose stop
git pull --ff-only origin main
docker compose config --quiet
docker compose build university-homework
docker compose up -d --no-deps university-homework
docker compose logs --tail=100 university-homework
```
若面板部署：停止原项目→备份→替换完整代码/拉取更新→选择重新构建镜像→使用原挂载与环境重建项目→启动。仅“重启”不会应用新代码。不要删除数据卷，不要执行down -v。
工程改名后服务/容器/镜像为university-homework。先用旧配置停止旧项目，再更新配置；旧容器保持停止用于回退，不要让新旧容器同时挂载同一数据库运行。NAS原数据目录无需改名；若改变项目工作目录，必须将卷挂载明确指向原数据目录的实际绝对路径。保留原.env及端口。新服务名下启动成功前不要删除旧镜像或备份。
5. 环境至少保留不少于32字节且不是示例值的JWT_SECRET、TZ=Asia/Shanghai，以及课程资料上限MATERIAL_UPLOAD_MAX_MB=10240；卷为原data→/app/data、原uploads→/app/uploads。不能用空目录覆盖旧卷。
6. 打开/api/health确认ok且tz_configured为true，再从浏览器登录教师和学生账号验收：原课程原文件仍在、通知阅读计数、资料完整下载、分组提交回执、延期审批、私人问题不能被别的学生读到。
7. 检查通知补发与计划/实际时间；进入教师帮助下载最新版手册。观察容器日志与磁盘空间。
这是迁移升级，会新增表和字段，不清空旧数据库。具体绿联面板名称可能随系统版本不同，以“构建镜像/重建项目”的功能为准。

## 回滚与日常维护
有问题先停止容器，保存出错现场，恢复升级前镜像、代码以及同一时刻的data/uploads备份，再启动。不要让旧代码直接使用已迁移数据库；恢复备份会失去备份以后新增的提交，须提前告知师生。
定期离线备份，至少保留一份NAS之外副本并做恢复演练。检查磁盘余量；文件超过上限应压缩或联系教师调整。
替换/删除产生的文件清理任务会在提交成功后处理，失败自动重试。旧版本无引用文件先隔离，至少保留30天；不得按文件名随意删除学生材料。维护脚本的说明见项目docs，隔离及清除之前必须完成备份。

## 文件空间检查（维护者手动操作）
先备份，在NAS项目目录运行：
```sh
docker compose exec university-homework node scripts/storage-audit.mjs --report
```
需要隔离超过24小时的无引用文件时使用 `--quarantine`，它不直接删除文件。核对隔离记录并确认备份后，才可使用 `--purge-after-30-days` 删除已隔离至少30天的文件。不要在仍有上传或课程复制操作时进行手工隔离维护。

桌面端保持现有下载桥接参数，帮助入口与网页相同。桌面端打印未提供专门支持，界面会提示在浏览器打开网站后打印；手册下载不受影响。
