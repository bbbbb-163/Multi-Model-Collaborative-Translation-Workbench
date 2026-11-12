# 生产自动部署实施进展

> 后续状态：部署公钥只读访问已通过，真实 Gitee Ping 已验签成功，接收器已完成 Ping/查询参数修复。当前首发前置检查与剩余步骤见 [FIRST_DEPLOY_PREFLIGHT.md](FIRST_DEPLOY_PREFLIGHT.md)；下文保留初次服务器准备时的记录。

2026-10-29，Asia/Shanghai。用户已明确授权本次直接实施，无需逐项确认。仓库 `mcxy8/mstar.chat`，数字 ID `51151819`。

## 已在生产服务器完成

- admin SSH 登录与 sudo 可用，保留既有登录方式。
- 完整一致性备份：`/opt/mstar/backups/mstar-data-20261029T121017Z-88156.tar.gz`。归档、SQLite、附件、vault 和 SHA256 验证通过；应用恢复 healthy。
- 对比备份前后：管理员密码记录、1 个供应商连接、1 个分发密钥、3 个上架模型、3 个任务、18 条消息、10 个附件均保留；`.env` 和 vault 摘要一致。未输出任何真实秘密。
- 数据及配置已保存站外，位于 Windows `C:\Users\bu\.codex\mstar-production-backups`，目录 ACL 限定当前用户、SYSTEM、Administrators。两份归档均与服务器 SHA256 一致。配置归档包含可解密凭据的敏感材料，不得上传 Gitee。
- 已创建 `/swapfile.mstar`，1GiB，0600；vm.swappiness=10，fstab/sysctl 持久化完成。修改前 fstab 和原参数备份在 `/opt/mstar/backups/system-before-autodeploy-20261029T121100Z`。
- root 保护的控制程序及配置安装完成，独立 Gitee 部署密钥和随机 Webhook 签名密钥已生成，不复用 Windows 登录密钥。
- Gitee SSH 主机键与本机事先存在的 known_hosts 信任记录独立比对一致，已固定到 `/etc/mstar-deploy/known_hosts`，严格校验开启。
- `mstar-hook.service` 已启动并设置开机启动；Unix Socket 接收器没有 Docker 权限或公网监听端口。
- 配置 systemd tmpfiles 保证重启后 socket 目录先存在，即便停用自动部署，Caddy 的 bind 挂载也不会因 `/run` 清空而丢失。
- Caddy 配置已通过无网络独立容器验证并切换专用路由；原证书卷保留，业务域名、后台和 HTTPS 正常。
- `https://mstar.chat/__gitee_deploy` 实际 HTTPS 测试：GET=405，错误签名=401，其他分支/非 Push/删除分支/零 SHA=422，错误仓库 ID=403。
- 接收配置严格要求 `repository.id=51151819`、正确仓库路径/SSH URL、Push/main。通过的事件审计会记录已经校验的 repository_id，不记录签名或原始 Payload。

## 构建实测通过

在旧网站继续运行时，使用独立 BuildKit：内存 640MiB、memory-swap 同为 640MiB、CPU 1 核、Node 堆 384MiB、构建与测试文件单并发。

74 项业务测试、生产编译、1 项生产启动与持久化测试全部在真实 Linux Docker 构建中通过。镜像 `mstar-workbench:git-e6d2ec3e59b93f2957bfdfccec63182657318fd1` 已构建，ID `sha256:9d9906fb99dc7184484823e99e2b7294514339f9aaf0aba414a5d9b53d077b2b`；测试后构建器已停止释放资源。构建和临时测试没有挂载生产数据。

本地部署/接管回归更新为 31 项通过。额外修复：停服备份在私有数据库副本上生成清单，避免 root 在生产目录新建 WAL/SHM；Caddy 预验证不用继承固定 IP 的 compose run，避免与正在运行的 .2 地址冲突。

**构建镜像尚未替换应用。当前应用仍是原来的 `mstar-workbench:initial`，没有可验证 Commit 标签，不能把构建成功当作已上线。**

## 当前未完成的 Gitee 管理配置

- 专用新部署公钥尚未在 Gitee 仓库授权：使用该密钥只读访问仍返回 `Permission denied (publickey)`。
- 本机现有 Git 登录可以推送代码，但不能认证 Gitee 管理 API；没有把本机可写 Git 凭据复制到服务器。
- Gitee 签名 Webhook 尚未创建/核验，**尚未观察到真实 Gitee Payload，不能宣称实际 repository.id 已验收**。
- `mstar-deploy.timer` 保持 disabled；正式 adopt 及其版本状态尚未完成，避免未验证平台事件导致发布。

服务器新公钥位于 `/etc/mstar-deploy/gitee_ed25519.pub`，Windows 便于复制的公钥文件位于 `C:\Users\bu\.codex\mstar-production-backups\gitee-deploy.pub`（公钥可公开，私钥不可）。

在 Gitee 仓库管理添加该公钥为**只读部署公钥**后，服务器执行：

```bash
sudo python3 -I /usr/local/lib/mstar-deploy/worker_entry.py adopt
sudo python3 -I /usr/local/lib/mstar-deploy/worker_entry.py status
```

Gitee Webhook 地址为 `https://mstar.chat/__gitee_deploy`，仅选 Push/main、JSON、签名密钥、SSL 校验开启。密钥在服务器 `/etc/mstar-deploy/webhook.json`，只在自己受控终端读取并粘贴到 Gitee，不发聊天或工单。

先保持 timer 停用，测试真实 Gitee 投递，核对其 Payload 中的 `repository.id=51151819`，并核对接收审计。通过后才启用 timer，用不改变业务的小提交完成真实 Push、线上 Commit、健康、数据及回滚验收。

## 状态结论

服务器基础设施、备份、资源调整、接收路径及真实受限构建已完成；Gitee 私有仓库读权限与真实 Webhook 投递/自动切换尚未完成。**尚未通过完整端到端验收，自动发布没有正式启用。**
