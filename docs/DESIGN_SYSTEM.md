# Design System v3.1 — 广告记录系统

> 按「Claude Design」方法论：先定设计系统，再写代码。
> 对标：Awwwards / Linear / Stripe Dashboard 的克制高级感。

## 设计语言：「精密仪表」

给每天看数据的运营用的工具：冷静、精确、有呼吸感。
关键词：**克制、精确、呼吸感、微动效**。

## 色彩 Tokens

| 用途 | 浅色 | 深色 |
|------|------|------|
| 背景 bg | #f6f7f9（冷灰，替代米纸） | #14171c |
| 面板 panel | #ffffff | #1c2128 |
| 次级 soft | #eef1f4 | #262c35 |
| 分割线 line | #e3e8ee | #2f3640 |
| 主文字 text | #161b22 | #e8edf2 |
| 次要 muted | #5d6b7a | #8b96a3 |
| 主色 brand（深青） | #0b6e74 → hover #0a5f64 | #3aa5ac |
| 点缀 accent（琥珀，只用于高光） | #c98a1f | #e0a83c |
| 成功 green | #1f7a3d / bg #dff0e3 | #4caf6d |
| 危险 red | #c0392b / bg #fbe3de | #e0685c |
| 警告 orange | #b25e09 / bg #fdf0dc | #f0a63c |
| 信息 blue | #0b5f8a / bg #ddebf5 | #5aa2d0 |

规则：
- 主色只用于：主按钮、active 状态、关键数字、链接。**不滥用**。
- 琥珀色只用于：ROI 高光、获奖/推荐徽章。**一屏不超过 2 处**。
- 语义色必须配浅底色徽章，不直接大面积使用。

## 字体

```css
--font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text",
  "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
--font-num: "SF Mono", ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace;
```

- 所有金额/数字/日期用 `--font-num` + `font-variant-numeric: tabular-nums`（等宽，表格不跳动）
- 字阶：页面标题 20px/700，卡片标题 14px/650，正文 13px，辅助 12px

## 间距 Scale（4px 基准）

`--sp-1:4px, --sp-2:8px, --sp-3:12px, --sp-4:16px, --sp-5:20px, --sp-6:24px, --sp-8:32px`

- 卡片内边距：20px；卡片间距：16px；页面边距：24px

## 圆角 / 阴影

- `--r-sm:8px, --r-md:12px, --r-lg:16px`；按钮 pill 999px
- 阴影三级：sm（0 1px 2px rgba(16,24,40,.06)）、md（0 4px 12px rgba(16,24,40,.08)）、lg（0 12px 32px rgba(16,24,40,.12)）
- 卡片默认无边框阴影 sm，hover 升 md + 上浮 2px

## 动效

- `--ease: cubic-bezier(0.22, 1, 0.36, 1)`（out-expo，干脆不拖沓）
- 时长：微交互 150ms，页面切换 250ms
- 页面内容区：淡入 + 上浮 8px
- 卡片 hover：translateY(-2px) + 阴影加深
- 按钮 active：scale(0.97)
- Toast：右侧滑入
- 尊重 `prefers-reduced-motion`

## 组件规范

- **统计卡片**：顶部 3px 主色条（按语义变色）+ 28px 等宽大数字 + 12px 灰色 label
- **按钮**：主按钮 brand 渐变（#0e7f86→#0b6e74）+ 内阴影高光；危险按钮红底白字；次要按钮白底灰边
- **徽章**：浅底 + 深字 + 8px 圆角，如"测试中"绿底、"暂停"灰底
- **空状态**：48px 线性图标 + 14px 标题 + 12px 说明 + 引导按钮
- **表格**：表头 11px 大写灰色字母间距，行 hover 底色，数字右对齐等宽
- **输入框**：focus 时 2px brand 光环 + 边框变色
