# DeepDive TUI 复刻契约（ratatui ← Ink/TS）

本文件是把 `deepdive-tui`（Rust/ratatui）逐像素对齐到旧版 TS/Ink TUI 的**唯一权威规格**。
所有 workflow agent 必须先读本文件，再读对应 TS 源码核对细节。

- TS 源（权威外观）：`/Users/senweiliang/workspace/DeepDive/src/cli.tsx` + `/Users/senweiliang/workspace/DeepDive/src/components/*.tsx` + `/Users/senweiliang/workspace/DeepDive/src/theme.ts`
- Rust 现状：`/Users/senweiliang/workspace/DeepDive/deepdive-rs/crates/deepdive-tui/src/{main.rs,app.rs,ui.rs}`
- 工作区：`/Users/senweiliang/workspace/DeepDive/deepdive-rs`
- 编译：`~/.cargo/bin/cargo build -p deepdive-tui`（本机 cargo 在 ~/.cargo/bin）
- crate 二进制名：`deepdive-tui`；引擎在 `deepdive-core`（**不要改 core 的公共 API**）。

## 0. 硬约束

1. **不新增第三方依赖**（仅用现有 `ratatui 0.29` / `crossterm 0.28` / `tokio` / `serde_json` / `anyhow` / `futures-util` / `tokio-util`）。markdown 渲染器手写；figlet 字模硬编码；语法高亮第一阶段先不做（代码块单色）。
2. **不改 `deepdive-core`**。只动 `crates/deepdive-tui/`。
3. 全局规则：**禁止 QStringLiteral**（这是 C++ 规则，Rust 无关，忽略）；transcript 的 `⎿` 标记后**恒单空格**；间距统一「块尾留 1 空行、由上块拥有，绝不 leading、绝不嵌套累加」。
4. 颜色用 `Color::Rgb`，严格照下表 hex。「dim」= 默认前景 + `Modifier::DIM`（不要硬编码灰 hex，保持随终端前景）。
5. 完成判据：`cargo build -p deepdive-tui` 通过、`cargo test -p deepdive-tui` 通过、`cargo clippy -p deepdive-tui` 无 error。

## 1. 颜色表（theme.rs，从 theme.ts 移植）

| 常量 | hex | 用途 |
|---|---|---|
| ACCENT | #61afef | 品牌蓝：banner、工具名加粗、标题、inline code、命令高亮、列表选中(导航类) |
| SUCCESS | #8cd369 | 完成 `●`、diff `+`、cache hit、Auto 模式 |
| ERROR | #e06c75 | 错误 `●`/文本、diff `-`、YOLO 模式、ctx≥80% |
| THINKING | #f0c14b | thinking 标题(展开/active)、blockquote 竖线、`…` 截断、注释高亮 |
| THINKING_BODY | #d8a82f | thinking 正文 |
| THINKING_FOLDED | #a07c22 | thinking 折叠态单行 |
| APPROVAL | #d8885a | Default 模式、ctx≥60%、审批类标题、AskQuestion 未答提示 |
| ACTION | #56b6c2 | Plan 模式、bg 任务、链接、审批类选中项 |
| COST | #c678dd | 余额 ¥、AcceptEdits 模式 |
| BASH | #d87093 | `!` bash 提示符与分隔线 |

非 theme 固定背景色：用户消息条 `#3a3a3a`；diff 增行底 `#1a3a1a`；diff 删行底 `#3a1a1a`；软光标 = 白底黑字。
Splash（本阶段**不做**）：白字 #ffffff + 副标题 #8ebfdf + 波纹 #0d1b2a→#61afef。

## 2. 架构改造（最关键，Scaffold 阶段负责）

目标：**不进 alternate-screen**；历史（已提交块）写入终端原生 scrollback，可用鼠标滚轮回看；底部是一块高度受控的动态帧（流式预览 + 输入框 + footer + 弹窗）。等价于 Ink 的 `<Static>` + 底部动态区。

实现（crossterm 手动区域，见 `src/region.rs`）：
```
enable_raw_mode();                         // 仍要 raw mode
// 不要 EnterAlternateScreen
DisableLineWrap;                           // 整宽行(rule/横条)不得换行成 2 行
```
> **历史教训**：原计划用 ratatui `Viewport::Inline(bottom_h)` + 「固定上限每帧留白」。实测：固定高度在空闲时输入框下方留一片空行；而 inline 视口高度**创建后无法廉价改动**——`resize` 到小尺寸丢 banner 且破坏 `insert_before`，每帧重建视口则因 `compute_inline_size` 发 DSR 查询光标在流式高频重绘下**超时崩溃**。故改为下述 Ink/log-update 式手动区域，不再用 ratatui 的 Terminal/viewport。

- **历史落盘**：每当一个 transcript 块「定稿」（用户消息、助手整段、工具行+结果、thinking 提交、错误、压缩摘要、子代理组），渲染成 `Vec<Line>`，由 `region` 在动态区**上方**逐行打印；打印满屏后自然滚入原生 scrollback（只增不改，符合 Ink Static 语义）。
- **底部动态区**（`LiveRegion::render`，Ink/log-update 式，全相对光标移动、零 DSR）：①流式预览（thinking 行 + 未定稿的回答尾块）②运行中 Running 波形 ③弹窗（互斥替换 ④⑤）④输入框 ⑤footer。**高度恰为内容行数**——帧首相对移到区域顶、逐行重绘、`Clear(FromCursorDown)` 收缩、再移到输入光标。`BeginSynchronizedUpdate` 防撕裂，行级 diff 跳过空闲重绘。
- **高度封顶**：动态区总高度 `< 终端行数`（`max_inline = term_rows - 1`），流式预览按预算从头裁剪、超出的靠「逐块落历史」消化。
- **resize**：终端 reflow 会打乱相对光标记账 → `reset_for_resize` 清屏，并重置 `app.committed=0 / banner_shown=false` 全量重放（banner + 全部行），按新宽度重绘。
- **退出**：`region.leave`（把光标落到区域下方，shell 提示符在新行恢复）→ `EnableLineWrap` → `disable_raw_mode`。panic hook 另加 `EnableLineWrap + Show`。
- Ctrl+O 全屏 transcript（Ink 用 alt-screen 自绘分页）**本阶段不做**，留后续；保留按键占位。

## 3. 模块文件树（Scaffold 建立）

```
crates/deepdive-tui/src/
  main.rs            # 入口 + 事件循环 + insert_before 落历史 + 按键分发（Scaffold 重写）
  app.rs             # 渲染模型 AppState（Scaffold 扩展数据模型）
  theme.rs           # 颜色常量 + helpers（Scaffold 完整实现）
  ui.rs              # 底部动态帧组装：调用 render::* （Scaffold 写框架，调用占位）
  render/
    mod.rs           # pub mod 声明
    markdown.rs      # render_markdown()           —— Module: markdown
    transcript.rs    # 各 Row → Vec<Line>          —— Module: transcript
    footer.rs        # render_footer()             —— Module: footer
    running.rs       # render_running()/spinner    —— Module: running
    banner.rs        # banner_lines()              —— Module: banner
    input.rs         # InputBox 渲染+编辑状态      —— Module: input
    modals.rs        # 弹窗渲染                    —— Module: modals
```

并发安全规则：**Module agent 只填自己那个文件的函数体**，不改 `mod.rs`、不改 `app.rs` 的公共类型、不改 `theme.rs`。需要的共享类型/签名由 Scaffold 在占位阶段全部建好（`todo!()` 或返回空 `Vec`）。Module 内可自由加私有 helper / use。

## 4. app.rs 数据模型扩展（Scaffold）

现有 `Row` 枚举需扩展，至少支持以下定稿块类型（供 transcript.rs 渲染）：
- `User(String)`（普通）/ 新增区分 bash 用户消息 `UserBash(String)`（提示符 `! `）
- `Assistant(String)`（走 markdown 渲染，首行 bullet `● `，续行 `  `）
- `Thinking { content: String, expanded: bool }`（折叠态默认；本阶段可恒折叠）
- `Tool { name, summary, tag: Option<String>, ok: bool }`（`● Name(args)` + `⎿` 结果）
- `Diff { added: u32, removed: u32, lines: Vec<DiffLine> }`（edit/write，本阶段可简化为按 ```diff 解析；或先并入 Tool 的 tag，第一阶段允许降级）
- `SubagentGroup { header: String, steps: Vec<String>, summary: Option<String> }`（`● Agent(..)` + 缩进 `⎿` 步骤）
- `Note(String)`（dim 提示，如 /compact 提示）
- `Error(String)`（首行 `● ` 红 + 续行 `  ` 红，正文默认前景）
- `Compaction(String)`（压缩摘要：横线 + `⎯ Context compacted · summary below ⎯` + 横线 + 缩进 5 空格正文，全 dim）

新增字段（按需）：`mode: ApprovalMode`、`usage`、`bg_tasks`、`balance`、流式 `live_thinking/live_content`、InputBox 编辑状态（多行文本、光标 offset、历史、paste pill、slash 菜单状态——本阶段可先放最小集，详见 §7）。

`Modal` 扩展：现有 `Approval/Question/Resume`，新增（本阶段可建占位）`Model`、`Settings`、`AddDir`。

> 注意保留现有 `app.rs` 的单元测试语义（streaming/tool patch/question/resume），扩展不要破坏它们；可调整测试以匹配新结构。

## 5. 各 Row 渲染规格（transcript.rs）

标记常量（唯一真相）：`MARKER = "  ⎿ "`（2 空格 + ⎿ + **单**空格，⎿=U+23BF）；续行 `MARKER_CONT = "    "`（4 空格，无 ⎿）。MARKER 前缀渲染 **dim**，其后内容按各自色。

- **User**：每行 `> {line}`，整行右填充空格到满宽，背景 `#3a3a3a` 横条；前缀 `> `（U+003E+空格）默认前景；多行每行各自横条。块尾 1 空行。
- **UserBash**：同上但前缀 `! `，同 `#3a3a3a` 条；若带输出，紧随其下渲染为 `⎿` 结果（不截断）。
- **Assistant**：交给 `markdown::render_markdown(content, cols-2)`，首行加 `● `（默认前景，**非绿**），续行 `  `。块尾 1 空行。
- **Thinking**：折叠态单行 `✓ thinking (ctrl+o to view) (<N> chars)`，色 THINKING_FOLDED；展开态标题 `✓ thinking (<N> chars)` 色 THINKING + 正文色 THINKING_BODY。字数：>1000 显 `(x.xK chars)` 否则 `(N chars)`。active 流式时标题 spinner `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`（80ms）色 THINKING。
- **Tool 调用行**：`{dot}{ToolName 加粗}({args})`。dot=`● `：error→ERROR，done→SUCCESS，running→闪烁(`● `↔`  ` 每 540ms，默认前景)，pending→默认前景。ToolName 加粗、默认前景（**非 accent**）。显示名映射：bash→Bash, edit_file→Edit, read_file→Read, write_file→Write, glob/grep→Search, web_search→WebSearch, web_fetch→WebFetch, skill→Skill, ask_user_question→AskUser, agent→Agent, task_output→TaskOutput, task_stop→TaskStop，其余原名。args 摘要截断到 `max(80, floor(cols*0.8))`，截断尾加 `…`。`ask_user_question` 特例：无括号，成功显示 `用户已回答：`。
- **Tool 结果（⎿）**：去掉首部纯空白行与尾部换行；每行 `MARKER|MARKER_CONT`+内容；内容色：error tone（内容以 `Error:` 开头）→ERROR，否则默认前景+dim；每行截断到 `max(20, cols-5)`，尾 `…`；默认最多 3 行（`RESULT_PREVIEW_LINES`），超出加 dim `    … +N lines`；用户 bash 输出不截断。
- **Diff**：stats 行 `  ⎿ Added N lines, removed M lines`（dim）；每行 4 空格左 pad + 行号槽 ` n ` + 内容，整行填充到 `cols-5`；增行行号 SUCCESS + 背景 `#1a3a1a`，删行行号 ERROR + 背景 `#3a1a1a`，上下文无背景默认色；write_file 截断 20 行。（第一阶段若紧张可先把 diff 当普通 ⎿ 文本，标注 TODO。）
- **SubagentGroup**：header 为普通工具行 `● Agent(type: desc)`；其下全 dim，首步 `MARKER` 其余 `MARKER_CONT`；summary 行各自带 `MARKER`：`done · N turns · M tool calls`。inline 只显示最后 3 步。
- **Note**：dim 文本（可带 `⎿`，视来源）。
- **Error**：首行 `● ` 色 ERROR，续行 `  ` 色 ERROR；正文默认前景。
- **Compaction**：`  ` + `─`×(cols-6) dim；`  ⎯ Context compacted · summary below ⎯` dim+bold（⎯=U+23AF）；再一条横线；正文每行缩进 5 空格 dim。

块间距：每块自带尾部 1 空行（见 §0.3）。

## 6. markdown.rs 规格（render_markdown(md, width) -> Vec<Line<'static>>）

每个 block → 若干「整行」Line（一行一终端行）。空行=空 Line。宽度=`width`（调用方传 `cols - 前缀宽`）。
- **标题 h1–h6**：全部仅「整段加粗」，无 `#`、无色、无大写、无下划线。
- **段落**：默认前景，行内样式（粗/斜/code/链接）生效。
- **无序列表**：marker `• `（U+2022+空格，宽 2）；有序 `N. `；续行缩进=marker 宽。嵌套仅减小 wrap 宽度 + 重新发 bullet，**不累加缩进**。
- **代码块** ```：无背景无边框无行号；有语言则前面一行 dim 语言名；每行截断到宽度（尾 `…` 用 THINKING 色）；**第一阶段单色**（不做语法高亮，标注 TODO）。
- **inline code**：色 ACCENT（若已在链接内则保留链接色）；作为整体不可在内部换行。
- **粗 `**`** → BOLD；**斜 `*`** → ITALIC；**删除 `~~`** → CROSSED_OUT；均不改色、可嵌套。
- **链接 [t](u)**：显示文本，色 ACTION + 下划线（OSC8 可选，本阶段可只样式化文本）。
- **引用 `>`**：每非空行前缀 `▏ `（U+258F+空格）色 THINKING + 正文 dim；内宽 `max(10,width-2)`。
- **水平线 `---`**：`─`×width，默认前景。
- **表格**：盒线 `┌┬┐├┼┤└┴┘│─`，列宽按内容、超宽按比例缩 + 余数轮转分配，单元 `…` 截断，对齐按 align，表头不特殊着色。（**第一阶段可降级**：表格按原文逐行输出 + TODO。）
- **换行**：按空白软换行（贪心、不在词中断、code span 原子）；宽度用 unicode 宽度（CJK=2）；硬换行 `br`→强制换行；连续空行折叠为 1。

## 7. input.rs 规格（InputBox 渲染 + 编辑）

外观：无矩形框；上下各一条满宽 `─`（dim；bash 模式 BASH 色不 dim）；首行提示符 `> `（默认前景；bash 模式 `! ` 色 BASH，吃掉开头 `!`，显示 value[1:]）；续行前缀 `  `（2 空格）；文本可用宽 `cols-2`。无占位文案。
软光标：光标所在字符渲染白底黑字；行尾光标=行尾一个白底黑字空格。
**第一阶段范围**：多行输入（Ctrl+J/Ctrl+M 插入换行、Enter 提交）、上下/左右/Home/End 光标移动、Backspace/Delete、bash `!` 提示符与边线变色、`/` 斜杠命令补全列表（见下）、命令 token 命中后整体染 ACCENT。
**slash 补全列表**（取代下边线位置，并通知隐藏 footer）：上方一条 dim `─`；每项 `  {name}{pad}  {desc}`，name 列宽 `max(20, 最长+2)`，选中项整行 ACCENT 不 dim、未选 dim；上下循环；过滤 `name.startsWith(input) && name!=input`，字母序。内置命令（≥）：`/add-dir /agents /clear /compact /model /rename /settings`（按字母序；本 Rust 端实际生效的先接 `/clear /compact /resume /mode /help`，其余可列出但提示未实现，标 TODO）。
**后续阶段**（本阶段不做，建占位）：历史回溯（↑ 到首行行首进入）、paste pill 折叠（`[Pasted text #N +K lines]` dim）、`/add-dir` 目录候选补全。

## 8. footer.rs 规格

容器左右各 2 列 padding，段间 2 空格，超宽换行。若有 hint（如退出提示）→ 整条只显 dim hint。否则从左到右：
1. `{model 加粗 ACCENT}` ` `(空) `|`(dim) ` ` `{modeLabel 加粗 modeColor}`
2. `in: {tok}  out: {tok}`（dim）。`tok`：>1000→`(n/1000).1f + "K"`（大写 K）否则整数。
3. `cache hit: {pct}%`（有→SUCCESS）/ `cache hit: —`（无→dim，em dash U+2014）
4. `ctx: {in}/{window} ({pct}%)`（pct≥80→ERROR，≥60→APPROVAL，否则默认前景）。仅当有 contextWindow。
5. `¥{balance}`（COST 紫，¥ 紧贴数字）。仅当有余额。
6. `⚙ {n} bg task(s)`（ACTION 青）。仅当 n>0。

modeLabel/色：default→`Default`/APPROVAL；acceptEdits→`Accept Edits`/COST；plan→`Plan`/ACTION；yolo→`YOLO`/ERROR；auto→`Auto`/SUCCESS。模式文本恒加粗。

## 9. running.rs 规格

单行：`[5 波形格][空格][动词逐字符][可选 hint]`。
- 波形 `CELLS=5`，字符集 `BLOCKS=["▁","▂","▃","▄","▅","▆","▇","▆","▅","▄","▃","▂"]`（12 帧），格 i 显示 `BLOCKS[(frame + i*2) % 12]`。
- tick `TICK_MS=90`；另有 1s 计时显示耗时。
- 颜色 truecolor 渐变：暗 `#3a6696` ↔ 亮 `#8ecbff`（始终蓝、绝不褪白）。`shade(level)`=按 level 在两端点 lerp。波形格 i 亮度 `b=0.5+0.5*sin(frame*0.5 - i*0.9)`，色 `shade(0.35+0.65*b)`；动词字符 j 亮度 `b=0.5+0.5*sin(frame*0.45 - j*0.55)`，色 `shade(0.5+0.5*b)`。
- 默认动词 `Deep Diving`（逐字符高光扫过）。`DOT_BLINK_MS=TICK_MS*6=540`（工具 running dot 闪烁周期）。
- hint（默认显示）：dim ` · {耗时} · esc 中断`（中文「esc 中断」）；耗时格式 `<60s→Ns`，`<60m→Mm`/`Mm Ss`，否则 `Hh`/`Hh Mm`。

## 10. banner.rs 规格

会话顶部静态横幅（进入会话后第一个落 scrollback 的块）。figlet Slant「DeepDive」6 行（每行宽 43，保留前导空格），全部 ACCENT 色、无渐变。精确字模：
```
    ____                  ____  _          
   / __ \___  ___  ____  / __ \(_)   _____ 
  / / / / _ \/ _ \/ __ \/ / / / / | / / _ \
 / /_/ /  __/  __/ /_/ / /_/ / /| |/ /  __/
/_____/\___/\___/ .___/_____/_/ |___/\___/ 
               /_/                         
```
其下 1 空行；再两行 meta：`  ` + label（dim，padEnd 到 11）+ value：`version  v0.1.0` / `workspace  {cwd, home→~}`。整块尾 1 空行。

## 11. modals.rs 规格（弹窗，渲染在底部动态帧、占满宽度、贴底、无方框）

通用：顶部一条满宽 `─`(dim)；其下 `paddingX:1, 区块间 1 空行`。列表选中前缀 `> `（未选 `  `）。
- **Approval（ConfirmBox）**：标题 `Approve tool execution?`（APPROVAL 橙 bold）；可选 `⚠ {warning}`（ERROR bold，⚠=U+26A0）；工具摘要 `{ToolName bold} {args}`；选项 `{>/  }{i+1}. {label}` 选中行 ACTION 青：`Allow once` /（编辑类）`Allow all edits this session (shift+tab)` /（有 savePattern 非编辑）`Allow always (...)` / `Deny`。↑↓ 选择，Enter 执行。
- **Question（AskQuestion）**：见原组件（多 tab/多选/Other 输入）。**第一阶段**：实现单题 + 多题基础（NavBar tab：选中蓝底黑字 `■/☐`；选项 `> i. label`，选中焦点 ACCENT、已选 SUCCESS+` ✔`；标题 bold；底部 dim 提示）。Other 行内输入与多选 Space 勾选尽量实现；←→ 切题、Enter 确认/提交。Esc 由上层处理。
- **Resume（SessionPicker）**：标题 `Resume session`（ACCENT bold）+ cwd（dim）；提示行 dim；列表第 0 项 `+ New session`（bold，选中 ACCENT），其后每会话两行：`{>/  }{title}`（选中 ACCENT）+ dim `  {when} · {n} msgs`。↑↓/j k 移动、Enter 打开、Esc 取消。
- **Model / Settings / AddDir**：本阶段建占位渲染即可（标题 + 列表 + 提示），完整逐像素留后续 workflow。
  - Model 标题 `Model`(ACCENT bold)，列表 `{i+1}. {label}{ ✓}` 选中 ACCENT，数字键直选。
  - Settings 标题 `Settings`(ACCENT bold)，每行 label+value(选中 ACCENT) + dim 描述。
  - AddDir 标题 `Add workspace directory?`(APPROVAL)，选项 `当前会话/当前工作区所有会话/拒绝`，选中 ACTION。

## 12. 全局键位（main.rs）

模式循环 Shift+Tab：`default→acceptEdits→plan→yolo→auto→default`。
- Ctrl+C：有进行中→中断（cancel + 拒绝挂起审批/问答）+ 提示「再按 Ctrl-C 退出」；空闲→（1s 内二次）退出 / 否则清空输入。
- Ctrl+D：空输入时退出（保留现有行为）。
- Esc：busy→中断当前回合；有弹窗→按弹窗语义取消/拒绝。
- Enter：提交（`/`→slash 命令处理；`!`→inline bash；空→忽略）。
- 弹窗优先级（互斥）：Model→Settings→Approval→Question→AddDir→（否则正常 Running/输入/footer）。slash 菜单展开时隐藏 footer。
- Ctrl+O（全屏 transcript）：本阶段占位不实现。

## 13. 分阶段计划

**Workflow 1（本次）= 架构 + 核心外观主体**，让它一眼就是 TS 版且能编译能跑：
- Scaffold：架构(去 alt-screen + insert_before)、模块树、数据模型、签名占位、theme.rs、cargo build 通过。
- Modules（并行）：markdown(基础，无语法高亮/表格降级)、transcript(各 Row，diff 可降级)、footer、running、banner、input(核心，无 paste/历史/目录补全)、modals(approval/question/resume 完整 + model/settings/adddir 占位)。
- Integrate：build + clippy + test 全绿。
- Review：对照本规格 + TS 源逐组件审查，产出保真度差距清单（结构化）。

**Workflow 2（后续）**：markdown 语法高亮(评估 syntect)+ 表格 + diff view 完整；InputBox paste-pill / 历史 / 目录补全；Model/Settings/AddDir 完整；Ctrl+O 全屏 transcript。
**Workflow 3（后续）**：保真度回归 + bug 修复。

每个 Module agent 完成自己文件后应尽量本地 `cargo build -p deepdive-tui` 自检（可能因其他模块占位而失败，至少保证本文件语法/类型自洽）。
