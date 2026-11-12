# 阿里云上线操作指南

> **已有生产环境注意**：mstar.chat 已经初始化。本文第 1–5 节保留为首次安装记录，请勿在现有服务器重新初始化、替换 `.env` 或数据目录。Gitee 自动部署接管与日常更新请使用 [deploy/GITEE_AUTO_DEPLOY.md](deploy/GITEE_AUTO_DEPLOY.md)。自动部署接管后不要再直接运行旧的 `start.sh` 重建镜像标签。

本次目标：Ubuntu 22.04 / 24.04、阿里云马来西亚（吉隆坡）、全新初始化。

| 项目            | 本次配置                                     |
| --------------- | -------------------------------------------- |
| 访问地址        | **https://mstar.chat**                       |
| 管理后台        | **https://mstar.chat/admin**                 |
| 服务器公网 IPv4 | **47.250.178.171**                           |
| 服务器项目目录  | `/opt/mstar`                                 |
| 数据目录        | `/opt/mstar/runtime/data`                    |
| 运行方式        | Docker Compose：Node 应用 + Caddy HTTPS 代理 |

2026-10-29 本机 DNS 查询确认 `mstar.chat` 的 A 记录已指向 `47.250.178.171`。域名解析已完成，无需再改老板的记录。本次不迁移电脑里的 `.data`，不增加费用控制、订阅或收费功能。以下命令标明了在**电脑**还是**服务器**执行。

## 1. 在阿里云控制台放行访问端口

登录阿里云控制台，进入 **云服务器 ECS → 实例**，选择 **马来西亚（吉隆坡）** 地域并打开该服务器。确认公网 IP 为 `47.250.178.171`，系统为 Ubuntu。

打开实例关联的 **安全组 → 入方向规则 → 添加规则**，配置允许访问：

| 协议 | 端口 | 来源                                      | 用途                |
| ---- | ---- | ----------------------------------------- | ------------------- |
| TCP  | 80   | `0.0.0.0/0`                               | HTTP 跳转、证书验证 |
| TCP  | 443  | `0.0.0.0/0`                               | HTTPS 网站          |
| UDP  | 443  | `0.0.0.0/0`                               | HTTP/3，可选        |
| TCP  | 22   | 你电脑的公网 IP `/32`，或保留已有可用规则 | SSH 登录与文件上传  |

不要开放 3210 或 Caddy 管理端口。应用容器没有对公网映射 3210。不要删除当前可用的 SSH 规则。如果你买的是轻量应用服务器，在实例的「防火墙」中放行对应端口。

如果服务器启用了 UFW，登录后先运行 `sudo ufw status` 查看状态；仅在已启用时补充 `sudo ufw allow 80/tcp`、`sudo ufw allow 443/tcp`。这份指南不要求启用 UFW 或改变现有 SSH 策略。

阿里云官方说明：[安全组规则](https://www.alibabacloud.com/help/en/ecs/user-guide/security-group-rules)、[域名 A 记录](https://help.aliyun.com/zh/dns/pubz-add-website-parsing)。吉隆坡属于中国内地以外地域，本指南按海外节点部署，不走中国内地服务器的 ICP 接入备案流程；地域与备案的对应关系参见[阿里云备案说明](https://help.aliyun.com/zh/icp-filing/basic-icp-service/support/for-the-record-process-faq)。

## 2. 登录服务器

阿里云实例详情中点击 **远程连接 → Workbench**，按控制台提示登录。也可以在自己电脑的 PowerShell 中执行：

```powershell
ssh root@47.250.178.171
```

首次连接先核对主机信息，再接受 SSH 指纹，密码在终端提示时输入。若实例登录用户是 `ubuntu` 等其他用户名，将后续 SSH/SCP 命令中的 `root` 换成实际用户名。服务器上需要管理员权限的命令已经带 `sudo`，root 也可以照常执行。

在**服务器终端**确认系统和端口：

```bash
cat /etc/os-release
sudo ss -lntp '( sport = :80 or sport = :443 )'
```

新服务器通常没有服务占用 80/443。如果显示已有 Nginx、Apache 或其他服务，先确认用途；不要直接关闭未知服务。这套配置需要占用这两个端口。

## 3. 从电脑上传准备好的发布包

本项目已提供不含本机数据、密钥及依赖目录的发布包，位于电脑项目的 `release` 目录。

需要重新打包时，在**电脑 PowerShell**执行：

```powershell
Set-Location -LiteralPath 'D:\mcxy\模型工作台1'
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\package-release.ps1
```

在**电脑 PowerShell**上传最新发布包及校验文件：

```powershell
Set-Location -LiteralPath 'D:\mcxy\模型工作台1'
$package = Get-ChildItem .\release\mstar-*.tar.gz | Sort-Object LastWriteTime -Descending | Select-Object -First 1
scp $package.FullName ($package.FullName + '.sha256') root@47.250.178.171:/tmp/
```

输入服务器登录密码，等待上传结束。若没有启用密码登录，使用你已配置的 SSH 密钥；不要把私钥或密码发到聊天里。

在**服务器终端**解压：

```bash
cd /tmp
archive=$(find /tmp -maxdepth 1 -type f -name 'mstar-*.tar.gz' -printf '%T@ %p\n' | sort -nr | head -n 1 | cut -d' ' -f2-)
test -n "$archive"
sha256sum -c "${archive}.sha256"
sudo install -d -m 0750 /opt/mstar
sudo tar -xzf "$archive" -C /opt/mstar
cd /opt/mstar
```

校验应显示 `OK`。若你使用 `ubuntu` 用户且项目目录由 root 创建，可用 `sudo -i` 进入 root 管理终端，再 `cd /opt/mstar` 继续操作。

## 4. 安装 Docker 并启动

下面全部在**服务器的 `/opt/mstar` 目录**执行。

安装脚本按 Docker 官方 Ubuntu 软件源安装 Docker Engine 和 Compose 插件；发现已有 Docker 时保留现有安装，发现冲突软件包时停止并提示。

```bash
sudo bash deploy/install-docker-ubuntu.sh
sudo apt-get install -y python3
sudo cp -n .env.example .env
sudo chmod 600 .env
sudo cat .env
```

确认 `DOMAIN=mstar.chat`。示例配置已填写你的域名，首次上线无需编辑。这里没有 API Key，后续到后台添加模型连接。不要把 `DOMAIN` 写成 IP、`https://mstar.chat` 或带路径的地址。

```bash
sudo bash deploy/start.sh
```

首次会下载基础镜像、安装锁定依赖并构建，耗时取决于服务器网络和规格。脚本会创建 UID/GID 为 1000 的私有数据目录、验证 Caddy 配置、构建镜像并等待应用健康检查。容器设置了自动重启，关闭 SSH 终端不会关闭网站。服务器重启后 Docker 会自动恢复容器。

Caddy 自动申请、续期 HTTPS 证书，并将 HTTP 跳转到 HTTPS。证书首次签发可能在容器启动后继续进行，查看：

```bash
sudo docker compose ps
sudo docker compose logs --tail=80 caddy
```

技术依据：[Docker Ubuntu 安装](https://docs.docker.com/engine/install/ubuntu/)、[Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https)、[Caddy 反向代理与流式响应](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)。配置保留公开 Host、覆盖客户端伪造的转发头、关闭代理响应缓冲，并允许最长 30 分钟的上游等待。

## 5. 检查网站，再初始化管理员

在**服务器**执行：

```bash
curl -fsS https://mstar.chat/api/health
curl -I http://mstar.chat
curl -s -o /dev/null -w '%{http_code}\n' https://mstar.chat/api/bootstrap
```

预期依次为 `{"ok":true}`、HTTP 到 HTTPS 的跳转、`401`（未登录不能读取工作台）。然后在自己电脑浏览器打开 **https://mstar.chat/admin**，应看到管理员初始化页且浏览器证书正常。

从**服务器**读取首次初始化码：

```bash
sudo docker compose exec -T workbench cat /app/.data/admin-setup.txt
```

把显示的码填入网页，设置至少 12 位的管理员密码。完成后初始化码文件会删除，再运行读取命令提示文件不存在是正常现象。云端是全新账户，不沿用电脑上的管理员密码。

进入后台后依次完成：

1. 「模型连接」添加实际 API 地址和上游 API Key，获取模型。
2. 「模型上架」选择要开放的模型与能力，逐项测试，全部成功后上架。测试会真实调用上游模型。
3. 「分发密钥」创建 Mstar 密钥、指定模型授权，并当场复制保存。
4. 在浏览器隐私窗口打开 **https://mstar.chat**，用该密钥登录，发送消息并验证流式显示。
5. 验证你需要的附件上传、图片/视频生成、播放下载、顺序流程和刷新恢复。

管理员后台和用户工作台分别登录。不要把供应商 API Key 当成 Mstar 登录密钥发给使用者。

## 6. 备份、更新与回滚

在**服务器 `/opt/mstar`** 运行：

```bash
sudo bash deploy/backup.sh
```

脚本短暂停止应用，使 SQLite、附件和 `vault.key` 一致后打包，再恢复原本运行的应用。正在进行的任务会中断，请在空闲时执行。备份保存到 `/opt/mstar/backups/`，同时生成 SHA-256 校验文件。它包含可解密凭据的密钥，需要放到你控制的受保护存储，并另存一份到服务器之外。

普通更新：先备份，再上传新发布包并解压到 `/opt/mstar`。发布包不含 `.env` 和 `runtime`，不会覆盖生产配置或数据。用 `sudo nano .env` 把 `APP_IMAGE` 改成新的唯一版本，例如 `mstar-workbench:20261101-1`，然后运行 `sudo bash deploy/start.sh`。保留旧镜像及旧发布包。

只回滚程序时，把 `.env` 中的 `APP_IMAGE` 改回旧镜像标签，然后：

```bash
sudo docker compose up -d --no-build --wait
```

不要在此时运行 `start.sh`，否则会用新源码重新构建旧标签。数据库结构若已变化，须同时按对应版本恢复备份；新版本启动前务必备份。

数据恢复请使用**新的空目录**：先 `sudo docker compose stop workbench`，把备份解压到新目录，检查里面包含 `workbench.sqlite`、`vault.key`、`files/`，将目录及内容所有者设为 `1000:1000`，在 `.env` 中把 `WORKBENCH_DATA_DIR` 指向新目录，再 `sudo docker compose up -d --no-build --wait`。旧数据目录保留，核验成功前不要删除。不要把备份覆盖解压到正在运行的数据库上。

不要运行 `docker compose down -v`，它会删除证书数据卷。也不要删除 `runtime/data` 或单独替换 `vault.key`。数据库和加密密钥必须配套保存。

## 7. 常见问题

| 现象                             | 检查方法                                                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 网页打不开/超时                  | 确认阿里云安全组 80/443 已放行，`sudo docker compose ps` 中服务已运行。                                              |
| HTTPS 证书失败                   | 查看 Caddy 日志；确认域名 A 记录仍指向本服务器、80/443 可从公网访问。存在错误 AAAA 或 CAA 记录时请让域名管理员核对。 |
| `port is already allocated`      | 80/443 被占用，运行第 2 步的 `ss` 命令确认服务用途。                                                                 |
| `Permission denied` / 应用不健康 | 查看 `sudo docker compose logs --tail=80 workbench`；确认数据目录归 UID/GID 1000 且可写。不要用 `chmod 777`。        |
| Docker 下载失败                  | 检查服务器出网、DNS 和到 Docker Hub/npm 官方源的连通性，保留错误信息排查。                                           |
| Docker 网络地址重叠              | `172.30.42.0/24` 被现有网络占用时，需同步调整 Compose 中的子网、两个固定容器 IP 和可信代理 IP。                      |
| 后台登录后工作台仍要求密钥       | 这是独立会话设计；用分发密钥登录，或在后台明确进入「管理员工作空间」。                                               |

目前已在本机验证生产编译、生产启动和自动化回归。云端 Docker 构建、端口开放、证书签发及真实供应商调用需要在上述服务器上完成，容器健康不等于这些步骤全部通过。
