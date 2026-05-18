# Current Status — 2026-05-19

## 已完成
- [x] 指令级权限系统（allow/deny/ask 三桶、有序短路判定、只读白名单、token 边界前缀匹配）
- [x] acceptEdits 审批模式（本会话自动接受编辑，bash 仍确认；shift+tab / 确认框可切）
- [x] Auto mode 安全分类器（flash 快判）
- [x] 会话持久化（JSONL append-only，-r/-c resume）
- [x] 缺 API key 时的设置界面（粘贴即用）
- [x] 上下文窗口管理 + auto compaction（>80% 自动摘要历史，Footer 显示 ctx 占比）
- [x] 终端有色文字配色方案单页展示（docs/terminal-theme.html，固定 rgb(12,12,12) 背景，只切换原有有色语义位）
- [x] TUI 有色文字切换为 One Dark Code 配色
- [x] Markdown 渲染（marked + 自定义 Ink 渲染器，支持表格 `│─┼`、代码块边框+暗色背景、标题加粗、引用 `▌`、分割线等）
- [x] 内联 bash 模式（`!` 前缀）：输入 `!` 进入 bash 模式，输入框 `>` 变 `!` 且分隔线变紫红，回车执行本地命令，结果以 ToolResult 渲染在用户消息下方

## 下一步
- [ ] 网络韧性：429/5xx 重试、http_proxy 支持、connect/idle 超时分离
- [ ] 推理强度档位热切（off/low/high/max）

## 已完成
- [x] Slash commands：/clear /compact /help /settings

## 阻塞
- 无
