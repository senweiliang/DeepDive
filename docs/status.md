# Current Status — 2026-08-03

## 已完成
- [x] **手机远程控制（局域网，TS 实现）**（对齐 Claude Code Remote Control 的「本地会话窗口」模型 + OpenClaw Control UI 自托管思路）：`/remote` 开启进程内嵌 HTTP 服务器（0.0.0.0，默认 3838，`DEEPDIVE_REMOTE_PORT` 可改、被占自动 +1），终端打印带随机 128-bit token 的 URL + ANSI 二维码（`qrcode` npm）；手机扫码打开内联单页（`src/remote/page.ts`，零构建），SSE（`/events`，150ms 节流全量快照 + 25s 心跳）实时看会话、POST（`/api/message`，token 校验）发消息——手机消息与终端输入走同一条 `handleSend`（streaming 中自动进队列）。快照口径 = `visibleMessages`（与终端一致）。`DEEPDIVE_REMOTE=1` 启动即开；退出自动关服务器防事件循环残留；Windows 防火墙首次需放行专用网络。新模块 codemap（remote/nav + feature/remote-control/nav + spec）+ 单测 7 例（URL/QR、页面、SSE、401、POST 注入、400/404）。**08-04 修复**：二维码块从 staticItems 尾插条目（`<Static>` 按 index 追加 → 每条新消息重印一次二维码）改为一条 `remote:true` 的普通 Message（index 固定、只印一次；不落盘、不进模型、不进手机快照）；手机端 tool 输出截断对齐桌面 `ToolResult`（3 行 + `… +N lines`）+ 修复重绘顶回顶部。单测扩到 19 例（server 7 + page 12 含 7 例 DOM 桩模拟），真实链路模拟通过（GET 页面/SSE 快照/POST 消息/渲染响应页均正常）
- [x] **Footer cache hit 加单轮命中率后缀**（TS+Rust 双实现，对齐 Reasonix `turn hit X% · avg Y%`）：`cache hit: 49% (turn 96%)`，累计值被冷启动首轮拖低时括号内单轮值立现缓存是否正常
- [x] **AI 会话标题**（参考 Claude Code `utils/sessionTitle.ts`，TS+Rust 双实现，行为对齐）：新会话首条真实 user 消息后用 flash 模型（`DEEPSEEK_SUMMARY_MODEL`）一次性生成中文 3-10 字标题（JSON 输出、宽容解析、15s 超时、失败静默不重试）；成功写 JSONL meta.title（Picker 显示）+ 同步终端标题；`/rename` 手动名优先；恢复不重新生成、`/clear` 重置 gate。**08-04 修复**：`reasoning_effort` 由 `low` 改 `none`（API 关闭档位，`off` 会 400）——原实现 thinking 阶段吃光 100 token 配额导致 content 为空、标题永不落盘。**08-04 修复 2**：首条真实消息短于 4 字（如 "HI"/"你好"）时直接跳过标题生成（过短没有可概括的任务，此前 flash 会照抄示例标题——会话 0b717f1c 顶了个"修复移动端登录按钮"）；同时提示词显式禁止照抄示例标题。TS `firstRealUserText` + Rust core `first_real_user_text` + Rust TUI `first_real_user_row` 三处同步（`MIN_DESCRIPTION_LENGTH`=4，`src/session-title.ts` 导出 / `deepdive-core` pub 常量）
- [x] **网络韧性**（TS `src/net.ts` + Rust `deepdive-core/src/net.rs` 双实现）：429/408/5xx 自动重试（4 次尝试、指数退避 + 半抖动、`Retry-After` 优先且 >60s 直接放弃不空等）；connect 阶段（45s，到响应头为止）与流式 idle（300s，两个 SSE chunk 之间）**分离**——不用整请求超时，否则会掐断正常的长回答；重试耗尽时把失败响应原样交回调用方，错误文案不变。http_proxy 早已由 undici `EnvHttpProxyAgent` / reqwest 环境变量覆盖
- [x] **Footer 显示推理强度档位**：第一段 `model | mode` 后加 `think: <档位>`（THINKING 琥珀色）。档位仍在 `/settings` 面板改（本就是当前会话下一轮生效），Footer 只解决「改完看不出现在是哪档」
- [x] **Windows 下用户消息渲染两遍**（TS+Rust）：全宽背景条/分隔线填满终端宽度，Windows conhost 写满即换行导致 Ink 少擦一行、残影与 `<Static>` 正本并存。新增 `barWidth`/`bar_width` 统一留末列；顺带修 `<Static>` 中部插入（memory recall 槽位前置、日期变更提醒不再提前提交 `pendingUser`）
- [x] **终端 tab/窗口标题**（参考 Claude Code `useTerminalTitle`，TS+Rust 双实现，行为对齐）：OSC 0（`ESC]0;<title>BEL`）通用序列覆盖所有现代终端；仅两个特例——Windows classic conhost → `process.title` / Rust FFI `SetConsoleTitleW`（零依赖）、Kitty → ST 终止符免响铃；空闲纯 `DeepDive`、busy 时盲文 thinking 转圈 `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`（10 帧×80ms，对齐 Claude Code `RESOLVING_SPINNER_CHARS`）、`/rename` 会话名优先（恢复会话带出）；退出时清空标题；`DEEPDIVE_DISABLE_TERMINAL_TITLE` 开关。**08-04 调整**：去掉空闲 `✳` 前缀（用户要求），busy 动画最终定为盲文转圈（先后试过 `⠂/⠐` 两点与方块波浪）
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
- [x] classifier 宽容解析修复：模型把 `<verdict>` 占位符当字面 XML 标签输出（`<verdict>allow</verdict>`）时解析器误判 ask → 安全命令也弹确认；提示词去歧义（明确裸词 + 禁标签）+ 新增 `extractVerdict()` 宽容提取（裸词 / XML / 引号 / 反引号，优先 `|` 前）
- [x] classifier 占位符治本：模型把模板占位符当字面文本回吐（`<verdict> | <reason>allow | …`）→ 提示词彻底移除 `<verdict>`/`<reason>` 字面量（含反例），改行首裸词指令 + 有效示例；解析端去掉全文兜底（只信 `|` 前 head 段），不再从 reason 捡词（观察期：确认治本后模型不再回吐占位符）
- [x] 占位符治本补齐（TS+Rust）：model-router 的 `<model> | <reason>` 同款占位符 → TS `model-router.ts` + Rust `model_router.rs` prompt 同步移除（行首裸词 pro|flash + ` | ` + 理由）；上一轮漏掉的 Rust `classifier.rs` 也补齐（与 TS `classifier.ts` 逐字对齐）
- [x] classifier Windows 只读命令兜底：模型把 `dir /b D--code-DeepDive`（sanitized 目录名）误判为畸形盘符、`cd ~/.deepdive && dir` 误判为工作区外访问 → 只读列举被判 block 弹窗。修复：`dir`/`type`/`findstr`/`more`/`where` 进 heuristic 白名单 + `permissions.ts` 只读集（这类命令根本不走模型）；`cd /d <path> &&` 前缀剥离（原正则 `\S+` 只吃单 token）；提示词补 Windows 语义段（dir=ls、type=cat、2>nul=2>/dev/null、block 只针对破坏/修改）
- [x] classifier 下载/执行边界（用户原则「下载放行、执行不确定内容才拦」，TS+Rust 同步）：`gh api …/contents/<file> + base64 解码 + Select-String 打印` 全程只读，不再误判 block；heuristic 新增「下载即执行」硬规则（`curl|wget|gh api|iwr|irm … | bash|sh|python|iex|node` 直接 block）；`| powershell`/`| cmd` 歧义形态交给模型；ask 触发从「涉及网络 API」收窄为「有副作用的网络操作（写/删/鉴权）」；提示词补该命令类别的 allow/block/ask 示例；单测 TS +6 / Rust +2（含 19bd9d8c 会话被拦的原命令回归）
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
- [ ] 组件测试 / 集成测试（ROADMAP §14 仍为「待实现」，目前只有单元测试）
- [ ] Rust 侧诊断日志（TS 有 `src/log.ts` → `~/.deepdive/logs/<sessionId>.log`，Rust 无对应物）
- [ ] resume 还原 subagent 分组（`core::types::Message` 无 `subagent` 字段，需动持久化结构）

## 进行中
- [x] Deep Diving 动画延迟修复：`setIsStreaming(true)` 从内存召回之后移到之前，用户发送消息后立即看到动画反馈
- [x] thinking→content 回填：LLM 把回答塞进 `reasoning_content` 时，`content` 为空导致用户看不到回答。修复：`assemble_turn` 流正常结束且 `content` 为空时复制 `reasoning_content` 到 `content`；`/btw` side question 额外兜底工具调用+thinking 场景

## 已完成
- [x] Slash commands：/clear /compact /model /settings

## 阻塞
- 无
