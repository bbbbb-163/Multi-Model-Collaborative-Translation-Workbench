# 自动部署实施与验收记录

日期：2026-10-29，Asia/Shanghai。

## 实施前事实

- 本地路径：`D:\mcxy\模型工作台1`；原 Git HEAD 为未产生提交的 master，无正式提交、远程地址或已跟踪文件。
- 发现 Codex 本地检查点 tree refs，已纳入内容扫描；不向 Gitee 推送这些内部 refs。
- 用户提供实际 origin：`https://gitee.com/mcxy8/mstar.chat.git`，并确认仓库已设为私有。
- 首次 `git ls-remote --symref` 成功、退出码 0，远程没有任何分支或提交；无需覆盖、变基或整合远程初始化内容。
- 本地改为 main，保留现有 Git 身份；没有配置新令牌、改写凭据或使用 force push。
- 首次安全提交 `21a4ae8` 已通过现有本机凭据推送到 Gitee `main`；后续打包排除规则作为普通增量提交继续推送。最终本地/远程 SHA 一致性见交付回复。
- 只读公网检查 `https://mstar.chat/api/health` 返回 `{"ok":true}`。
- 最初 SSH 因本机加密私钥尚未解锁而认证失败；用户随后在 Windows 本机解锁。2026-10-29 以 admin 成功完成生产只读检查，结果见 [SERVER_PREFLIGHT_20261029.md](SERVER_PREFLIGHT_20261029.md)。没有服务器写入、服务切换、Swap 修改或凭据生成。

## 本地通过项目

| 验证 | 结果及范围 |
| --- | --- |
| `npm test` | 74/74 通过，现有业务与安全回归 |
| `npm run build` | TypeScript、Vite 前端与生产后端编译通过 |
| `node tests/production-smoke.mjs` | 1/1 通过，临时数据中的生产启动、HTTPS Cookie 行为、隔离、附件与重启持久化 |
| `python -m unittest discover -s tests -p test_auto_deploy.py -v` | 31/31 通过，真实本地 HTTP + 临时 SQLite/附件 + 模拟 Docker/Git/systemd 边界；含接管窄范围差异、构建限制、停服数据库副本与无固定 IP 的代理预验证 |
| 384MiB Node 堆验证 | 74 项业务测试单并发、生产编译、1 项生产启动/持久化测试均通过；未替代云端 640MiB 容器硬上限实测 |
| Python 编译 | `deploy/auto` 和仓库扫描程序通过 compileall |
| Bash 语法 | Git for Windows Bash 对新增脚本及修改的 start/backup 逐一 `bash -n` 通过 |
| 敏感扫描 | 暂存区、普通提交历史及本地检查点内容未发现配置规则覆盖的真实密钥；匹配的测试密码逐项确认是合成夹具 |
| `.gitignore` | 排除数据库/WAL/日志、vault、初始化码、环境配置、私钥、数据/上传/备份、依赖、构建及发布产物 |
| 发布打包 | 按现有白名单打包通过；生产数据和凭据不进入包，发布包保留在本地 release 目录 |

27 项部署回归覆盖：Gitee 原始/URL 编码签名、错误密钥/过期时间/错误分支/事件/仓库、删除分支/非法 SHA/体积限制、快速 HTTP 确认且不调用系统命令、持久去重与最新事件、SQLite/配置记录/附件/vault 清单和归档篡改、缺失数据时拒绝初始化、成功部署状态/旧镜像保留、网络/Git/测试构建/资源/备份失败不切换、启动及健康失败回滚、schema 变化阻止不安全回滚、迁移保护、重复任务、构建中新 Push 不遗漏、中断事务保护、备份保留数量、低内存/磁盘、源归档符号链接防护、镜像标签身份变化、部署中状态查询、竞争锁及恶意队列；额外验证人工重设基线不能批准未上线候选版本或抹除中断事务。

本地部署回归中的 Docker/SSH/systemd 操作使用模拟。随后已通过 admin SSH 在真实生产服务器完成受限 Docker 构建、备份、Swap、接收服务及代理路径验证，见 [生产实施进展](PRODUCTION_AUTO_DEPLOY_STATUS.md)。这仍不等于 Gitee Webhook 到线上切换的端到端验收通过。

## 文件交付清单

新增：

- `deploy/GITEE_AUTO_DEPLOY.md`：完整中文安装、接管、Gitee、验收、维护和恢复流程。
- `deploy/AUTO_DEPLOY_VALIDATION.md`、`deploy/ACCEPTANCE.md`：本地事实与待生产验收记录。
- `deploy/install-auto-deploy.sh`、`inspect-auto-deploy.sh`、`trust-gitee-host.sh`：安装、只读检查、独立指纹匹配。
- `deploy/auto/common.py`、`receiver.py`、`receiver_entry.py`：持久队列、安全接收及隔离入口。
- `deploy/auto/worker.py`、`worker_entry.py`：固定 root 部署控制、锁、受限构建、健康、事务与回滚。
- `deploy/auto/data_guard.py`：只读数据清单、归档内容校验、SQLite 完整性。
- `deploy/auto/configure.py`、`config.example.json`：仅由明确安装动作生成服务器私有配置和凭据。
- `deploy/auto/Dockerfile.auto`、`buildkitd.toml`：固定构建与资源约束；安装时还把根目录 `.dockerignore` 复制为保护库中的 `dockerignore`。
- `deploy/auto/Caddyfile`、`mstar-hook.service`、`mstar-deploy.service`、`mstar-deploy.timer`：Unix Socket 代理及进程管理。
- `scripts/audit-repository.py`、`tests/test_auto_deploy.py`：上传前扫描与部署回归。

修改：`.gitignore`、`.gitattributes`、`.dockerignore`、`package.json`、`deploy/backup.sh`、`deploy/start.sh`、`scripts/package-release.ps1`、`README.md`、`DEPLOYMENT.md`。原业务代码、SQLite 实现、Compose 拓扑、域名和前端未改动。发布打包在现有白名单之上排除 Python 缓存、私钥、数据库及私有部署配置，避免新测试产生的缓存进入归档。

## 待生产环境验收（尚未执行）

- [x] 已通过用户解锁的 SSH 完成只读检查，确认内存/磁盘、Docker/Buildx、真实挂载及证书卷；发现内存预算及旧备份覆盖不足，待批准下一阶段。
- [ ] 管理员确认安装及凭据生成；完整数据备份成功，并另存站外。
- [ ] 添加只读 Gitee 部署公钥，独立核实/固定 Gitee 主机指纹；私有 main 可读。
- [ ] 接管已有镜像与源码，确认生产 .env、原数据目录和 Caddy 卷保持不变。
- [ ] 管理员确认 Caddy 代理切换，Unix Socket 连通，原站点/后台/HTTPS 正常。
- [ ] 配置 Gitee 签名 Webhook，错误请求拒绝，重复请求去重，入队快速确认。
- [ ] 管理员确认启用 timer；通过不改变业务的小提交完成首次真实 Push。
- [ ] 限制资源的真实 Docker 构建/测试通过；仅 workbench 切换；镜像标签、Commit SHA、不可变 ID 一致。
- [ ] 容器、内部接口、公网 HTTPS、管理员/用户登录、模型、历史、附件与 vault 数据验证通过。
- [ ] 构建失败旧站点仍正常；新容器不健康时安全回滚；不兼容 schema 阻止自动回滚。
- [ ] 填写真实完成时间、SHA、备份路径、故障演练证据与验收人。

**系统状态：本地实现及服务器准备已完成，Gitee 读权限/实际 Payload 核验待完成，自动发布未启用，尚未完成端到端验收。**

仓库上传结果以最终交付回复及 `git rev-parse HEAD` / `git ls-remote origin refs/heads/main` 的一致性核对为准。不要把“代码推送成功”解释为“生产部署成功”。
