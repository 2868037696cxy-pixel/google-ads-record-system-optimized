# 腾讯云 Ubuntu 部署：账号工作台中央后台（测试阶段）

此文档适用于 Ubuntu 24.04、Node.js 22.13+/24、单台 Linux 实例、多个 Windows Electron 客户端。
**当前仅完成第一阶段连接代码和受控部署准备；正式上线前须整改旧版敏感凭据 / CVV 存储、压测、异地备份与访问控制。**
没有公网网站界面要求，但桌面程序需要一个 **HTTPS 服务端 API 地址**。
不要使用 5900/6080/VNC 端口或把 SQLite 数据库端口直接暴露到公网。

## 1. 低风险安装：不影响 Hermes / OpenCraft / VNC

通过腾讯云控制台终端操作，先检查 `ss -lntp | grep 4317`：必须没有已有服务占用。
不要修改 VNC、SSH、防火墙默认规则。
建议专用非特权系统用户 `adsworkbench` 和独立目录：
```bash
sudo useradd --system --home /var/lib/adsworkbench --create-home --shell /usr/sbin/nologin adsworkbench
sudo mkdir -p /opt/adsworkbench /var/lib/adsworkbench
sudo chown adsworkbench:adsworkbench /var/lib/adsworkbench
sudo chmod 700 /var/lib/adsworkbench
sudo git clone --branch feat/team-console-ui-data-architecture --single-branch https://github.com/2868037696cxy-pixel/google-ads-record-system-optimized.git /opt/adsworkbench
cd /opt/adsworkbench
sudo npm ci --omit=dev
```
仓库若为私有，请用腾讯云终端的经授权 GitHub 获取方式；不要把 GitHub Token 写进脚本/命令行或仓库。安装前请确认剩余空间。

## 2. 仅本地监听的 systemd 服务

创建 `/etc/adsworkbench.env`，文件权限 `root:root 0600`。邀请口令不要用示例值：
```ini
NODE_ENV=production
HOST=127.0.0.1
PORT=4317
DATA_DIR=/var/lib/adsworkbench
REGISTRATION=invite
INVITE_CODE=REPLACE_WITH_PRIVATE_RANDOM_INVITE
SESSION_SECURE=1
DEDUP_ADDRESS_MODE=warn
```
注意：启用 `SESSION_SECURE=1` 后，只能通过 HTTPS 登录，直接浏览 http://127.0.0.1:4317 不适合作为完整登录验收。

创建 `/etc/systemd/system/adsworkbench.service`：
```ini
[Unit]
Description=Ads Workbench (central private backend)
After=network.target

[Service]
Type=simple
User=adsworkbench
Group=adsworkbench
WorkingDirectory=/opt/adsworkbench
EnvironmentFile=/etc/adsworkbench.env
ExecStart=/usr/bin/node /opt/adsworkbench/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/adsworkbench
PrivateTmp=yes
UMask=0077

[Install]
WantedBy=multi-user.target
```
启动：
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now adsworkbench
sudo systemctl status adsworkbench --no-pager
sudo ss -lntp | grep 4317
```
预期只有 `127.0.0.1:4317`，不要设置 `HOST=0.0.0.0`。

## 3. 安全连接（此步骤未自动配置）

由管理员设置 HTTPS 反向代理或经过认证的私有网络入口，代理到 `127.0.0.1:4317`；配置 TLS 证书、访问日志保护、限速与请求体限制。只有通过完整 TLS 校验的 HTTPS 根地址才可配置桌面客户端。
不能使用自签名证书后选择“忽略证书错误”；不要关闭 Electron 证书校验。
反向代理入口域名如 `https://ads.example.com`，将它填到员工桌面程序环境变量 `ADS_WORKBENCH_SERVER_URL`。
桌面端通过受信任 HTTPS 地址登录，数据及 PDF 均留在统一服务端。确保员工电脑能到达该地址。
远程模式没有默认服务地址；**没有配置时仍是旧版单机桌面模式，不能给员工当正式多用户版本使用**。

Windows PowerShell（仅当前窗口，用于测试）：
```powershell
$env:ADS_WORKBENCH_SERVER_URL='https://ads.example.com'
npm run desktop
```
正式分发安装包前应将经过验证的服务地址安全地配置进发布流程；不要向员工提供本机模式安装包。

## 4. 上线门槛

- 修复旧版明文凭据和支付卡 CVV 存储（禁止存储 CVV），复核桌面远程安全边界。
- 3 账号端到端检查本人隔离、异人重复 PDF、企业身份重复、同文件改名、并发提交与断线恢复。
- 仅在服务端保存正式数据。针对 SQLite WAL 通过官方在线备份机制进行异地加密备份，实际演练恢复。
- 检查总磁盘余量（当前约 28GB）、并发 PDF 解析负载及上传上限。
- 公开访问前审查请求来源、登录防爆破、HTTPS 证书、Linux 权限与腾讯云安全组。
