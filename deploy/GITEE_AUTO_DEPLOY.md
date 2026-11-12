# Mstar：Gitee Webhook 自动部署操作手册

适用：现有 Ubuntu 24.04、2 核 / 2GB、Docker Compose 项目 `mstar`，域名 `mstar.chat`，已有生产数据 `/opt/mstar/runtime/data`。这是增量接管，不能按全新服务器初始化。

## 1. 当前交付边界与执行顺序

本地实现、协议测试和模拟故障测试可以验证代码逻辑，不能替代云端 Docker/systemd/Gitee 的验收。**只有第 8 节真实 Push、线上 SHA、HTTPS 和生产数据检查全部通过，才算正式启用。** 当前执行记录见 [AUTO_DEPLOY_VALIDATION.md](AUTO_DEPLOY_VALIDATION.md)及[生产实施进展](PRODUCTION_AUTO_DEPLOY_STATUS.md)。

严格顺序：本地审查 → 本地开发测试 → 首次上传私有仓库（不启用 Webhook）→ 经确认后生产备份/安装/接管 → 配置 Webhook → 安全提交真实验收。生产安装、生成凭据、代理切换与首次真实发布均须由管理员确认；本文的服务器命令是供确认后执行的操作说明。

## 2. 架构与信任边界

```text
Windows Git push → Gitee 私有仓库 main
                         │ HTTPS POST /__gitee_deploy
                         ▼
                   现有 Caddy :443
                         │ 只读挂载 /run/mstar-hook 目录，Unix Socket
                         ▼
             mstar-hook 非 root Python 进程
             签名 / 时效 / 仓库 / Push / main / SHA 校验
                         │ SQLite 去重 + 原子持久化 latest.json，立即返回 202
                         ▼
            systemd timer 每 15 秒唤醒固定 root worker
            全局 flock → 固定 Gitee SSH origin 拉取 main
            → 合并到最新有效 main → 兼容性与资源检查
            → 限制资源的 Docker BuildKit 中运行测试/构建
            → 暂停旧应用并完整备份 → 恢复旧应用并检查
            → 仅替换 workbench → 容器/内部接口/公网 HTTPS/数据校验
            → 保存 SHA、镜像 ID、旧版本与结果
```

接收器没有 Docker Socket、sudo、部署私钥或代码目录访问权，也不运行 shell。队列只包含随机事件 ID、SHA、接收时间；root worker 再次验证 SHA 属于固定 origin 的 main。Gitee 签名不绑定整个 JSON 正文，所以不能把通过验签的正文视为任意代码执行授权。

连续推送合并到拉取时的最新 main，日志 `coalesced_to_main_tip` 记录事件 SHA 和选择的 SHA。构建过程中到达的新事件保留在队列，下次 timer 处理。乱序旧事件也必须是当前 main 的祖先；不是祖先的 SHA、已删除或被改写的 main 都不会部署。收到 202 只表示已入队，不表示已上线。

控制程序、构建 Dockerfile、构建忽略规则、systemd、Compose 快照在 `/usr/local/lib/mstar-deploy`、`/etc/mstar-deploy`，由 root 管理；**不会从每次 Push 自动更新**。候选仓库中的脚本和 Compose 不在宿主机执行。数据初始化、认证/加密代码、检测到的 SQLite/DDL/迁移代码及部署设施变化都会进入人工处理。静态保护不能代替对业务代码数据写入逻辑的审查。

## 3. Windows 本地：首次上传与敏感文件检查

仓库地址已经由用户提供：`https://gitee.com/mcxy8/mstar.chat.git`；用户确认其为私有仓库。不要上传 `.env`、`.data`、runtime、数据库、vault、上传文件、备份、发布压缩包、node_modules 或 SSH 私钥。

**执行位置：Windows 本地 PowerShell**

```powershell
Set-Location -LiteralPath 'D:\mcxy\模型工作台1'
git status --short --branch
git remote -v
git ls-remote --symref origin
npm test
npm run test:deploy
npm run build
node tests/production-smoke.mjs
git add .
python scripts/audit-repository.py
git diff --cached --stat
# 扫描退出码必须为 0，检查暂存内容后再提交。
git commit -m "Add protected Gitee webhook deployment"
git push -u origin main
git fetch origin main
git rev-parse HEAD
git rev-parse origin/main
```

首次实施时已将空的本地 HEAD 指向 `main`，配置了真实 origin；不要重复 `git remote add`。新电脑克隆：`git clone https://gitee.com/mcxy8/mstar.chat.git`。Windows 登录 Gitee 用自己的账号与已有凭据管理器；遇到认证提示在本机处理，不把凭据写进 URL、命令历史或聊天。

如果远程出现 README 或其他提交，先 `git fetch origin`、`git log --all --graph --oneline`，核对后合并（无共同历史时用 `git merge origin/main --allow-unrelated-histories`，远程正式分支若是 master 则使用该分支）；解决冲突、重跑检查，再正常推送。**禁止 force push**。

扫描包括暂存文件、普通提交历史以及 Codex 本地检查点中的内容；已逐项复核的合成测试密码有窄范围豁免。本地检查点 refs 不应推送，仅推送 `main`。扫描是启发式检查，仍需审阅 diff。若发现真实历史密钥，立即停止推送、先撤销/轮换密钥，再协商历史清理；不能靠 `.gitignore` 补救。

**执行位置：Gitee 网页**

仓库管理中保持“私有”；确认默认分支 `main`，收紧成员权限及 main 保护规则，只授权维护者推送或合并。初次上传阶段不要启用 Webhook。

## 4. 经确认后：只读检查与上传安装文件

**执行位置：Windows 本地 PowerShell**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\package-release.ps1
$package = Get-ChildItem .\release\mstar-*.tar.gz | Sort-Object LastWriteTime -Descending | Select-Object -First 1
scp $package.FullName ($package.FullName + '.sha256') root@47.250.178.171:/tmp/
```

使用你现在能够登录阿里云的 SSH 方式，保留现有 SSH 账号、私钥和规则。发布包按白名单生成，不含本机数据库或凭据。

**执行位置：阿里云 Workbench / SSH 服务器**

```bash
sudo -i
cd /tmp
archive=$(find /tmp -maxdepth 1 -type f -name 'mstar-*.tar.gz' -printf '%T@ %p\n' | sort -nr | head -n 1 | cut -d' ' -f2-)
test -n "$archive"
sha256sum -c "${archive}.sha256"
setup_dir=$(mktemp -d /opt/mstar-auto-setup.XXXXXXXX)
tar -xzf "$archive" -C "$setup_dir"
bash "$setup_dir/deploy/inspect-auto-deploy.sh"
```

这里解压到**独立安装目录**，不要覆盖 `/opt/mstar`。检查输出必须确认：应用与 Caddy 正常、项目名 mstar、数据 bind 为 `/opt/mstar/runtime/data`、两个 Caddy 卷仍存在、3210 没有公网监听、磁盘余量合理、Docker/Compose/Buildx 已安装。把检查结果交给维护者确认后才进行下一节。缺少工具时只安装缺少的 `git/python3/curl/util-linux/openssh-client`，不重装 Docker/Caddy/Ubuntu。

2026-10-29 实机检查发现系统实际可见内存约 1613MiB、可用约 904MiB、没有 Swap，原 1024MiB 构建器 / 1250MiB 准入预算不适用。已在本地准备小内存配置：`MemAvailable >= 896MiB`（640MiB 构建预算 + 256MiB 余量），代码/数据/Docker 所在文件系统至少 `4096MiB + 2 × 数据体积` 可用；BuildKit 限制 640MiB、禁用构建器额外 Swap、1 核 CPU、构建步骤及测试文件并行度均为 1、Node 堆 384MiB。运行期监测宿主机至少保留 192MiB 内存和 1GiB 磁盘，低于阈值终止构建。旧应用继续运行；构建器在结束后停止释放内存。**这些资源上限尚待云端受控构建验证，不能保证构建一定成功，也不能直接启用自动发布。**

Swap 只做 `swapon --show` 检查。针对当前机器，实施方案建议在取得明确确认后增加 1GiB Swap，作为宿主机缓冲；构建器仍不能使用额外 Swap。Swap 不等于新增物理内存，启用后也不保证 `MemAvailable` 立刻达到准入值。安装程序不会修改 Swap；不得随意降低资源阈值来强行构建。若受控构建不能在预算内通过，保留旧版本，另行决定构建或服务器资源方案。

实机 vm.swappiness 当前为 0。若采用 Swap 方案，调整到 10 及其持久化配置也必须明确确认；本次只读检查未作修改。完整实机结果及阶段确认边界见 [SERVER_PREFLIGHT_20261029.md](SERVER_PREFLIGHT_20261029.md)。

## 5. 经确认后：安装、专用密钥及接管

**执行位置：Gitee 网页**

准备真实数字仓库 ID（仓库信息或 Webhook 测试投递详情里的 `repository.id`）；不能用显示名称代替。若找不到，先向仓库管理员查询，勿猜测。ID 是非敏感配置。

**执行位置：阿里云 Workbench / SSH 服务器**（沿用上一节 root shell 的 `$setup_dir`）

```bash
read -r -p 'Gitee 数字仓库 ID: ' repo_id
bash "$setup_dir/deploy/install-auto-deploy.sh" mcxy8/mstar.chat "$repo_id"
cat /etc/mstar-deploy/gitee_ed25519.pub
```

安装程序第一步先运行增强的现有备份脚本；备份失败立即退出并尝试恢复旧应用。随后创建专用无登录用户、root 保护的控制程序/配置、随机 256 位 Webhook 密钥和独立 Ed25519 Gitee 部署密钥，安装 unit，但**不启动接收器、timer 或切换 Caddy**。现有 `.env`、生产目录和 Caddy 证书卷保留。重复运行会拒绝覆盖既有凭据和状态。

**执行位置：Gitee 网页**

目标仓库 → 管理 → 部署公钥，添加上面 `.pub` 的内容，使用**只读部署公钥**；不要把它添加成有全局写权限的个人公钥。不要上传私钥。Windows 登录阿里云的私钥与这个文件完全独立。

**执行位置：阿里云 Workbench / SSH 服务器**

先通过 Gitee 官方支持、管理员确认的已有信任记录等独立渠道取得**当前主机 SHA256 指纹**，然后执行：

```bash
read -r -p '独立核实的 Gitee 主机 SHA256 指纹: ' gitee_fingerprint
bash "$setup_dir/deploy/trust-gitee-host.sh" "$gitee_fingerprint"
GIT_SSH_COMMAND='ssh -F /dev/null -i /etc/mstar-deploy/gitee_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/mstar-deploy/known_hosts' \
  git ls-remote git@gitee.com:mcxy8/mstar.chat.git refs/heads/main
sudo python3 -I /usr/local/lib/mstar-deploy/worker_entry.py adopt
sudo python3 -I /usr/local/lib/mstar-deploy/worker_entry.py status
```

`ssh-keyscan` 只是采集候选公钥；脚本只接受与独立核实指纹匹配的键。不能把同一次扫描的结果当作独立核实，不使用 `StrictHostKeyChecking=no`。

接管会核对服务器业务源码与 Gitee main 一致（`package.json` 仅允许预期的两个本地维护命令 `test:deploy` / `audit:repo` 不同；运行/构建脚本、依赖及其他元数据仍须一致），记录当前运行镜像的不可变 ID、保留 `adopt-*` 标签、冻结 Compose（含绝对数据路径、原网络和 Caddy 卷），再次备份并检查健康。**旧镜像没有可验证的 Commit 标签时，线上 commit 记录为 null，`baseline_source_sha` 仅表示源码基线，不能冒充已上线 SHA。** 首次受控部署后才有真实线上 Commit。

业务源码不一致或数据路径不同则停止，不自动覆盖。此时核对当前生产发布包和本地差异，由维护者决定源码整合方式。

## 6. 经确认后：接通 Caddy，暂不执行自动部署

**执行位置：阿里云 Workbench / SSH 服务器**

```bash
sudo systemctl enable --now mstar-hook.service
sudo systemctl status mstar-hook.service --no-pager
sudo python3 -I /usr/local/lib/mstar-deploy/worker_entry.py activate-proxy
curl -fsS https://mstar.chat/api/health
curl -sS -o /dev/null -w '%{http_code}\n' https://mstar.chat/__gitee_deploy
sudo docker volume inspect mstar_caddy_data mstar_caddy_config --format '{{.Name}} {{.Mountpoint}}'
```

这一步会验证配置并短暂重建 Caddy 容器，属于真实代理切换，须先确认。应用容器不替换，Caddy 的原命名卷不变；失败时尝试恢复原代理配置。专用 GET 返回 405；业务网站、后台和 HTTPS 仍应正常。

接收器只监听 Unix Socket，禁止额外开放公网管理端口。systemd 保留 socket 目录 inode，Caddy 只读挂载该目录，接收器重启时仍可重建 socket。Caddy 镜像按现有配置使用 root 访问 socket；若自定义了容器 user、user namespace 或 rootless Docker，需要人工核对权限，不能用暴露 TCP 端口绕过。

## 7. Gitee 网页：配置并验证 Webhook

仓库 → 管理 → WebHooks → 添加：

| 字段 | 设置 |
| --- | --- |
| URL | `https://mstar.chat/__gitee_deploy` |
| 请求格式 | JSON / application/json |
| 事件 | 仅 Push（推送代码），分支过滤 main（若页面提供） |
| 密钥类型 | **签名密钥**，不能选明文密码模式 |
| 密钥 | 服务器 `/etc/mstar-deploy/webhook.json` 的 secret |
| SSL 校验 | 开启 |

**执行位置：阿里云 Workbench / SSH 服务器**：仅在你自己的受控终端读取用于粘贴的密钥，不发到聊天或工单：

```bash
sudo python3 -c 'import json; print(json.load(open("/etc/mstar-deploy/webhook.json"))["secret"])'
sudo journalctl -u mstar-hook -n 50 --no-pager
```

Gitee 官方签名是 `Base64(HMAC-SHA256(secret, timestamp + "\n" + secret))`，通过 `X-Gitee-Token` 传递，`X-Gitee-Timestamp` 为毫秒；实现接受原始及 URL 编码 Base64，常量时间比较，采用更紧的 ±5 分钟窗口。服务器时间必须同步。Payload 必须是 Push/main、`deleted=false`、40 位非零 SHA，`repository.id`、`path_with_namespace` 和规范 `ssh_url` 同时匹配。显示用 `full_name` 不作为身份。

先保持 timer 停用。Gitee 页面“测试”会发送 `X-Gitee-Ping: true`，可使用 `refs/heads/test_version` 和样例仓库数据。适配后的接收器在签名/时效校验通过时仅返回 `200 {"status":"pong"}`，记录 `ping_authenticated`，不写部署队列、不执行任务；这只能确认联通与认证，不能作为真实仓库 ID 或 main 部署验收。

真实 Push（不带 Ping 标记）仍必须通过仓库 `51151819`、main、非删除、有效 SHA 等全部校验，首次入队为 202，重复事件为 200 duplicate。正式启用前，要在 timer 关闭时核对真实 Push Payload 的仓库 ID。接收器只比较 URI 的路径部分，查询参数不参与路由，认证仍使用请求头。不要记录完整请求头或原始 Payload，它们可能包含签名或密码字段。上述兼容补丁须先安装到服务器，旧接收器尚不支持 Ping 应答。

## 8. 首次真实验收（需确认启用后执行）

**执行位置：阿里云 Workbench / SSH 服务器**：确认前述检查无误并保留一份站外备份后启用：

```bash
sudo systemctl enable --now mstar-deploy.timer
sudo systemctl list-timers mstar-deploy.timer
sudo journalctl -u mstar-deploy -f
```

**执行位置：Windows 本地 PowerShell**：添加一行不改变业务功能的发布验收记录，检查后真实 Push。不要用空提交代替对文件上传一致性的验收。

```powershell
Add-Content -LiteralPath .\deploy\ACCEPTANCE.md -Value ('Production acceptance push: ' + (Get-Date -Format o))
git add deploy/ACCEPTANCE.md
python scripts/audit-repository.py
git commit -m "Verify Gitee deployment pipeline"
git push origin main
git rev-parse HEAD
```

**执行位置：阿里云 Workbench / SSH 服务器**：

```bash
sudo python3 -I /usr/local/lib/mstar-deploy/worker_entry.py status
sudo journalctl -u mstar-hook -u mstar-deploy --since '30 minutes ago' --no-pager
curl -fsS https://mstar.chat/api/health
sudo docker inspect --format '{{.Image}} {{json .State.Health}}' "$(sudo docker compose -f /etc/mstar-deploy/compose.json ps -q workbench)"
sudo docker image inspect "mstar-workbench:git-$(sudo python3 -c 'import json; print(json.load(open("/var/lib/mstar-deploy/state.json"))["current"]["commit"])')" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
```

必须核对 `current.commit` 等于本地 HEAD、`live_image_id` 等于记录的镜像 ID、`last_result=deployed`，无 blocked 或 transaction；HTTPS、后台登录、用户密钥登录、模型目录、历史任务、附件访问正常，管理员密码/API Key 密文/分发密钥/模型配置及 vault 校验通过。自动检查在切换前后的 SQLite 只读事务中比较配置行摘要、任务/消息/文件 ID 集合、全部已有附件 SHA256 和 vault SHA256，备份中保存基线；不输出秘密。正常的管理员改配置或用户删除记录也可能触发保守拒绝，验收期间避免这些操作。

还需真实演练：其他分支、错误签名、非 Push、错误仓库、重复事件；受控构建失败时旧站点正常；受控新容器不健康时旧镜像恢复；证书卷仍存在、HTTPS 正常。故障注入必须经确认，在维护窗口或等价预生产环境执行，不要直接破坏生产数据。

在 [AUTO_DEPLOY_VALIDATION.md](AUTO_DEPLOY_VALIDATION.md) 填入实际 SHA、时间、备份路径、数据验收、负责人。所有这些完成前保持状态“待生产环境验收”。

## 9. 日常更新、版本、日志与故障

**执行位置：Windows 本地 PowerShell**

```powershell
npm test
npm run test:deploy
npm run build
git add .
python scripts/audit-repository.py
git commit -m "Describe the change"
git push origin main
```

**执行位置：阿里云 Workbench / SSH 服务器**

```bash
sudo python3 -I /usr/local/lib/mstar-deploy/worker_entry.py status
sudo systemctl status mstar-deploy.service mstar-deploy.timer mstar-hook.service --no-pager
sudo journalctl -u mstar-deploy -n 200 --no-pager
sudo journalctl -u mstar-hook -n 100 --no-pager
sudo docker compose -f /etc/mstar-deploy/compose.json logs --tail=100 workbench
```

状态查询无需等待部署锁，能在构建期间查询旧线上版本。systemd `active/running` 表示 worker 运行；journal 展示当前构建阶段。`failed` 的 Git/资源/测试/构建/备份失败不替换容器；修复网络/权限/资源后可 `sudo python3 -I /usr/local/lib/mstar-deploy/worker_entry.py retry`，不会无限重试同一个失败事件。构建详细输出在 journal；Git 错误不回显凭据，必要时用第 5 节固定 SSH 命令单独诊断。

`manual_required` 或存在 transaction 时自动处理停止，后续事件仍可入队，最终一次不会被静默删除。先检查日志及实际容器/数据，不要反复 unblock。数据库/加密/部署设施变化需要人工审查、迁移兼容性验证、明确恢复方案和受控发布；没有通用的“忽略保护自动上线”开关。不要手工删状态文件来绕过检查。

人工升级时先停用自动部署、备份，针对具体迁移制定并确认发布/恢复计划；部署设施升级还需审查并更新 root 保护副本。**人工发布及业务/数据验收已完成之后**，执行 `sudo python3 -I /usr/local/lib/mstar-deploy/worker_entry.py rebaseline` 更新基线。它要求当前健康容器已经带有与固定 Gitee main 一致的真实 Commit 标签，会再次备份，记录新 schema/保护摘要，保留 blocked 等待单独 unblock；不会构建、上线候选版本或执行迁移。旧保护契约或旧 schema 的镜像不能作为自动回滚目标。

## 10. 人工回滚与中断恢复

**执行位置：阿里云 Workbench / SSH 服务器**：先在 Gitee 禁用 Webhook，再停止 timer，等待当前 worker 完成：

```bash
sudo systemctl disable --now mstar-deploy.timer
sudo systemctl is-active mstar-deploy.service
# 上条仍为 active 时先查看日志，等待完成；停止 timer 不会强杀正在构建的任务。
sudo python3 -I /usr/local/lib/mstar-deploy/worker_entry.py status
sudo python3 -I /usr/local/lib/mstar-deploy/worker_entry.py rollback
```

`rollback` 先备份，核对旧镜像 ID、兼容保护记录和已验证 schema，只恢复应用镜像并验证健康与数据；**不恢复数据库、不动 Caddy、不重建旧镜像标签**。完成后设置 blocked，防止队列立即把它升级回去。

切换中断、启动失败且自动回滚失败，或者发现 `transaction.json` 时：

```bash
sudo python3 -I /usr/local/lib/mstar-deploy/worker_entry.py recover
```

`recover` 只在 schema/vault 未变化、记录数据仍保留时恢复事务里的旧镜像；不安全时拒绝并要求人工处理。断电或 SIGKILL 后不会盲目继续部署。备份中断且旧容器仍处于停止状态时，systemd ExecStopPost 在无切换事务、镜像身份一致的情况下尝试重新启动原应用。

确认修复、健康和数据正确，并决定处理队列里的 main 后才执行：

```bash
sudo python3 -I /usr/local/lib/mstar-deploy/worker_entry.py unblock
sudo systemctl enable --now mstar-deploy.timer
```

再在 Gitee 恢复 Webhook。若 `unblock` 后同事件已标记失败，按意图使用 `retry`；不要默认重试不兼容迁移。

## 11. 数据备份、保留与恢复

**执行位置：阿里云 Workbench / SSH 服务器**：增强现有 `deploy/backup.sh`，冻结配置接管后使用保护副本：

```bash
sudo env MSTAR_PROJECT_DIR=/opt/mstar MSTAR_COMPOSE_FILE=/etc/mstar-deploy/compose.json \
  MSTAR_DATA_GUARD=/usr/local/lib/mstar-deploy/data_guard.py \
  bash /usr/local/lib/mstar-deploy/backup.sh /opt/mstar/backups
```

备份与部署共用排他锁。暂停 workbench 后生成 SQLite/配置记录/附件/vault 清单，打包整个生产数据，验证归档内每个附件与 vault、临时副本上的 SQLite quick_check 及所有数据行摘要，再生成并验证 `.sha256`。EXIT/INT/TERM 都尝试恢复原应用并等待健康；失败阻止部署。正在执行的任务会中断，完整附件较大时暂停时间也较长，应安排空闲窗口。

worker 额外生成 `.config.tar.gz` 和 SHA256 JSON，包括生产 `.env`、保护配置/部署凭据、Compose/Caddy 配置、版本状态。它含私钥，权限必须保持 root 私有并备份至受保护站外存储。现有 Caddy 证书卷保留原位，不在每次部署时复制或覆盖活跃证书文件。

成功部署后按策略最多保留 3 份数据备份及配套配置，超 14 天的旧备份可提前淘汰，但至少保留最新 2 份；按唯一标签保留当前和上一个已验证自动部署镜像，保留首次接管标签。只删除自有备份及自有镜像标签，不执行全局 prune，不删除任何卷。磁盘不足时部署安全停止，需要转移站外备份并人工清理已确认不需的副本。

**恢复必须人工确认，在无部署运行时进行。执行位置：阿里云 Workbench / SSH 服务器**

```bash
sudo -i
systemctl disable --now mstar-deploy.timer
systemctl is-active mstar-deploy.service
read -r -p '要恢复的数据归档完整路径: ' archive
sha256sum -c "${archive}.sha256"
python3 /usr/local/lib/mstar-deploy/data_guard.py verify "$archive"
restore_dir=$(mktemp -d /opt/mstar-restored.XXXXXXXX)
tar -xzf "$archive" --exclude=.mstar-backup-manifest.json -C "$restore_dir"
chown -R 1000:1000 "$restore_dir"
chmod 700 "$restore_dir"
docker compose -f /etc/mstar-deploy/compose.json stop workbench
# 原子修改保护配置的数据 bind，并保持已验证镜像，绝不使用 .env 里的 initial 标签。
python3 - "$restore_dir" <<'PY'
import json, os, sys
sys.path.insert(0, '/usr/local/lib/mstar-deploy')
from common import atomic_json
path='/etc/mstar-deploy/compose.json'
c=json.load(open(path))
volume=next(v for v in c['services']['workbench']['volumes'] if v['target']=='/app/.data')
volume['source']=sys.argv[1]
c['services']['workbench']['image']=json.load(open('/var/lib/mstar-deploy/state.json'))['current']['image']
atomic_json('/etc/mstar-deploy/restore-compose.json',c)
PY
# 若备份属于旧 schema，应先选择与该备份匹配的已验证镜像，再执行启动。
docker compose -f /etc/mstar-deploy/restore-compose.json up -d --no-deps --no-build --pull never --wait workbench
curl -fsS https://mstar.chat/api/health
```

旧数据目录和原配置始终保留。恢复后不要启用自动部署：worker 固定要求原生产数据路径，会拒绝新的恢复路径。核验账户、密钥、附件、数据兼容性后，由维护者设计回迁到原路径或受控修改保护配置/固定路径/版本基线，再恢复自动部署。恢复配置归档时也先解到独立私有目录逐项核对，不能直接覆盖 `/etc` 或生产 `.env`。

**禁止**清空数据、单独替换 vault、向运行中的数据目录覆盖解压、`docker compose down -v`、删除 Caddy 卷或用 `start.sh` 重建旧回滚标签。

## 12. 禁用、恢复与凭据轮换

**执行位置：Gitee 网页**：先禁用 Webhook，可继续正常 Git 版本管理。

**执行位置：阿里云 Workbench / SSH 服务器**

```bash
sudo systemctl disable --now mstar-deploy.timer
sudo systemctl disable --now mstar-hook.service
# 网站继续运行；Webhook 路径会暂时返回 502。需要时审核后恢复旧代理配置。
```

恢复时先启动接收器、检查 socket/HTTPS，检查队列和 blocked 状态，确认待部署的 main 是期望版本，再启用 timer 和 Gitee Webhook。停用期间没有投递的 Push 不会自动补发；恢复后在 Gitee 重送最新合法 Push，或创建一个已检查的小提交。

轮换 Webhook 密钥（先暂停 Gitee Webhook 和 timer，保留当前部署完成）：

```bash
sudo python3 - <<'PY'
import os, sys, secrets
sys.path.insert(0, '/usr/local/lib/mstar-deploy')
from common import read_json, atomic_json
path='/etc/mstar-deploy/webhook.json'
info=os.stat(path)
c=read_json(path); c['secret']=secrets.token_hex(32)
atomic_json(path,c,mode=0o640)
os.chown(path,info.st_uid,info.st_gid)
PY
sudo systemctl restart mstar-hook.service
```

在自己终端读取新 secret，更新 Gitee 为签名密钥，测试投递后恢复 timer。密钥不进入仓库或日志；更新完成后清理剪贴板。

轮换 Gitee 部署密钥（同样先停用自动部署并等 worker 完成）：

```bash
sudo ssh-keygen -t ed25519 -N '' -C mstar-gitee-readonly-rotation -f /etc/mstar-deploy/gitee_ed25519.next
sudo cat /etc/mstar-deploy/gitee_ed25519.next.pub
```

Gitee 网页添加新的只读部署公钥，在服务器用新 key 和同一已核实 known_hosts 执行 `git ls-remote` 验证，然后由 root 在该目录内保存旧 key 为 `.previous`、将 `.next` 和 `.next.pub` 移到正式文件名，权限设 600，最后在 Gitee 删除旧部署公钥。不要动服务器登录用的 SSH 私钥；确认新 key 生效后再处理旧 key 的受保护备份。Gitee 主机密钥轮换必须重新独立核实指纹，不能关闭严格验证。

## 13. 官方协议参考

- [Gitee 签名算法](https://help.gitee.com/webhook/how-to-verify-webhook-keys)
- [Gitee 请求头与 Push Payload](https://help.gitee.com/webhook/gitee-webhook-push-data-format)
- [Gitee 添加 WebHook](https://help.gitee.com/webhook/how-to-add-webhook)
- [Docker Buildx 独立构建器资源限制](https://docs.docker.com/build/builders/drivers/docker-container/)
- [Caddy Unix Socket 反向代理](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

## 14. systemd 下的 Docker / Buildx 客户端目录

worker 保留 `ProtectHome=yes`、`PrivateTmp=yes` 和 `NoNewPrivileges=yes`。unit 显式设置 `DOCKER_CONFIG=/var/lib/mstar-deploy/docker` 与 `BUILDX_CONFIG=/var/lib/mstar-deploy/docker/buildx`，并通过 `StateDirectory` / `StateDirectoryMode=0700` 管理目录；安装脚本也按 root:root 0700 创建目录。客户端状态不依赖 `/root/.docker`，不改变 Docker daemon 的数据根目录或业务数据挂载。

修复既有安装时，先停用 timer 并确认 worker inactive，备份原 unit 和 Buildx 实例元数据。只迁移已核验的 `mstar-autodeploy` 实例定义：节点应指向本机 Unix socket，资源限制与已安装构建器一致，内嵌配置不得引用 `/root`；目标实例已存在时须先核验，不能盲目覆盖。保留旧客户端目录、构建容器、镜像及缓存；不迁移无关 registry 凭据。

执行 `daemon-reload` 后，不启动 worker。用同等 systemd 隔离与资源限制验证目录可写、`buildx inspect`、Compose 配置解析及只读 `ps`、备份脚本语法和健康检查。资源准入通过后，可仅启动受限 BuildKit，并用 `FROM scratch` 的无网络小上下文及 `--output=type=cacheonly` 验证构建会话；不加载镜像、不运行 Mstar 代码、不挂载生产数据，完成后停回构建器。

生产配置中不要为此关闭 `ProtectHome` 或改用整项目 `compose up`。设施修复须纳入 Git；若尚未推送，后续测试前须在批准后先同步修复，并审查更新发生变化的设施保护摘要，保留线上镜像、schema、历史和失败事件记录，不能借此运行 `rebaseline` 冒认旧镜像的 Commit。目录验证不等于再次部署授权，timer 始终保持 disabled/inactive，真实业务构建与切换另行批准。

- [Docker 客户端配置目录](https://docs.docker.com/reference/cli/docker/)
- [Buildx 状态目录查找顺序](https://docs.docker.com/build/building/variables/#buildx_config)

## 15. 运行文件权限与切换前启动关卡

两份 Dockerfile 对清单文件使用 `COPY --chown=0:0 --chmod=0644`，仅将镜像内的 build、dist、node_modules 规范为所有用户可读、目录可遍历的代码权限，随后切换 `USER node` 执行读取检查。宿主机 `UMask=0077`、SQLite、vault、.env、证书和生产数据目录权限不变；不能对整机或数据目录递归放宽权限。

worker 在构建完成并停止 BuildKit、资源检查通过后，调用 root 安装的 `candidate.py`。通过后才允许一致性备份、事务写入和生产容器切换。此关卡不是构建阶段的 root 冒烟测试：它启动不可变候选镜像的默认生产命令，固定 `--user node`，检查实际 UID/GID=1000、全部运行目录/文件可读、真实 Docker 健康检查及首页、管理页和健康接口。

验证使用独立随机容器名与 Compose 标签、network=none、无端口发布、只读根文件系统、256MiB/0.5核限制和临时合成 SQLite/vault。不会读取、复制或挂载生产数据、.env、凭据、Caddy 卷；合成管理员占位记录避免生成初始化码。容器 restart=no，验证失败立即停止发布，不执行生产备份、替换或重试。

启动 stdout/stderr、全部检查命令及错误输出、容器 inspect 和 result.json 保存在 `/var/lib/mstar-deploy/candidate-checks/` 的 root 私有目录，移除验证容器前先收集日志。正常或失败均清理且只清理本次拥有的验证容器和合成数据；清理或日志捕获失败也不能放行生产切换。日志可包含候选程序输出，按敏感文件保管，不向公开页面输出。

升级安装的 worker.py、Dockerfile.auto 时必须同时安装 candidate.py；现有安装脚本的 *.py 规则已包含它。设施源码须纳入 Git，并在发布前审查对应保护摘要变化；本地验证成功不等于授权生产部署或启用 timer。
