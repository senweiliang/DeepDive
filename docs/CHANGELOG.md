# Changelog

## 2026-05-14

### Added
- Markdown 渲染：助手消息支持表格、代码块、标题、列表、引用块等 Markdown 语法（`marked` + 自定义 Ink 渲染器）
  - 表格使用 `│ ─ ┼` box-drawing 字符渲染，自动计算列宽、支持左/中/右对齐
  - 代码块带语言标签的边框框体 + 暗色背景
  - 标题加粗，引用块 `▌` 前缀，分割线
  - 兼容 fail-safe：解析失败时回退纯文本

### Changed
- `bash` 工具改为异步执行（`spawn` 替代 `execSync`），不再阻塞 TUI 渲染
- 审批通过后立即显示 `Running: <cmd>` 占位消息，stdout 实时流式追加
- Escape 中断时自动杀掉正在运行的 bash 子进程

## 2026-05-13

### Added
- `docs/terminal-theme.html`：终端配色方案单页展示，覆盖标签栏、消息流、工具调用、审批框、底部状态栏和色板
- `docs/terminal-theme.html`：增加多主题前端选择器，内置 Graphite Cyan、VS Code Dark+、Darcula、Solarized Dark、Dracula、Catppuccin Mocha、One Dark、Tokyo Night 风格预览
- `docs/terminal-theme.html`：调整为终端文字语义配色实验台，终端背景固定为 `rgb(12, 12, 12)`，主题仅切换用户输入、正文、thinking、工具名、参数、路径、结果、审批和 Footer 指标颜色
- `docs/terminal-theme.html`：收窄为只切换原本有色的终端文字位：thinking、工具/品牌、成功/cache、审批/mode、当前选项和费用；普通正文、参数、路径和结果保持固定灰白配色
- `src/theme.ts`：新增 One Dark Code 终端有色文字主题，并应用到 Chat、Thinking、ConfirmBox、Footer、SetupScreen、SessionPicker、InputBox 的有色语义位

## 2026-05-10

### Added
- 主聊天视图渲染工具调用与结果：assistant 消息显示 `● tool(args)`，tool 结果以 `⎿` 缩进预览（前 3 行 + 多余行计数），错误结果标红
- `src/tools/format.ts`：抽出 `summarizeArgs` / `truncate`，`ConfirmBox` 与 `Chat` 共用

## 2026-05-07

### Added
- SSE 流式客户端，对接 DeepSeek API
- Ink TUI：Header / Chat / InputBox / Thinking 组件
- 基础消息循环（多轮对话 + 上下文传递）
- 推理块折叠/展开展示
- Header 实时显示 token 用量 + cache 命中率
- settings.json 配置（env 字段设环境变量）
- 项目文档框架（ROADMAP / DESIGN / status / CHANGELOG）
