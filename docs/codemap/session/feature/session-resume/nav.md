# 会话持久化与恢复单元导航（nav）

**一句话**：会话以 JSONL append-only 存于 `~/.deepdive/projects/<sanitized-cwd>/<id>.jsonl`；文件在首条消息时才落盘（空会话不产生文件）；`-r <id>` / `-c`（最近会话）/ 裸 `-r`（Picker）三种恢复入口。

**关键词**：会话 / session / resume / 恢复 / 继续 / `-r` / `-c` / sessionId / `newSessionId` / `loadSession` / `listSessions` / `lastSessionId` / `sessionExists` / `SessionPicker` / JSONL

## 上下文闭包

- 落点 → `src/session.ts`（路径/读写/列表）、`src/cli.tsx`（`parseArgs` 恢复路由）、`src/components/SessionPicker.tsx`（选择界面）、`deepdive-rs/crates/deepdive-core/src/session.rs` + `deepdive-rs/crates/deepdive-tui/src/main.rs`（Rust 对应）
- 数据契约 → 项目目录按冻结 cwd sanitize（`src/workspace.ts` 冻结 `originalCwd`）；`sanitize_path`/DJB2 与 Rust 必须逐字节一致（parity 关键，改坏会孤儿化既有会话）
- 同源功能 → [退出提示](../exit-hint/)：`sessionExists` 判断是否打印恢复命令（空会话恢复会失败）

**状态**：⏳
