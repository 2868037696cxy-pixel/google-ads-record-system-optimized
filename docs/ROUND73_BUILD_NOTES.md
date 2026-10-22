# 第73轮补充：构建与发布分离

## 已确认的额外问题

在临时验证运行 `39255605833` 中，118 项服务端测试、Windows 本地回归、HTTPS 远程回归和新增 UI 回归均通过。EXE/ZIP 生成后，electron-builder 26.15.3 根据 CI 环境尝试发布 GitHub 制品，因未提供 GH_TOKEN 返回失败。

这不是要求添加管理员 Token 的理由，也不能通过扩大 CI 权限处理。候选构建只应生成可核验制品，不应顺带发布 GitHub Release。

## 修复

`package.json` 的 `build:win` 和 `build:dir` 明确指定 `--publish never`。正式发布如果以后需要，应在经过审核的独立发布流程中显式启用，而不是依赖构建工具的 CI 自动推断。

新增 `test:round73` 运行真实界面回归，并加入现有 Windows 流水线。最终分支不保留临时自动修改源码工作流或补丁应用脚本；只保留直接修复后的源码、正常测试和文档。

官方 v26 参数说明：
https://www.electron.build/v26/docs/publish/

## 完整验证结果

运行：
https://github.com/2868037696cxy-pixel/google-ads-record-system-optimized/actions/runs/39256443414

- Ubuntu / Node 22.22.2：全量服务端测试通过。
- Ubuntu / Node 24：原始错误负向对照及全量服务端测试通过。
- Windows：118 项服务端测试通过。
- Windows 既有本地 Electron 回归：通过。
- Windows 既有 HTTPS 远程回归：通过。
- 新增选择取消、维护提示和保存后刷新失败回归：通过。
- EXE/ZIP 候选构建、SHA256 校验清单、制品上传：通过。

制品名称为 `Round73-Windows-candidate`。它是测试构建，不代表已经发布到员工、完成生产升级、配置了商业代码签名或解决所有原始审计项。

后续正式 PR 会对已经提交的实际源码再次运行仓库常规 Linux/Windows 流水线。查看 PR 检查状态时，应以相应提交的任务结果为准，不把过去某次通过自动算到未来不同代码上。
