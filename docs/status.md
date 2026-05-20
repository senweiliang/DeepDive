# Current Status — 2026-05-20

## 已完成
- [x] 指令级权限系统（allow/deny/ask 三桶、有序短路判定、只读白名单、token 边界前缀匹配）
- [x] acceptEdits 审批模式（本会话自动接受编辑，bash 仍确认；shift+tab / 确认框可切）
- [x] Auto mode 安全分类器（flash 快判）
- [x] 会话持久化（JSONL append-only，-r/-c resume）
- [x] 缺 API key 时的设置界面（粘贴即用）
- [x] 上下文窗口管理 + auto compaction（>80% 自动摘要历史，Footer 显示 ctx 占比）
- [x] 上一轮摘要策略：默认 `DEEPDIVE_TURN_SUMMARY_STRATEGY=off`，保持原始历史不压缩；可选 `whole_turn`（保留 user、压缩两个 user 之间的 assistant/tool 历史）或 `tool_only`（连续 run 内至少 2 个纯 tool-call+tool-result 块时压成一条 summary，保留可见 assistant content 及其 tool_calls/tool 结果）；摘要使用 `DEEPSEEK_SUMMARY_MODEL`（默认 `deepseek-v4-flash`），按回车后立即进入 running/pending 状态，不触发 compacting 状态
- [x] turn summary 请求用单条 user 消息承载 JSON 文本转写：保留 user content、assistant reasoning_content/tool_calls、tool_call_id 对应的 tool result，但不把原生 `assistant.tool_calls` 字段直接发给 summary model，避免内部工具标记进入 summary
- [x] API 请求审计日志：`DEEPDIVE_REQUEST_AUDIT=summary|full` 时记录实际发送 messages 到 session log；summary 只记结构长度，full 记录完整 content/reasoning/tool_calls，默认关闭
- [x] 终端有色文字配色方案单页展示（docs/terminal-theme.html，固定 rgb(12,12,12) 背景，只切换原有有色语义位）
- [x] TUI 有色文字切换为 One Dark Code 配色
- [x] Markdown 渲染（marked + 自定义 Ink 渲染器，支持表格 `│─┼`、代码块边框+暗色背景、标题加粗、引用 `▌`、分割线等）
- [x] 内联 bash 模式（`!` 前缀）：输入 `!` 进入 bash 模式，输入框 `>` 变 `!` 且分隔线变紫红，回车执行本地命令，结果以 ToolResult 渲染在用户消息下方
- [x] Slash command `/model`：打开模型选择面板，支持 `pro` / `flash`，模型名固定列宽对齐描述，当前模型名后显示 `✓`，写入 `~/.deepdive/settings.json` 的 `DEEPSEEK_MODEL`，下一轮请求起生效
- [x] `/settings` 面板第一项支持 Model 选择，并与其他设置一起保存 `DEEPSEEK_MODEL`；值列仅选中行显示蓝色

## 下一步
- [ ] 网络韧性：429/5xx 重试、http_proxy 支持、connect/idle 超时分离
- [ ] 推理强度档位热切（off/low/high/max）

## 已完成
- [x] Slash commands：/clear /compact /model /help /settings

## 阻塞
- 无
