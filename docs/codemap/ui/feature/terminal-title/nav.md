# 终端标题单元导航（nav）

**一句话**：终端 tab/窗口标题（OSC 0），空闲 `✳ DeepDive`、busy 时 `⠂/⠐` 动画（960ms）、`/rename` 会话名优先、退出时清空；`DEEPDIVE_DISABLE_TERMINAL_TITLE` 可整体关闭（设置与清理都关）。

**关键词**：终端标题 / tab 标题 / 窗口标题 / title / OSC 0 / ✳ / ⠂ / /rename 联动

## 上下文闭包

- 机制契约 → `src/terminal-title.ts`（port 自 Claude Code `useTerminalTitle`）：OSC 0 序列 `ESC]0;<title>BEL`（kitty 用 ST `ESC\` 免响铃）；Windows classic conhost 不认 OSC → `process.title`；ANSI 剥离防 `/rename` 注入；env truthy 判定
- Rust 对应 → `deepdive-rs/crates/deepdive-tui/src/terminal_title.rs`：非 Windows 写 OSC 0，Windows 用 FFI `SetConsoleTitleW`（零新依赖，PARITY_SPEC §0.1）
- 落点 → `src/components/App.tsx`（useEffect 设置标题 + busy 动画帧 + Ctrl+C 退出路径 `clearTerminalTitle`）、`src/cli.tsx`（恢复会话把 meta.title 传入 App）、`deepdive-rs/crates/deepdive-tui/src/main.rs`（主循环仅在标题变化时写、`region.leave` 后清理）、`deepdive-rs/crates/deepdive-tui/src/app.rs`（`session_title` 字段，`/rename`/AI 标题/恢复会话写入）
- 范围边界 → 标题优先级：`/rename` 会话名 → AI 生成标题（见 [AI 会话标题](../../session/feature/ai-title/)）→ 默认 `DeepDive`；无 `terminalTitleFromRename` 设置项（默认开启，靠 env 关闭）

**状态**：✅
