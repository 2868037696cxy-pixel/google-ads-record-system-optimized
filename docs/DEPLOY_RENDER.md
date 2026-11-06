# Render 工作台部署与迁移

部署分支：`deploy/render-workbench`。Blueprint 文件：仓库根目录 `render.yaml`。
创建独立服务 `adsworkbench-persistent`，不接管现有免费服务，也不切换现有域名。

## 创建服务

1. 在 Render 的 My Workspace 中创建 Blueprint，选择本仓库和 `deploy/render-workbench` 分支，文件路径 `render.yaml`。
2. 核对新服务名、Singapore 区域、0.5 CPU / 512 MB、5 GB 持久磁盘挂载到 `/var/data`。价格以创建页面为准；磁盘服务仅运行一个实例，更新会短暂中断。
3. 在 Render 私密输入框填写 `ADS_SECRETS_KEY_HEX`：必须是旧工作台正在使用的原加密密钥文件中的 64 位十六进制值。不要生成替代密钥，不要粘贴到聊天、Git 或构建命令。
4. Apply 后等待部署完成。构建使用固定 Node 22.22.2、生产依赖和完整服务器测试；启动时再次检查挂载、路径和密钥。Render 原生 `PORT` 保持由平台分配。
5. 验证 `/api/healthz`、`/login`，以及未登录访问 `/api/bootstrap` 返回 401。注册暂时关闭，新服务没有旧账号和数据，不能据此宣称迁移完成。

## 持久数据与密钥

| 内容 | 位置 |
| --- | --- |
| 当前数据库 | `/var/data/workbench/workbench.sqlite`，迁移后可指向另一个同盘文件 |
| 个人备份任务和临时档案 | `/var/data/workbench/backup-tasks` |
| 原加密密钥 | `/var/data/private/secret.key`，权限 0600 |
| 加密数据库备份 | `/var/data/backups`，只在创建并验证成功后保留最近 7 份 |

启动时创建并验证一次加密 SQLite 原生备份，随后每运行 24 小时再执行一次。备份异步进行，不阻止 HTTP 监听；失败会记录错误。进程优雅退出会等待正在执行的备份和数据库关闭。
同盘备份可以恢复误操作，但不是异地备份。应另外安全转存加密档案，原密钥单独保管。不要用文件系统磁盘快照替代 SQLite 原生备份。

## 迁移旧服务器

1. 先在旧服务生成并验证 `.awbdb` 全库加密快照，备份原 env、原密钥和必要的外部文件。最后一次快照前安排暂停写入，避免切换期间出现两套独立数据。
2. 用 Render 支持的 SCP/SFTP 或 Magic-Wormhole 安全传输快照到新服务持久磁盘的 `/var/data/incoming/`。不要公开上传快照，不要把传输口令或密钥写入日志。
3. 在新服务 Shell 中用现有 `scripts/backup.cjs restore` 恢复到一个**全新路径**，例如 `/var/data/workbench/migrated.sqlite`。命令需要设置 `ADS_SECRETS_KEY_FILE=/var/data/private/secret.key`；不得覆盖正在使用的数据库。恢复工具会校验认证标签与 SQLite integrity_check。
4. 将 Render 的 `DB_FILE` 改为刚恢复的路径，保存并部署。保持 `REGISTRATION=closed`。启动会检查数据库的 vault_key_id 与原密钥是否一致；不一致应停止排查，不应更换密钥。
5. 用原账号核查资源和记录数量、用户隔离、敏感字段解密、营业执照/PDF、导出、个人备份与恢复；执行一次重启并重复核对，确认持久化真实生效。
6. 验收后再配置 `ads.fbsoso.xin` 的自定义域名、DNS 和 `PUBLIC_ORIGIN=https://ads.fbsoso.xin`。当前 Blueprint 只使用 Render 自动提供的域名，没有修改生产 DNS。
7. 如需邀请注册，在 Dashboard 私密配置原 `INVITE_CODE`，再将 `REGISTRATION` 改为 `invite`。迁移结束前保持旧服务器可回退；新平台开始接受写入后，回退还需要核对新增数据，不能只改 DNS。

Render 插件当前不提供添加磁盘和创建/同步 Blueprint 的操作。因此首次创建需要在 Dashboard 完成；之后可通过插件读取部署状态和日志进行验收。连接插件不等同于已创建或已部署服务。
