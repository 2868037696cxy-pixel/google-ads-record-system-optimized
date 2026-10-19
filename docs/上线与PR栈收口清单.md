# 上线与 PR 栈收口清单

> 生成于 2026-10-19，对应《AdsWorkbench_Optimization_Plan_2026-10-19.docx》的工作包
> 01 / 04 / 08 / 09 / 10。本文只写已核验的事实；任何我没有实际验证过的环节，都明确标注
> **【待你确认】**，请不要把它当成已验证结论。

---

## 一、当前的真实结构（已核验）

用 `gh pr list --state all` 与 `gh pr view 4` 得到的权威结果：

```
codex/workbench-quality                          ← 栈根，不是 main
  └─ PR #1  feat/multiuser                        base=codex/workbench-quality  非草稿
       └─ PR #3  feat/team-console-ui-data-architecture   base=feat/multiuser   草稿
            └─ PR #4  fix/authz-bypass-1.2.0        base=feat/team-console-ui-data-architecture  草稿
```

PR #4 的状态：`mergeable: MERGEABLE`，`mergeStateStatus: UNSTABLE`，`isDraft: true`。

**两条结论：**

1. **即使四个 PR 全部合并，也不会有任何内容到达 `main`。** 整条链终止在
   `codex/workbench-quality` 这个非 `main` 分支上。这是"改了很多但线上没变"的结构性原因。
2. **四个 PR 里有三个是草稿**（PR #1 除外）。草稿 PR 不会被合并，也就不会触发任何部署。

**因此：在收口之前，继续合并代码不会改变任何线上事实。**

---

## 二、收口动作（按顺序执行）

> 下面命令中的 `--repo` 可省略，前提是当前目录已经是仓库根。
> 我没有在远端执行过这些操作 —— 改基分支与合并属于你的权限决定，我不代为操作。

### 第 1 步：把栈根接到 `main`

二选一。**推荐 A**，因为它不改写既有 PR 的语义。

- **A. 把 PR #1 的基分支改指 `main`**，让整条链直接落在主线上：
  ```
  gh pr edit 1 --base main
  ```
- **B. 保留 PR #1 的基分支，改为先把 `codex/workbench-quality` 合进 `main`**：
  ```
  git switch main && git pull
  git merge --no-ff origin/codex/workbench-quality
  git push origin main
  ```
  **【待你确认】** `codex/workbench-quality` 是否还有独立价值。若它只是临时分支，
  选 A 更干净。

改完基分支后，回到 PR 页确认 diff 只包含你预期的那批提交 ——
**改基分支会让 diff 重新计算，这是唯一容易出意外的时刻。**

### 第 2 步：取消草稿

```
gh pr ready 3
gh pr ready 4
```

### 第 3 步：按依赖顺序合并

顺序不能颠倒：**1 → 3 → 4**。因为上游未合并时，下游 PR 的 diff 里会夹着上游的提交。

```
gh pr merge 1 --merge
gh pr merge 3 --merge
gh pr merge 4 --merge
```

**【待你确认】** 团队是否要求 squash。若要求，用 `--squash`；但请注意 PR #4 的 12 个提交
各自带独立证据（性能基线、并发档位、实测输出），squash 会把这些信息压成一条。

### 第 4 步：核验 `main` 上真的包含修复

```
git fetch origin && git log --oneline origin/main -15
```

应当看到这 12 个提交（或 squash 后的一条）。重点确认这两项在 `main` 上存在：

- `server.js` 的 `onRequest` 钩子：鉴权判断基于 `decodeURIComponent(rawPath)`，
  而不是 `req.url`；
- `server.js` 里 `resolveDefaultOwner()` 在非桌面分支下**抛错**，不再回退到"第一个用户"。

**最可靠的方式是跑回归测试，而不是读代码**（见第三节）。

---

## 三、回归验证（可在任何机器上执行，不需要真实环境）

### 3.1 全量测试

```bash
node --test --test-concurrency=1 tests/*.test.js
```

预期：**78 项全通过**。`--test-concurrency=1` 是必须的，串行执行。

基线对照（供判断"是不是我引入的"）：

| 阶段 | 用例数 |
|---|---|
| 1.2.0 原始基线（048c9f4） | 65 |
| 本会话完成后 | 78 |

### 3.2 鉴权绕过回归（第 0 优先级的那个漏洞）

这条必须用**原始 socket** 验证，不能用 `fetch`：`fetch` 无法构造 absolute-form 请求行，
且 URL 解析会重写百分号编码 —— 用它测会得到假阴性。

要验的两个攻击形态：

1. **absolute-form 请求行**：`POST http://<host>/api/backup/restore`；
   修复前它整段跳过 `onRequest` 鉴权钩子。
2. **编码路径**：`GET /%61pi/bootstrap`；
   修复前鉴权按未解码的 `req.url` 判断，而路由按解码后的路径匹配。

判定标准：两者都必须**被鉴权拦下**（401/403），而不是返回数据。

**这条测试的价值在于它可证伪**：把 `server.js` 的鉴权判断改回 `req.url`，测试应当失败。
如果你跑出来仍然通过，说明修复没真正生效。

### 3.3 前端渲染验证

```bash
node scripts/ui-render.cjs
```

预期输出里包含这三行（都是脚本里的硬断言，不达标会直接抛错）：

```
默认入口: {... "page":"main page-records" ...}
冻结编号列: {"scrollable":true,"scrolledTo":228,"offsetBefore":51,"offsetAfter":34}
列显隐: {"before":14,"after":13,"stored":["idcard"],"menuStillOpen":true}
```

截图输出在 `.shots/`（该目录已被 `.gitignore` 忽略）。

---

## 四、上线前你必须自己确认的（我在本机无法验证）

以下每一项我都**没有**在真实环境验证过，因此只给"怎么验"，不给结论。

### 4.1 网络暴露面（最高优先级）

- **应用端口必须只监听 127.0.0.1**，由 Cloudflare Tunnel 对外。
  验：`ss -lntp | grep <端口>`，确认是 `127.0.0.1:<端口>` 而非 `0.0.0.0:<端口>`。
  **如果看到 `0.0.0.0`，不要上线** —— 那等于绕过 Tunnel 直接暴露。
- **【待你确认】** 实际监听端口。我此前记录为 4317，但这是从代码/文档读到的，
  没有在服务器上验证过。

### 4.2 环境变量（每一项都要确认"上线环境里真的设了"）

| 变量 | 作用 | 设错/不设的后果 |
|---|---|---|
| `REGISTRATION` | `open` / `invite` / `closed` | 不设时的默认值**【待你确认】** |
| `INVITE_CODE` | `invite` 模式必填 | 不设或仍为 `REPLACE_...` 时，**进程会拒绝启动**（这是有意的 fail-fast） |
| `PUBLIC_ORIGIN` | 启用来源校验 | 不设时 `restore` 少一层防护（仍受"敏感操作解锁"保护） |
| `DATA_DIR` | 数据与数据库位置 | 指向错误目录会连到空库，看起来像"数据丢了" |

**验 `REGISTRATION` 的实操**：在生产域名上试注册一个账号。
- 想要开放注册 → 应成功；
- 想只允许受邀 → 应失败并要求邀请码。

### 4.3 备份与恢复（工作包 04）

**恢复演练必须真的做一次，不能只看备份文件存在。** 备份没验证过就等于没有备份。

- 备份文件在哪、多久备一次、保留多久 —— **【待你确认】**
- **【待你确认】** 加密密钥单独保管的具体方式。评论：密钥与备份放在同一台机器上，
  等于没加密。
- 恢复演练：在一台**隔离机器**上用备份恢复，确认账号、记录、营业执照、PDF 原文
  都能读出来，且**归属关系正确**（A 的记录仍属于 A）。

### 4.4 Windows 安装包与版本管理（工作包 08）

- **【待你确认】** 是否已经产出安装包，以及客户端是否指向生产地址。
- 客户端里**不能**出现任何明文凭据。
- **【待你确认】** 版本回滚方式。

### 4.5 监控与日志（工作包 09）

- **日志**：已有 `tests/log-hygiene.test.js` 在本地覆盖明文凭据检查（导入邮箱与卡号、
  敏感操作解锁、`reveal=1` 取明文、导出 AdsPower、读审计），断言密码 / 2FA / 卡号 /
  账号口令都不落进日志流，并带一道反空转断言。
  **但仍建议在真实日志上再抽查一次**：生产的日志级别、采样与输出目标与测试不同。
- 确认有办法知道"服务挂了"和"磁盘快满了"。

### 4.6 分批上线（工作包 10）

建议顺序：**先只让自己用一个账号跑通全流程 → 再放 1~2 个真实同事 → 再全员**。
每一档之间至少隔一天，因为**跨用户查重和 PDF 去重是全局的**，
这两个是唯一"一个人操作会影响别人"的地方，问题最容易在这里暴露。

---

## 五、已知的遗留问题（我明确没有解决的）

请不要以为这个清单之外就没有事了。以下是我发现但未修复的：

1. **`origin/trae/agent-ctCMlg` 分支的 `.uploads/` 里有一个 534 KB 的已签名个人 PDF，
   位于公开仓库中。** 这需要改写 git 历史（或至少删除该分支）才能清除。
2. **记录列表前端仍走 `/api/bootstrap` 全量快照**，服务端分页已经做好但未接上。
   并发压测显示延迟随并发近似线性增长（1 并发 8ms → 50 并发 197ms），
   说明请求基本串行，**减少每请求工作量是首要优化，而非加机器**。
3. **1.2.0 的 `restore` 依赖 `requireUnlocked`**（敏感操作解锁），
   它是缓解项而非根治项 —— 真正的防线是上线前确认 `PUBLIC_ORIGIN` 与网络暴露面。
