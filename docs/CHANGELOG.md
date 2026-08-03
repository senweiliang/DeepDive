# Changelog

## 2026-08-04

### Fixed
- **AI 会话标题照抄示例标题（TS+Rust）**：首条真实消息过短时（实测会话 0b717f1c 首条是 "HI"），flash 没有可概括的任务，直接回吐提示词里的"好例子"（该会话被命名为"修复移动端登录按钮"）。修复两层：① `firstRealUserText` / `first_real_user_text` / `first_real_user_row` 三处（TS + Rust core + Rust TUI）新增 `MIN_DESCRIPTION_LENGTH`=4 字下限，短于 4 字的招呼语跳过（门未置位 → 后续更长消息到达时仍会生成，纯招呼则保持默认名）；② `SESSION_TITLE_PROMPT`（TS + Rust core 同步）末尾新增"禁止照抄示例标题，示例仅供格式参考"约束。单测：TS +1 用例、Rust core +1、Rust TUI +1
- **AI 会话标题一直生成不出来（TS+Rust）**：标题请求 `reasoning_effort: "low"` 下，flash 模型的 thinking 阶段就把 `max_tokens: 100` 全部吃掉（实测 `finish_reason: length`、`reasoning_tokens: 100`、`content` 为空）→ `extractTitleJson('')` 返回 null → 静默失败、本会话不再重试，meta.title 永远不落盘。实测 API 报错确认合法档位是 `none/minimal/low/medium/high/xhigh/max`（`off` 会 400）；`deepseek-chat`（无 thinking）虽正常，但更优解是继续用 flash 并显式关 thinking。修复：`src/session-title.ts` + `deepdive-rs/crates/deepdive-core/src/session_title.rs` 的 `reasoning_effort` 改为 `"none"`（API 的关闭档位，`off` 仅 DeepDive UI 命名），`max_tokens: 100` 保持不变；实测 flash+none+完整 prompt 返回标准 `{"title":"…"}`（finish: stop、reasoning 0 开销）

### Changed
- **终端标题去掉空闲 ✳ 前缀 + busy 动画换成盲文 thinking 转圈**（TS+Rust 双实现）：空闲标题由 `✳ DeepDive` 变为纯 `DeepDive`（去掉静态 emoji 前缀，用户要求）；busy 动画先试过 Running 同款方块波浪（`▁▂▃▄▅▆▇`，12 帧）最终定为 Claude Code `RESOLVING_SPINNER_CHARS` 同款盲文转圈 `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`（10 帧 × 80ms/帧，即 Claude thinking spinner 节奏）。TS `src/terminal-title.ts` + Rust `deepdive-tui/src/terminal_title.rs`（`TITLE_ANIMATION_FRAMES`/`TITLE_ANIMATION_INTERVAL_MS`/`buildTerminalTitle`/`title_string`），`TITLE_STATIC_PREFIX` 常量删除；测试同步（busy 断言换盲文字符、wraps 帧数调整）；codemap ui 模块及 terminal-title 单元描述回写
- **Footer cache hit 增加单轮命中率后缀**（TS+Rust 双实现，对齐 Reasonix 的 `turn hit X% · avg Y%` 双维度）：`cache hit: 49% (turn 96%)` —— 会话累计命中率后加括号显示最近一次请求的单轮命中率。累计值会被冷启动首轮全 miss 拖低（08-03 最早会话平均 48.9% vs 第二轮单轮 95.8%），单轮值能立刻看出缓存是否正常工作。TS：`App.tsx` 新增 `turnCacheHitPct` state（从 raw `lastUsage` 算，不与累计值混用），`Footer.tsx` 渲染 `(turn x%)`；Rust：`AgentEvent::Usage` 改为 struct 变体携带 `turn_cache_pct`（`engine.rs` 在 merge 前算、`bridge.rs` UiEvent 透传、TUI `AppState` 存储、`footer.rs` 渲染），`/clear` 一并重置；测试：Rust bridge/app 单测更新（含 `turnCachePct` JSON 断言）

## 2026-08-03

### Added
- **网络韧性**（TS `src/net.ts` + Rust `deepdive-core/src/net.rs` 双实现，行为对齐）：此前 chat/summarize 遇到非 2xx 直接抛错、且主请求**完全没有超时**，一次 429 或一条卡死的连接就中断整个回合
  - **重试**：408/429/5xx 视为瞬时故障，最多 4 次尝试；退避 = 指数（500ms→8s 封顶）+ 半抖动（并发会话不会同拍重撞）；`Retry-After` 优先（delta-seconds 与 IMF-fixdate 两种形式都解析，Rust 手写日期解析避免新依赖），但超过 60s 直接放弃——空等一小时不如快速失败。其余 4xx 不重试（重发只会再错一次）
  - **超时分离**：connect 阶段 45s（DNS+TCP+TLS+请求+响应头），流式 idle 300s（两个 SSE chunk 之间的最大间隔）。**不能用整请求超时**——那会掐断正常的长回答。TS 用 `AbortSignal.any([用户signal, 连接deadline])` 组合，响应头到达即 `clearTimeout` 退休连接 deadline，留用户 signal 继续管流式 body；Rust 用 `tokio::time::timeout` 包 `send()`（reqwest 的 send future 恰好在响应头 resolve），流式侧包 `byte_stream.next()`
  - **错误归属不变**：重试耗尽时把失败响应**原样**返回（body 未读），调用方继续生成自己的 `API error {status}` / `Summarize API error {status}` 文案
  - 用户取消（Ctrl+C）在任何阶段都不重试，退避期间也立即中断
  - 单测：TS 19 条（状态判定/Retry-After 解析/退避窗口/重试与放弃路径/连接 deadline/idle 超时）、Rust 9 条
- **Footer 显示推理强度档位**（TS `Footer.tsx` + Rust `render/footer.rs`）：第一段 `model | mode` 后新增 `think: <档位>`（THINKING 琥珀色）。档位本就能在 `/settings` 面板改且当前会话下一轮即生效，但改完退出面板就无从确认现在是哪档。TS 侧 `App.tsx` 加一个镜像 state 只为面板保存后触发 footer 重渲染，`config` 仍是请求时读取的唯一真源

### Fixed
- **model-router prompt 同款占位符治本（TS+Rust）**：`ROUTER_PROMPT` 的 `<model> | <reason>` 占位符被模型当字面文本输出时，首段解析成 `<model>` 而非 pro/flash → 想走 flash 的请求被回退成 pro。修复：TS `model-router.ts` + Rust `model_router.rs` 的 prompt 移除 `<model>`/`<reason>` 字面占位符（含格式说明段），改为「行首裸词 pro|flash + ` | ` + 理由」；解析端本就只信 `|` 前首 token，未改。同时把上一轮漏掉的 Rust `classifier.rs` prompt 补齐治本（与 TS `classifier.ts` 逐字对齐：去 `<verdict>`/`<reason>` 占位符 + 行首裸词指令 + 三条有效示例）
- **Windows 下发送消息后用户消息渲染两遍**（TS `Chat.tsx`/`AskQuestion.tsx`/`BtwPanel.tsx` + Rust `render/{transcript,modals,input}.rs`）：用户消息的 `#3a3a3a` 背景条 `padLines(..., cols)` 填满**整个**终端宽度，一列余量都不留。xterm 系终端有 delayed wrap（写满最后一列时光标滞留、不换行），这行占 1 个物理行，与 Ink 的计数一致；但 Windows conhost 是**写满即换行**，同一行占 2 个物理行，而 Ink 的 `log-update` 只按 `'\n'` 计数 → `eraseLines(previousLineCount)` 少擦最上面一行 → 动态区的 `pendingUser` 残留在屏幕上，紧接着 `<Static>` 又正式打印一份，形成两条一模一样的消息（中间隔的空行正是多出来的那个物理行）。同一机制还会在后续内容里留下孤立的橙底 `>` 残字
  - 新增 `barWidth(cols) = cols - 1`（Rust `render::bar_width`），所有全宽渲染（用户消息条、`/btw` 与 ask_user_question 面板顶部分隔线、slash/目录候选菜单分隔线、输入框 rule）统一留出末列
  - 触发面被 `2e462ad`（流式按完成块增量提交进 `<Static>`）放大：static 输出从「每轮一次」变成「每个完成块一次」，每次都触发 `log.clear()`，于是每块都暴露一次擦除误差
- **`<Static>` 列表中部插入导致 ink 重打印尾部**（`App.tsx`）：`<Static>` 按 index 追加，已打印区之前插入任何一项都会让其后所有项错位、被重新打印
  - memory recall 的 system-reminder 在 `history` 里排在用户消息之后，却要等回合提交才进 `messages` —— 它一旦落位就挤在「已打印的用户消息」和「已打印的流式行」之间。改为用 `pendingRecall` 与 `pendingUser` 一起在 recall 解析出来的当帧就占住最终槽位（队列排空路径下用户消息已提交，故两者的渲染条件相互独立）
  - 跨午夜的日期变更提醒（`meta`，不可见）原先会 `setMessages(history)`，唯一效果是把仍被 `pendingUser` 持有的用户消息提前提交 → 同一帧内 `<Static>` 和动态区各渲染一份，且发送撤回失效。改为只更新本地 `history`，随下一次真实提交一起落盘
  - 达到 `maxTurns` 上限的提示同理：先释放 `pendingUser` 再 `setMessages`，两个更新落在同一批次
- **read_file 权限建议在非 Windows 上退化为单文件规则**（`src/tools/permissions.ts` + Rust `permissions.rs`）：`suggestPermissionPattern` 注释写着「先归一化反斜杠」，但 `dirname()` 吃的仍是原始串。POSIX 的 `path.dirname` 不把 `\` 当分隔符（Rust 侧同理，`dirname` 只在 `cfg!(windows)` 认 `\`），于是 `D:\code\...\x.ts` 被当成单个文件名 → 返回 `"."` → 掉进 fallback，「Allow always」建议出的是**单文件** `Read(D:/.../x.ts)` 而非可复用的**目录** `Read(D:/.../utils/**)`。改为对归一化后的路径取 dirname，两平台行为一致
  - Rust 的 `windows_path_handling` 测试原先用 `if cfg!(windows)` 把这个 bug 编码成了「预期行为」，一并改为无分支断言
- **classifier 测试写死 win32 平台断言**（`src/__tests__/classifier.test.ts`）：`expect(process.platform).toBe("win32")` 在非 Windows 上必然失败（该用例显然只在 Windows 上跑过）。改为断言注入的是**当前真实平台**（`platform=${process.platform}`），保留原意图——模型要看到真实平台才不会把 `findstr` 当「windows-specific 不可用」而 block
- **classifier 模型回吐占位符仍判 ask（治本）**：flash 模型把提示词模板里的尖括号占位符当字面文本输出（`<verdict> | <reason>allow | …`），解析器 head 段（`|` 前）无判定词 → 只读命令（如 `git log`）也弹确认框。修复（`src/tools/classifier.ts`）：① 提示词彻底移除 `<verdict>`/`<reason>` 字面占位符（含反例），改为「行首裸判定词 + ` | ` + 理由」的指令 + 三条有效示例；② 解析端去掉全文兜底（`extractVerdict(head) ?? extractVerdict(text)` → 只查 head）——旧兜底从 reason 里捡到 allow 判对是碰巧，reason 含 block/ask 字样时会误判
- **auto 模式命令分类器误判 allow 为 ask**：deepseek-v4-flash 把提示词里的 `<verdict>` 占位符当成字面 XML 标签输出（`<verdict>allow</verdict> | …`），解析器 `split("|")[0].startsWith("allow")` 不认 → 安全命令也弹确认框。修复（`src/tools/classifier.ts`）：① 提示词去掉尖括号占位符歧义，明确 verdict 必须是裸词、禁止标签包裹；② 解析器新增 `extractVerdict()` 宽容提取判定词（裸词 / XML 标签 / 引号 / 反引号，优先取 `|` 前、无 head 时全文兜底）；单测新增 11 个用例
- **auto 模式模型误判 Windows 只读命令为 block**：模型把 `dir /b D--code-DeepDive` 里的 sanitized 目录名当成「畸形盘符引用」、把 `cd ~/.deepdive/projects && dir /b` 当成「访问工作区外」→ 只读列举命令被判 block 弹窗。修复三层：① heuristic 白名单补 Windows 只读命令 `dir`/`type`/`findstr`/`more`/`where`（`classifier.ts` 启发式正则 + `permissions.ts` `READ_ONLY_COMMANDS`），这类命令直接 allow、不再走模型；② `cd /d <path> &&`（Windows 盘符切换）前缀剥离——原正则 `\S+` 只吃单 token，`cd /d` 后跟路径时剥不掉，导致 `^` 锚定的 allow 正则全部 miss（`classifier.ts` classify/heuristicClassify + `permissions.ts` stripCdPrefix 三处统一改为 `[^&;]+?`）；③ 提示词补 `## Platform notes (Windows / cmd.exe)`：`dir`=ls、`type`=cat、`cd /d`=切换目录、`2>nul`=2>/dev/null、`D--code-DeepDive` 式 token 是目录名非盘符、block 只针对破坏/修改、读取/列举永不 block，Examples 加 3 条 Windows 用例；单测新增 3 条（classifier）+ 2 条（permissions）

### Changed
- **classifier 下载/执行边界**（用户原则「下载放行、执行不确定内容才拦」；`src/tools/classifier.ts` + Rust 同步）：`gh api …/contents/<file>` 下载 + base64 解码 + `Select-String` 打印这类全程只读命令不再误判 block（19bd9d8c 会话原命令已进回归用例）
  - heuristic 新增「下载即执行」硬规则：`curl|wget|gh api|iwr|irm … | bash|sh|zsh|ksh|python3?|node|deno|perl|ruby|php|iex|Invoke-Expression` 直接 block，不等模型；`| powershell`/`| cmd` 有歧义（解码=数据 / iex=执行）→ 留给模型按提示词判断
  - `CLASSIFIER_PROMPT`（TS+Rust 逐字同步）：block 规则明确「下载+EXECUTE 才拦，下载/解码/过滤/打印 = 只读永不 block」；allow 规则新增只读网络读取；ask 触发从「涉及网络 API」收窄为「有副作用的网络操作（POST/PATCH/DELETE、鉴权、删远端数据）」；Examples 增补该命令类别的 allow/block/ask 三例
  - 单测：TS +6（block 5 + ask 1）与回归原命令、Rust +2（block + ask）
  - codemap 回写：新增「工具执行安全」模块（`docs/codemap/safety/`，R1）+ feature/command-classifier 单元卡（R2）+ ADR 0001（下载/执行边界取舍）
- **codemap 回写**（导航补全）：新增「模型与路由」「界面与状态栏」两个模块路由（`docs/codemap/model/`、`docs/codemap/ui/`），覆盖 `DEEPSEEK_MODEL`/`/model` 档位配置、auto 判题路由（TS/Rust 判题模型不一致已标注）、Footer 状态栏（余额/ctx/cache hit）等此前路由 miss 的路径；drills 补两条真实 miss prompt

### Added
- **AI 会话标题**（参考 Claude Code `utils/sessionTitle.ts`；TS `src/session-title.ts` + Rust `deepdive-core/src/session_title.rs` 双实现，行为对齐）：新会话**首条真实 user 消息**后用 flash 模型（`DEEPSEEK_SUMMARY_MODEL`，同 turn-summary 档位）一次性生成中文标题，fire-and-forget 不阻塞 UI
  - **Prompt**：中文 3-10 字、强制 `{"title":"..."}` JSON、好/坏例子（对齐 claude 的 sentence-case 英文版 → 中文）；`extractTitleJson` 宽容解析（兼容 markdown 围栏/前后缀杂文）
  - **输入**：`firstRealUserText` 跳过 meta / slash 命令 / `!bash`，截断 1000 字；15s 超时；**任何失败静默**返回 null，本次会话不重试（对齐 claude 的 `haikuTitleAttemptedRef` 一次性门）
  - **落点**：成功后写 JSONL `meta.title`（`updateSessionTitle`/`update_session_title` → 会话 Picker 显示）+ 同步终端 tab 标题（`setSessionTitle`/`app.session_title`）；`/rename` 手动名仍最高优先
  - **恢复/清空语义**：恢复会话不重新生成（resume 种子 gate）；`/clear` 后视为新会话重置 gate
  - 单测：TS 9 条 + Rust 3 条（JSON 解析、真实消息过滤、fetch 成功/失败路径）
  - codemap 回写：session 模块新增 feature/ai-title 单元，ui/terminal-title 范围边界更新（R2）
- **终端 tab/窗口标题**（参考 Claude Code `useTerminalTitle`/`AnimatedTerminalTitle`；TS `src/terminal-title.ts` + Rust `deepdive-rs/…/terminal_title.rs` 双实现，行为对齐）
  - **机制**：一个通用 ANSI 序列 OSC 0（`ESC]0;<title>BEL`）覆盖全部现代终端（iTerm2/Ghostty/Kitty/WezTerm/Alacritty/Windows Terminal/VS Code 终端），无需逐终端适配；仅两个特例——Windows classic conhost 不认 OSC → `process.title`（Node 内部 SetConsoleTitleW）/ Rust FFI `SetConsoleTitleW`（零新依赖，PARITY_SPEC §0.1）；Kitty 用 ST 终止符（`ESC\`）免响铃
  - **内容**：空闲 `✳ DeepDive`；busy 时 `⠂/⠐` 前缀动画（960ms，claude-code 同款节奏）；`/rename` 会话名优先（恢复会话也从 JSONL meta 带出，TS 经 `initialSessionTitle` prop、Rust 存 `app.session_title`）
  - **退出清理**：TS 在 Ctrl+C 退出路径、Rust 在 `region.leave` 后清空标题，防止 tab 残留「✳ 优化测试…」式陈旧标题
  - **开关**：`DEEPDIVE_DISABLE_TERMINAL_TITLE`（truthy）同时关闭设置与清理（对齐 `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`）
  - 单测：TS 10 条 + Rust 5 条（OSC 序列生成、kitty 检测、ANSI 剥离、env truthy、标题组合）
  - codemap 回写：ui 模块新增 feature/terminal-title 单元（R2）
- **Ctrl+C 退出时打印恢复命令**（TS + Rust）：双击 Ctrl+C 退出后，终端恢复时打印一行可复制的 `deepdive -r <会话id>`（Rust TUI 为 `deepdive-tui -r <id>`），用户复制即可继续该会话，省去 `-r` 后选择会话的步骤
  - 仅当会话 JSONL 已落盘才打印（`src/session.ts` 新增 `sessionExists`）：新会话未发任何消息不会生成文件，此时 `-r` 会报 "Session not found"，打印只会误导
  - TS：`src/components/App.tsx` 在 ink `exit()`（同步 unmount 恢复终端）之后、`process.exit(0)` 之前 `process.stdout.write`；Rust：`deepdive-rs/crates/deepdive-tui/src/main.rs` 新增 `sid_tx`/`sid_rx` 通道把引擎侧会话 id（新建/`/resume`/`/clear` 三处）带回 UI，`run` 改为返回 `Result<Option<String>>`，在 `region.leave` + `disable_raw_mode` 之后 `println!`
  - codemap 回写：新增「会话与持久化」模块路由（`docs/codemap/session/`，含 feature/session-resume + feature/exit-hint 两个单元）

## 2026-07-05

### Added
- **`deepdive mcp` 命令行管理**（参考 Claude Code `claude mcp add/list/get/remove`；TS `src/mcp/cli.ts` + Rust `deepdive-cli/src/mcp_cli.rs` 双实现，行为对齐）
  - `deepdive mcp add [-t stdio|http|sse] [-s user|project] [-e K=V]… [-H "Name: value"]… <name> [cmdOrUrl] [args…]`：写入 MCP 服务器配置；stdio 支持 `--` 分隔 command+args
  - `deepdive mcp list` / `get <name>` / `remove [-s …] <name>`：列出/查看/删除（remove 未指定 scope 时两个 scope 都删）
  - **scope**：`user`（默认）→ `~/.deepdive/settings.json` 的 `mcpServers`；`project` → `<cwd>/.mcp.json`（保留文件其它键）。仅接受 user/project（不设 `local` 别名，避免与 Claude Code 语义混淆）
  - 序列化 `transport_to_json`/`transportToJson` 与配置加载器互逆（单测锁定该 parity 契约）；`cli.tsx`/`main.rs` 在渲染前拦截首参 `mcp`，无需 API key、下次启动生效
  - `/mcp` 空状态提示、`deepdive -h`/clap after_help 同步指向新命令

## 2026-07-04

### Added
- **MCP（Model Context Protocol）客户端**（参考 Claude Code；TS `src/mcp/` + Rust `deepdive-rs/…/mcp/` 双实现，行为对齐）
  - 连接外部 MCP 服务器，发现其 `tools/list`，把工具以 `mcp__<server>__<tool>` 暴露给模型，模型调用时路由回服务器 `tools/call`
  - **传输**：stdio（本地子进程）+ streamable HTTP + legacy SSE。Rust 侧零新依赖手写（`tokio::process` + `reqwest`/自研 SSE 关联器）；TS 侧用官方 `@modelcontextprotocol/sdk`
  - **配置**：全局 `~/.deepdive/settings.json` 的 `mcpServers` 键 + 项目根 `.mcp.json`（项目覆盖同名）。传输推断：有 `command`→stdio，否则 `type`(http/sse)+`url`
  - **schema 注入**：连接后一次性冻结工具 schema，追加到 `ALL_TOOLS` 之后（`build_body`/`buildBody`），全会话字节恒定 → 不破坏 DeepSeek prefix cache；子代理 v1 不含 MCP
  - **审批**：MCP 工具默认必弹审批（yolo 除外）；权限规则 `mcp__server__tool`（精确）/ `mcp__server`（整服务器），deny>ask>allow；「always allow」持久化精确工具规则；plan 模式屏蔽 MCP（非只读）
  - **生命周期**：会话启动连接（逐 server 30s 超时、失败非致命）；`/clear`/`/resume` 保留连接；退出杀子进程
  - **`/mcp` 命令**：列出各服务器连接状态/传输/工具数/错误（CLI + TUI）；工具卡显示为 `server: tool`
  - 端到端验证：Rust + TS 各有 stdio mock server 集成测试；真实 `@modelcontextprotocol/server-filesystem` 连接/发现/调用通过

### Fixed
- **Deep Diving 动画延迟**：发送消息后 "Deep Diving" 动画没有立即出现。根因是 `handleSubmit` 中 `setIsStreaming(true)` 位于 `await findRelevantMemories()`（内存召回）之后，而内存召回是异步的，导致动画在召回完成前不显示。修复：将 `setIsStreaming(true)` / `isStreamingRef.current = true` 移到内存召回之前，用户发送消息后立即看到动画反馈。
- **thinking→content 回填**：LLM 有时把回答全部写在 `reasoning_content` 中而 `content` 为空，导致用户看不到回答（仅看到 `✓ thinking (ctrl+o to view)` 标题行）。修复：`assemble_turn` 在流正常结束且 `content` 为空时，将 `reasoning_content` 复制到 `content`；`/btw` side question 额外兜底工具调用+thinking 场景。涉及 `turn.rs`、`side_question.rs`、`side-question.ts`。

## 2026-06-14

### Added
- **自定义 agent（`.deepdive/agents/*.md`）**（`src/agents/load.ts` + `registry.ts` + `listing.ts`）
  - 对齐 Claude Code 的 `.claude/agents/*.md`：扫描 `~/.deepdive/agents` 与项目 `.deepdive/agents` 下的 `*.md`，frontmatter `name`→agentType、`description`→whenToUse、`tools`（缺省/`*`/`all`=全部，`none`/空=无，逗号列表=allowlist）、`disallowedTools`、`model`，正文=persona system prompt（复用 `skills.ts` 的 `parseFrontmatter`）
  - 优先级 last-wins：built-in < user < project（按 agentType 去重，`realpath` 去重重复文件）
  - **可用 agent 列表改为 system-reminder 注入**（`makeAgentListingMessage`，仿 skill listing），`agent` 工具描述去掉硬编码列表、`subagent_type` 去掉 enum 限制 → tools schema 字节恒定，自定义 agent 不破坏 DeepSeek prefix cache；`client.ts` 把该 listing 定位到 system 消息之后的稳定缓存区
  - `/agents` 命令列出全部 agent（含来源与工具范围），按需热重载目录
- **Background agent / background bash（`run_in_background`）**（`src/tasks/store.ts` + `notification.ts` + `App.tsx`）
  - 对齐 Claude Code 的后台任务内核：detached 非阻塞 spawn + 立即返回 `task_id` + 内存输出缓冲 + `notified` 去重的完成通知
  - `agent` 与 `bash` 工具新增 `run_in_background`；后台 agent 用独立 `AbortController`，后台 bash 用 `executeBash(..., {background:true})`（不超时、不因输出超限被杀），二者均跨回合存活、不受 Esc/回合中断影响
  - 新增 `task_output(task_id, wait?)` 读状态/输出、`task_stop(task_id)` 终止；两者归类 read-only（永不弹审批），且加入 `SUBAGENT_EXCLUDED`（子 agent 不可用）
  - 完成通知走 meta system-reminder 通道（`<task-notification>`，含 task-id/kind/status/result）；**空闲时自动续一回合**让模型立即读取结果，回合进行中则在结束后投递
  - Footer 新增「⚙ N bg」运行指示器；并发软上限 `MAX_BACKGROUND_TASKS=10`；进程退出/卸载时清理在跑任务
  - 新增回归测试：`tasks-store.test.ts`、`agents-registry.test.ts`

## 2026-06-04

### Added
- **`/add-dir` 目录自动补全**（`src/components/InputBox.tsx`）
  - 输入 `/add-dir <partial_path>` 后，输入框下方按名称排序列出可选目录（最多 10 条）
  - 上下键滚动选中，选中行高亮蓝色，Tab / Enter 补全
  - 忽略大小写前缀匹配；带 `/` 时列出下一级目录内容
  - Async `readdir` + `useEffect` 驱动，带取消/过期检测，不破坏现有 slash command 补全
  - 补全返回值自动附带尾随 `/`，方便继续逐级导航

## 2026-06-03

### Fixed
- **Search（grep）支持工作区外路径**：移除了 `runGrep` 中的硬拦截 `"Error: path escapes workspace"`，与 `read_file`/`write_file`/`edit_file` 对齐，改为上游确认框控制（`src/tools/executor.ts:403`，`src/components/App.tsx:947`）
  - 路径显示也统一处理：工作区内显示相对路径，工作区外显示绝对路径

### Added
- **`/add-dir` 对齐 Claude Code**（`src/commands/adddir.ts` + `src/components/AddDirConfirm.tsx` + `src/client.ts`）
  - 路径校验：`stat()` 检查存在性与目录类型，处理 `ENOENT`/`EACCES` 等错误码
  - 去重检测：已覆盖目录返回提示（对齐 Claude Code `alreadyInWorkingDirectory`）
  - 确认对话框：`AddDirConfirm` 组件，三选一 — 当前会话 / 当前工作区所有会话（持久化） / 拒绝
  - **System prompt 注入**：持久化目录（`config.additionalDirectories`）在 `envInfo()` 中输出 `Additional working directories:` 行，仅冻结合话启动时加载的值，不破坏 DeepSeek KV prefix cache
  - **Meta 消息注入**：会话中途 `/add-dir` 新增的目录以 `meta: true` user 消息追加到历史，`stripNonApiFields` 删标志留 content，下轮请求起模型可见

### Fixed
- **Bash 输出截断 — 防止上下文爆炸**：对齐 Claude Code 的做法，对 `runBash` 和 `executeBash` 的输出加上截断保护
  - 默认上限 30,000 字符（与 Claude Code `BASH_MAX_OUTPUT_DEFAULT` 一致）
  - 环境变量 `DEEPDIVE_MAX_BASH_OUTPUT` 可覆盖，上限 150,000 字符
  - 超量输出在尾部截断并追加 `[output truncated — XKB removed]` 标记
  - 流式模式（`executeBash`）内存中只保留上限内的内容，TUI 实时显示不受限
  - 修复了 `8f59eeb0` 会话中单条 `execSync` 返回 2.6MB 日志导致上下文消耗 77 万 token 的问题
- **Bash 超时机制**：对齐 Claude Code 的 `timeouts.ts`，默认 120s / 最大 600s
  - Schema 新增 `timeout` 参数（ms），模型可按需传参覆盖默认值
  - 环境变量 `DEEPDIVE_BASH_DEFAULT_TIMEOUT_MS` / `DEEPDIVE_BASH_MAX_TIMEOUT_MS` 可覆盖
  - 超时时返回清晰消息 + 部分输出，引导模型缩小路径或加长 timeout
  - `executeBash`（流式模式）同样用 `resolveBashTimeout` 替换硬编码 30000ms

### Added
- **工作区隔离 — 按项目分目录存储会话**：对齐 CLAUDE-CODE 的 `projects/{sanitized-cwd}/{id}.jsonl` 布局，不再平铺在 `sessions/` 下
  - 新增 `src/workspace.ts`：`setOriginalCwd()` / `getOriginalCwd()`，启动时冻结工作目录
  - `src/session.ts`：`sanitizePath()` 将绝对路径转为目录名（`D:\code\DeepDive` → `D--code-DeepDive`）；`projectDir(cwd)` 管理项目隔离目录
  - 所有文件工具、bash 执行、`displayPath()` 改用冻结的 `getOriginalCwd()`，不再跟随 live `process.cwd()`
  - Session Picker 直接 `readdir(projectDir)`，无需逐条读 `cwd` 过滤，标题栏显示当前项目目录

### Changed
- **pending 队列在 loop 内注入**：不再等待整个 while 循环结束后才发送 pending 消息。每次工具调用完成、tool result 追加到 history 后，立即检查 `pendingQueue` 并将排队的用户消息注入到 history 里，下一轮 `runTurn` 会一并发送给模型。新增 `pendingQueueRef` 保持异步 handler 内读取最新值。

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

### Added
- **`/rename <title>` slash command**：重命名当前会话，标题会更新在 `~/.deepdive/sessions/` 的 JSONL 元数据中，下次 `-r` 恢复时以新名称显示在 Session Picker。新增 `src/commands/rename.ts`，在 `SlashCommandContext` 中扩展 `sessionId` 和 `renameSession` 字段。

### Fixed
- **pending 队列背景跨行**：修复 pending 消息队列渲染时使用 `content.length` 计算宽度导致宽字符（CJK/emoji）时 padding 溢出换行的问题。改用 `stringWidth(content)` 正确计算终端列宽，并简化为 `<Text backgroundColor>` 单层结构，与 `Chat.tsx` 用户消息渲染保持一致。

### Changed
- **最终回复判定改用官方 `finish_reason`**：外层 while 循环原来通过 `!lastMsg.tool_calls` 隐式推断"最终回复"，现在改为使用 DeepSeek API 返回的 `finish_reason` 标识位。`runTurn` 现在返回 `{ messages, finish_reason }`，外层循环在 `finish_reason !== "tool_calls"` 时 break，与 API 语义对齐。

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
