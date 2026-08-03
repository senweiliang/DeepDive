# 退出提示单元导航（nav）

**一句话**：Ctrl+C 双击退出时，在终端恢复后打印一行可复制的 `deepdive -r <会话id>`（Rust TUI 为 `deepdive-tui -r <id>`），用户复制即可继续该会话，免去 Picker 选择步骤；仅当会话 JSONL 已落盘（有内容）才打印，空会话恢复会失败。

**关键词**：退出 / 退出提示 / ctrl+c / ctrl-c / exit / `deepdive -r` / resume 命令 / sessionId / `sessionExists`

## 上下文闭包

- 落点 → `src/components/App.tsx`（`useInput` 双击 Ctrl+C 分支：`exit()` 后、`process.exit(0)` 前打印）、`deepdive-rs/crates/deepdive-tui/src/main.rs`（`run` 返回值经 `sid_tx`/`sid_rx` 通道带出会话 id，`region.leave` + `disable_raw_mode` 之后打印）
- 机制依赖 → [会话持久化与恢复](../session-resume/)：`sessionExists` / `session_path().exists()` 判空；会话 id 由 `newSessionId` 铸造
- 必读红线 → 打印必须放在 ink `exit()`（同步 unmount，恢复终端/擦除帧）之后，否则文字落在 alt-screen/被擦除；Rust 侧须在 `region.leave` 与 `disable_raw_mode` 之后，否则被区域清理吃掉

**状态**：⏳
