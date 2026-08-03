# Current Status — 2026-07-05

## 已完成
- [x] **终端 tab/窗口标题**（参考 Claude Code `useTerminalTitle`，TS+Rust 双实现，行为对齐）：OSC 0（`ESC]0;<title>BEL`）通用序列覆盖所有现代终端；仅两个特例——Windows classic conhost → `process.title` / Rust FFI `SetConsoleTitleW`（零依赖）、Kitty → ST 终止符免响铃；空闲 `✳ DeepDive`、busy `⠂/⠐` 动画（960ms）、`/rename` 会话名优先（恢复会话带出）；退出时清空标题；`DEEPDIVE_DISABLE_TERMINAL_TITLE` 开关
- [x] **Ctrl+C 退出时打印恢复命令**（TS+Rust）：双击 Ctrl+C 退出、终端恢复后打印可复制的 `deepdive -r <会话id>`（Rust TUI 为 `deepdive-tui -r <id>`），复制即续会话、免去 Picker 步骤；仅当会话 JSONL 已落盘（`src/session.ts` 新增 `sessionExists`）才打印——空会话 `-r` 会报 "Session not found"。TS 在 ink `exit()` 后、`process.exit(0)` 前打印；Rust 经 `sid_tx`/`sid_rx` 通道把引擎侧会话 id（新建/`/resume`/`/clear`）带回 UI，`region.leave` + `disable_raw_mode` 后打印
- [x] **MCP 客户端**（参考 Claude Code，TS+Rust 双实现，行为对齐）：连接外部 MCP 服务器→发现 `tools/list`→以 `mcp__server__tool` 暴露给模型→调用路由回 `tools/call`。传输 stdio+HTTP+SSE（Rust 手写零依赖 / TS 用官方 SDK）；配置全局 `mcpServers` + 项目 `.mcp.json`；schema 会话启动冻结追加（不破坏 prefix cache）；审批默认必弹+`mcp__server__tool`/`mcp__server` 规则+plan 模式屏蔽；`/mcp` 状态命令（CLI+TUI）。v1 仅 tools（Resources/Prompts 预留）、仅主 agent。端到端验证含真实 filesystem 服务器
  - **命令行管理** `deepdive mcp add/list/get/remove`（对齐 `claude mcp …`）：scope=user(settings.json)/project(.mcp.json)，`-t` 传输 / `-e` env / `-H` header / `--` 分隔 command，`transport_to_json` 与加载器互逆；渲染前拦截，无需 API key
- [x] 自定义 agent（`.deepdive/agents/*.md`，user+project，frontmatter name/description/tools/model，正文=persona）：加载器 `src/agents/load.ts`，注册表合并 last-wins，可用列表走 system-reminder 注入（tools schema 保持字节恒定），`/agents` 命令列出全部 agent
- [x] Background agent / background bash（`run_in_background`）：detached 非阻塞 spawn + 立即返回 `task_id` + 内存输出缓冲（`src/tasks/store.ts`）+ `<task-notification>` 完成通知（meta 通道）+ 空闲自动续回合；新增 `task_output`/`task_stop` 工具；Footer「⚙ N bg」指示器；并发软上限 10；退出清理
- [x] 工作区隔离（对齐 CLAUDE-CODE）：启动时冻结 `originalCwd`（`src/workspace.ts`），所有文件工具/bash/权限检查按冻结目录解析；会话按 `projects/{sanitized-cwd}/{id}.jsonl` 分项目目录存储，Session Picker 直接 `readdir(projectDir)` 天然隔离
- [x] Footer 余额实时刷新：每次工具调用回合结束后自动拉取 `/user/balance` 更新显示
- [x] 品牌启动页（Splash）：全终端波纹动画，近黑蓝→品牌蓝渐变，30fps 正弦波扩散
- [x] 消息队列：Streaming 期间用户输入暂存队列，结束后自动逐条处理（Ctrl-C 清空队列）
- [x] 指令级权限系统（allow/deny/ask 三桶、有序短路判定、只读白名单、token 边界前缀匹配）
- [x] acceptEdits 审批模式（本会话自动接受编辑，bash 仍确认；shift+tab / 确认框可切）
- [x] Auto mode 安全分类器（flash 快判）
- [x] classifier 宽容解析修复：模型把 `<verdict>` 占位符当字面 XML 标签输出（`<verdict>allow</verdict>`）时解析器误判 ask → 安全命令也弹确认；提示词去歧义（明确裸词 + 禁标签）+ 新增 `extractVerdict()` 宽容提取（裸词 / XML / 引号 / 反引号，优先 `|` 前、全文兜底）
- [x] classifier Windows 只读命令兜底：模型把 `dir /b D--code-DeepDive`（sanitized 目录名）误判为畸形盘符、`cd ~/.deepdive && dir` 误判为工作区外访问 → 只读列举被判 block 弹窗。修复：`dir`/`type`/`findstr`/`more`/`where` 进 heuristic 白名单 + `permissions.ts` 只读集（这类命令根本不走模型）；`cd /d <path> &&` 前缀剥离（原正则 `\S+` 只吃单 token）；提示词补 Windows 语义段（dir=ls、type=cat、2>nul=2>/dev/null、block 只针对破坏/修改）
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
- [x] 移除 DuckDuckGo 搜索引擎支持，仅保留 Tavily（`src/tools/websearch.ts` 精简为纯 Tavily，`config.ts` 移除 `ddg` 枚举，设置面板移除 ddg 选项和回落提示）
- [x] Slash command 模块化：提取 `/clear` `/compact` `/model` `/settings` `/rename` 为独立模块 `src/commands/*.ts`，统一 `SlashCommand` 接口，`App.tsx` 仅保留注册表调度
- [x] `/rename <title>`：重命名当前会话，标题更新在 JSONL 元数据中，`-r` 恢复时以新名称显示
- [x] `/add-dir <directory>`：添加额外工作区目录（加入 `sessionDirsRef`，仅本会话有效），路径相对原始 cwd 解析为绝对路径
- [x] `/add-dir` 对齐 Claude Code：路径校验（存在、是目录、已覆盖检测）+ 确认对话框（当前会话 / 所有会话持久化 / 拒绝）+ 持久化目录注入 system prompt（冻结不坏缓存）+ 会话中途新增以 meta user 消息通知模型
- [x] `/add-dir` 目录自动补全：输入框下方按名称排序列出可选目录（最多 10 条），上下键滚动、选中高亮、Tab 自动补全、忽略大小写过滤、带 `/` 时列出下一级目录

## 下一步
- [ ] 网络韧性：429/5xx 重试、http_proxy 支持、connect/idle 超时分离
- [ ] 推理强度档位热切（off/low/high/max）

## 进行中
- [x] Deep Diving 动画延迟修复：`setIsStreaming(true)` 从内存召回之后移到之前，用户发送消息后立即看到动画反馈
- [x] thinking→content 回填：LLM 把回答塞进 `reasoning_content` 时，`content` 为空导致用户看不到回答。修复：`assemble_turn` 流正常结束且 `content` 为空时复制 `reasoning_content` 到 `content`；`/btw` side question 额外兜底工具调用+thinking 场景

## 已完成
- [x] Slash commands：/clear /compact /model /settings

## 阻塞
- 无
