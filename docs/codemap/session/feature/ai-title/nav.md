# AI 会话标题单元导航（nav）

**一句话**：新会话首条真实用户消息后，用 flash 模型（`DEEPSEEK_SUMMARY_MODEL`）一次性生成中文标题（3-10 字 JSON），写入 JSONL `meta.title`（会话 Picker 显示）并同步终端 tab 标题；`/rename` 手动名仍最高优先；恢复会话不重新生成。

**关键词**：AI 标题 / 自动标题 / 会话标题 / 标题生成 / session title / generateSessionTitle / `aiTitleAttemptedRef` / `ai_title_attempted` / `SESSION_TITLE_PROMPT` / `MIN_DESCRIPTION_LENGTH` / `first_real_user_row`

## 上下文闭包

- 机制契约 → `src/session-title.ts`（port 自 Claude Code `src/utils/sessionTitle.ts`）：`SESSION_TITLE_PROMPT` 中文版（3-10 字、JSON 输出、好/坏例子、显式禁止照抄示例标题）、`extractTitleJson` 宽容解析、`firstRealUserText` 跳过 meta/slash/`!bash`/过短消息（`MIN_DESCRIPTION_LENGTH`=4 字）、15s 超时、任何失败静默返回 null（不重试）
- Rust 对应 → `deepdive-rs/crates/deepdive-core/src/session_title.rs`：`generate_session_title`（非流式 flash 调用，`reasoning_effort: "none"`、`max_tokens: 100`）+ 纯函数 `extract_title_json` / `first_real_user_text`；TUI 侧对应门函数 `deepdive-tui/src/main.rs` 的 `first_real_user_row`（同样跳过 <4 字）
- 落点 → `src/components/App.tsx`（useEffect：首条真实 user 消息后 fire-and-forget，成功后 `updateSessionTitle` 持久化 + `setSessionTitle` 进终端标题；`aiTitleAttemptedRef` 恢复时种子 true、`/clear` 重置）、`deepdive-rs/crates/deepdive-tui/src/main.rs`（`app.ai_title_attempted` 门 + `title_tx/title_rx` 通道回传，`update_session_title` + `app.session_title`）
- 依赖单元 → [会话持久化与恢复](../session-resume/)（`meta.title` 落盘与恢复）、[终端标题](../../ui/feature/terminal-title/)（终端 tab 显示）
- 范围边界 → 标题只取首条真实 user 消息（截断 1000 字；短于 4 字的招呼语如 "HI" 跳过，避免模型照抄示例标题）；flash 失败/超时 → 保持默认名，本次会话不再重试；模型档位跟随 `summaryModel`（与 turn-summary 同源）

**状态**：✅
