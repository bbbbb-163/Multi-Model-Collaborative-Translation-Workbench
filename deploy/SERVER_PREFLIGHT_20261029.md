# 生产只读检查与待确认实施方案

检查时间：2026-10-29 18:59–19:08（Asia/Shanghai）。SSH 使用用户指定的 admin 账号和现有 Windows 密钥，经本机 agent 解锁后登录成功，sudo 可用。

**服务器只执行了读取、状态查询和公网健康请求；未上传文件、安装服务、生成凭据、调整 Swap、停止/重建容器、修改生产配置或数据库。** 数据库未通过 SQLite 客户端打开，避免干扰活动中的 WAL。`.env` 和 `vault.key` 的摘要前后相同；两个容器的启动时间未变化，RestartCount 均为 0。

## 实际检查结果

| 项目 | 结果 |
| --- | --- |
| 系统 | Ubuntu 24.04.2 LTS，2 核 |
| 内存 | 系统可见 1613MiB（约 1.58GiB），检查时 MemAvailable 约 904–910MiB |
| Swap | 未配置；vm.swappiness=0；本次未修改 |
| 磁盘 | ext4；剩余 33567MiB（约 32.8GiB），空间充足 |
| Docker / Compose / Buildx | 29.9.2 / 5.6.1 / 0.38.1，已有安装可保留；cgroup v2，资源能力检查无警告；Docker 已设开机启动 |
| 应用 | mstar-workbench-1，healthy，镜像 mstar-workbench:initial，约 117MiB 容器内存 |
| Caddy | mstar-caddy-1，running，约 49MiB 容器内存 |
| 数据挂载 | /opt/mstar/runtime/data → /app/.data，bind，UID/GID 1000:1000，目录 0700 |
| 密钥/环境配置 | vault.key 32 字节、0600；.env 为 root:root、0600；内容未输出、未修改 |
| SQLite | 主文件 4096 字节，WAL 约 1.28MiB；不能只备份主文件 |
| 附件 | 10 个文件，共 32403201 字节（约 30.9MiB） |
| Caddy 持久卷 | mstar_caddy_data、mstar_caddy_config，名称与挂载符合预期 |
| 网络 | 固定容器网段 172.30.42.0/24；应用与 Caddy IP 分别为 .3 / .2；公网监听业务端口为 80/443，SSH 为 22；3210/2019 未发布 |
| 防火墙 | UFW inactive；阿里云侧安全组/轻量防火墙未通过云控制台核验 |
| HTTP | 首页与 /admin 为 200；/api/health 为 200 且 ok=true；未认证 /api/bootstrap 为 401 |
| TLS | 证书校验通过，mstar.chat，Let's Encrypt；到期 2027-01-27 15:24:44（Asia/Shanghai） |
| 时间同步 | NTPSynchronized=yes，符合 Webhook 时间戳校验需要 |
| 自动部署服务 | mstar-hook.service、mstar-deploy.timer 尚不存在；保护配置/队列目录尚不存在 |

当前运行应用镜像不可变 ID：`sha256:5494e266a478d38dbb7166d859d717c1144ae626aabbf49cdfce3cf1248773ca`。镜像没有 Commit 标签，因此不能把 Gitee 当前 main 宣称为线上 Commit；接管时必须保留当前镜像作为旧版本。

## 源码与备份差异

对照了 41 个文件。现有业务源码（server/shared/src）、依赖锁文件、TypeScript/Vite 配置、Dockerfile、compose.yaml、Caddyfile 均一致。

仅 package.json、.dockerignore、deploy/start.sh、deploy/backup.sh 与本次自动部署实现有差异。package.json 的差异严格限定为两个新增本地维护命令 test:deploy / audit:repo，运行/构建脚本、生产及开发依赖均相同。已在本地修正首次接管比较：仅允许这两个内容完全符合预期的维护命令不同；依赖、其他脚本或元数据不同仍拒绝接管。没有覆盖服务器业务源码。

现有备份：`mstar-data-20261029T085724Z-75304.tar.gz`，2026-10-29 16:57，4094 字节。SHA256 校验通过，包含数据库和 vault，但**附件文件为 0**，没有增强清单。因此它不是当前 10 个附件的完整备份，实施前必须重新备份整个数据目录（包括 SQLite/WAL、vault、附件）。账户、配置与记录的完整性验收留待一致性备份及后续升级流程完成，不能只依据文件存在认定已验收。

## 资源方案：已准备本地配置，待批准及云端验证

原构建器 1024MiB / 准入 1250MiB 会在此机安全拒绝部署。现已准备：构建器硬上限 640MiB、CPU 1 核、构建步骤和测试文件单并发、Node 堆 384MiB；准入要求 MemAvailable 至少 896MiB，运行期仍保留 192MiB 内存与 1GiB 磁盘停止线。构建器 memory-swap 与 memory 相等，不使用额外 Swap。

建议保持当前实例规格，**经明确批准后**增加 1GiB `/swapfile.mstar`，权限 0600，并将 vm.swappiness 从 0 调整为 10，作为宿主机缓冲。需要写入 /etc/fstab 及独立 sysctl 配置以在重启后保持；应先检查目标文件不存在，拒绝覆盖已有配置。这不是物理扩容，也不保证准入值立即满足或构建一定通过。参考 [Docker 内存与 Swap 说明](https://docs.docker.com/engine/containers/resource_constraints/)及[构建器资源限制](https://docs.docker.com/build/builders/drivers/docker-container/)。

Windows 本地已验证：384MiB Node 堆下 74 项业务测试单并发通过，生产编译通过，生产启动/持久化测试通过；29 项部署/接管回归通过。Windows 结果不等于 Linux 容器 640MiB 硬上限验证，后者仍须受控实测。

## 分阶段实施与确认边界

1. **备份先行**：在确认的维护窗口，用独立安装目录中的增强脚本完整备份数据，验证归档、数据库、附件、vault 和 SHA256，再恢复原应用并检查 HTTPS。此一致性备份会短暂停止应用，备份失败不得继续；不得把安装包解压覆盖到 /opt/mstar。
2. **经批准调整资源**：建立 1GiB Swap、设置 swappiness=10；不修改现有 SSH、防火墙、Ubuntu、Docker/Caddy 或应用数据，不重启服务器。若不批准 Swap，此步骤跳过，并继续保留资源准入保护。
3. **最小服务准备**：安装 root 保护的控制程序、非 root 接收用户/systemd unit，生成独立的 Gitee 只读部署密钥和随机 Webhook 密钥。此阶段不启用 timer、不启动自动发布、不切换 Caddy/应用。凭据只留服务器受保护目录。
4. **Gitee 只读访问与受控构建**：补充真实数字仓库 ID；管理员在 Gitee 添加只读部署公钥，独立核实主机指纹。保留旧镜像并接管配置；在旧应用继续运行时测试小内存构建及健康监测。构建不得挂载生产数据；若资源门槛不满足或构建失败，停止并保留旧站点，不降低保护线、不自动重试。
5. **另行展示结果并确认切换**：仅在构建与备份实测通过后，确认 Caddy Unix Socket 路由切换、签名 Webhook/timer 启用和首次安全 Push 验收。Caddy 原证书卷保留，.env / runtime/data / vault 不覆盖；核对 Commit、镜像 ID、HTTPS 和生产数据后才宣告正式启用。

阶段 1–4 的生产写入、短暂停服、Swap/sysctl/fstab 和凭据生成均**尚未执行，等待用户明确确认**。阶段 5 需在展示准备结果后再次确认。没有任何端到端部署成功声明。
