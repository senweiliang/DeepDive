# Changelog

## 2026-05-30

### Added
- **Footer 余额实时刷新**：每次工具调用回合结束后自动调用 `fetchBalance` 更新余额，不再仅启动时拉取一次
- **品牌启动页（Splash）**：程序启动前先展示全终端波纹动画
  - 居中显示 "DeepDive" + "Terminal Coding Agent" 副标题
  - 以文字为中心向外扩散正弦波波纹，通过终端背景色渐变实现
  - 色阶从近黑蓝（#0d1b2a）平滑过渡到品牌蓝（#61afef）
  - 30fps 流畅动画，任意键或 2.5 秒后自动进入主界面
  - 新增 `src/components/Splash.tsx`，入口 `src/cli.tsx` 集成

## 2026-05-24

### Fixed
- **pending 队列背景跨行**：修复 pending 消息队列渲染时使用 `content.length` 计算宽度导致宽字符（CJK/emoji）时 padding 溢出换行的问题。改用 `stringWidth(content)` 正确计算终端列宽，并简化为 `<Text backgroundColor>` 单层结构，与 `Chat.tsx` 用户消息渲染保持一致。

## 2026-05-23

### Added
- **消息队列**：Streaming 期间用户发送的消息不再被忽略，而是放入队列；当前循环结束后自动逐条处理。
  - 队列消息显示在输入框上方，背景色与用户消息一致（`#3a3a3a`），左右各 2 空格间距
  - 每条显示为 `> pending msg <内容>`，从上到下按发送先后排列
  - Ctrl-C 中断时清空队列，与 Claude Code 中断行为一致
  - 改动：`src/components/App.tsx`、`src/components/InputBox.tsx`、`src/components/Chat.tsx`

### Removed
- **移除 `/help` slash command**：不再在输入框补全列表中展示 `/help`，对应的描述文本也已删除。

## 2026-05-20

### Added
- **模型选择面板**：新增 `/model` slash command；回车后在输入框下方打开模型选择面板，支持 `pro` / `flash` 两档，保存后写入 `~/.deepdive/settings.json` 的 `DEEPSEEK_MODEL`，并从下一轮请求起使用新模型。输入框补全和 `/help` 已同步展示 `/model`。

### Changed
- **Settings 面板增加模型选择**：`/settings` 第一项现在是 Model，可与推理强度、搜索等配置一起保存，并写入 `DEEPSEEK_MODEL`。
- **Settings 面板选中态配色**：设置值列不再默认显示为蓝色，仅当前选中行使用蓝色强调。
- **模型选择面板对齐与当前态**：`/model` 面板中的模型名占用固定列宽，模型描述从同一列开始显示；当前已设置的模型名后显示 `✓`。

## 2026-05-19

### Added
- **可配置上一轮摘要策略**：新增 `DEEPDIVE_TURN_SUMMARY_STRATEGY=off|whole_turn|tool_only`，默认 `off`，恢复“不做 turn summary”的原始历史发送行为；`whole_turn` 保留用户原文并压缩两个 user 之间的全部 assistant/tool 历史；`tool_only` 只压缩纯 `assistant(tool_calls, no content) -> tool` 链，保留可见 assistant content、带 content 的 tool_calls 及对应 tool result，避免破坏 DeepSeek tool-call 回传规范。
- **tool_only 摘要按连续 run 合并**：`tool_only` 现在把相邻的纯 `assistant(tool_calls, no content) -> tool` 块合并成一个 run，run 内至少 2 个块才生成/应用一条 summary；遇到可见 assistant content 会结束当前 run，单个工具调用保留原始历史。
- **turn summary 输入改为 JSON 文本转写**：上一轮摘要请求现在用单条 user 消息承载 JSON 文本，保留 user content、assistant reasoning_content/tool_calls、tool_call_id 对应 tool result，但不把原生 `assistant.tool_calls` 字段直接发给 summary model，避免模型输出内部工具调用标记。
- **Settings 面板支持上一轮摘要策略**：`/settings` 新增 Previous-turn summary 选项，保存到 `~/.deepdive/settings.json` 的 `DEEPDIVE_TURN_SUMMARY_STRATEGY`。
- **上一轮 tool-call 的 turn-level compaction**：发送新用户消息前，如果上一真实用户轮次包含 `assistant(tool_calls) -> tool` 原始链，客户端先将该轮摘要成隐藏的 `role: "user"` 元消息；后续 API 请求用该 summary 整段替换 raw tool-call history，避免旧 `reasoning_content` 反复进入下一轮，同时不改写仍被保留的原始 `assistant.tool_calls`。
- **turn summary 与 compact 分离**：上一轮摘要只取该轮非 meta 消息，调用 summary model 后直接返回隐藏 summary，不设置 Footer 的 compacting 状态。
- **turn summary 保留用户原文**：发送 API 时保留上一轮真实 user message，只用 summary 替换其后的 assistant/tool 原始过程，避免用户约束被摘要改写后丢失。
- **turn summary 不阻塞 running 状态**：普通消息发送后立即显示 pending user 和 running 状态，上一轮 summary 作为 preflight 在后台先完成，随后自动进入主 chat 请求。
- **独立 summary 模型配置**：新增 `DEEPSEEK_SUMMARY_MODEL`，summary/compaction 请求默认使用 `deepseek-v4-flash`，主聊天模型仍由 `DEEPSEEK_MODEL` 控制。
- **API 请求审计日志**：新增 `DEEPDIVE_REQUEST_AUDIT=summary|full`，开启后在 session log 中记录实际发送给 API 的 messages。`summary` 只记录结构摘要（role、字符数、reasoning 长度、tool 名称、summary 标记），`full` 额外记录完整 content / reasoning_content / tool_calls；默认关闭。兼容旧的 `DEEPSEEK_REQUEST_AUDIT` 名称。

### Fixed
- **内联 bash 结果不显示**：修复 bash 执行完后结果不渲染的问题。根因是 Ink `Static` 组件不会重渲染已有 item，原代码先追加无 `bashOutput` 的消息再替换同一条带 output 的消息，`Static` 因数组长度不变而跳过渲染。修复为执行期间用 `runningBash` 动态面板展示，完成后再一次性追加完整消息到 `Static`。

### Added
- **内联 bash 模式（`!` 前缀）**：在输入框开头输入 `!` 进入 bash 模式
  - 输入框提示符从 `>` 变为 `!`，上下分隔线变为紫红色（`theme.bash: #d87093`）
  - 回车直接执行本地 shell 命令，不经过 API
  - 用户消息以 `!` 前缀显示，执行结果以 `⎿` ToolResult 渲染在其下方
  - 实时流式输出（复用 runningBash 的异步执行 + 流式追加）
  - 改动文件：`src/theme.ts`、`src/types.ts`、`src/client.ts`、`src/components/InputBox.tsx`、`src/components/Chat.tsx`、`src/components/App.tsx`

## 2026-05-16

### Added
- **Slash commands**：`/clear` 清空对话、`/compact` 手动压缩上下文、`/help` 显示帮助和快捷键。输入 `/` 开头的内容在 `handleSend` 顶部拦截，不发送到 API。

### Changed
- **命令执行指示器动画**：工具调用 `●` 在执行中闪烁（400ms 间隔），完成后显示绿色圆点

### Added
- **`acceptEdits` 审批模式**：自动接受本会话所有文件编辑（write/edit），bash 仍逐条确认。比 `auto` 保守（不放松 bash）、比 `yolo` 安全
  - shift+tab 循环加入：`default → acceptEdits → plan → yolo → auto`
  - 编辑类工具的确认框新增「Allow all edits this session (shift+tab)」选项，当场切到该模式并放行
  - Footer 显示 "Accept Edits" 标签；`DEEPSEEK_MODE=acceptEdits` 可作初始模式
- **指令级权限系统（全量重构）**：细粒度指令匹配，对齐 Claude Code 的权限管线
  - 规则格式 `Tool(body)`：`body` 以 `:*` 结尾为**前缀规则**（token 边界匹配，`Bash(git push:*)` 不匹配 `git pushx`），否则为**精确/glob 规则**（文件路径用 `*`/`**`）
  - 三类规则桶 `permissions: { allow, deny, ask }`，存于 `~/.deepdive/settings.json`
  - **有序短路判定**：精确 deny → 精确 ask → 前缀 deny → 前缀 ask → 精确 allow → 前缀 allow → 只读白名单 → passthrough（deny 永远压过 allow）
  - **只读白名单**：`ls`/`cat`/`git status` 等无 shell 操作符的安全命令自动放行，不再打断
  - **裸命令/危险前缀/复合命令**（`sh -c`、`sudo`、`a && b`、注入）不自动生成可复用规则，ConfirmBox 隐藏 "Allow always"
  - 单一 summarizer：建议与匹配共用同一套归一化，杜绝两套 summarizer 对不上
- `src/tools/permissions.ts`：重写——结构化规则、有序 `checkPermission`、只读判定、安全的 `suggestPermissionPattern`
- `src/__tests__/permissions.test.ts`：20 个用例覆盖前缀匹配、优先级、只读、建议生成、迁移

### Fixed
- **致命 bug**：旧实现把 `Bash(pnpm:*)` 的 `:` 当字面量正则（`/^pnpm:.*$/`），与命令串 `pnpm install`（空格）永不匹配——所有自动保存的 bash allow 规则全部失效。现改为 token 边界前缀语义

### Changed
- `src/config.ts`：`Config.permissions` 改为 `{allow,deny,ask}`；`loadSettings` 兼容旧的扁平 `string[]`（迁移为 `allow`）；`saveSettings` 缺省字段保留磁盘原值（修复 saveApiKey 会清空权限的隐患）；`savePermission(pattern, kind)`
- `src/components/ConfirmBox.tsx`：`savePattern` 可为 null → 动态隐藏 "Allow always" 选项
- `src/components/App.tsx`：审批流改为单一 `checkPermission`：deny→拒绝/ask→确认框/allow→放行/passthrough→分类器或人工确认

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
