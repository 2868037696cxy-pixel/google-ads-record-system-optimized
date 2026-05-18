# 谷歌广告记录系统 v2.0

这是一个广告记录系统，数据存储在**服务端 SQLite 独立数据库**中，不依赖浏览器缓存。

## 🚀 快速开始

```bash
npm install
npm start
```

访问: http://localhost:3000

## ✨ 功能

- SQLite 独立数据库
- 广告管理与统计
- 数据导入导出 (JSON/CSV/Excel)
- 深色模式支持
- 批量操作
- 成本预警
- 撤销/重做
- 键盘快捷键

## ⌨️ 快捷键

| 快捷键 | 功能 |
|--------|------|
| Ctrl+S | 保存 |
| Ctrl+Z | 撤销 |
| N | 新增广告 |
| Escape | 关闭对话框 |

## ☁️ 部署

支持部署到 Render 等云平台，打开网址即可使用，无需本地运行。

```yaml
# render.yaml
services:
  - type: web
    name: google-ads-system
    env: node
    buildCommand: npm install
    startCommand: npm start
```

## 📝 许可证

MIT License