# 会话与持久化模块导航（nav）

> 会话生命周期：JSONL 持久化（`~/.deepdive/projects/<sanitized-cwd>/<id>.jsonl`）、`-r`/`-c` 恢复、SessionPicker 选择、Ctrl+C 退出时打印 `deepdive -r <会话id>` 便于直接续会话。TS 与 Rust 双实现，`sanitize_path` 为 parity 关键（改坏会孤儿化既有会话）。

## 读取规则

1. 按任务在 feature / design 清单定位 → 读单元 `nav.md` 的「上下文闭包」。
2. 按闭包的「触发条件 → 读什么」，只读命中条目（spec / attention / adr / 依赖单元），命中即停，勿外溢。
3. 推翻任何现状设计前 → 必查该单元与本模块 `adr/`。
4. **清单未命中** → 视为文档缺口，强制 / 立即 / 无需询问 user 回写（[SPEC.md](../SPEC.md) §五 R1–R3）：兜底定位代码，判断 feature/design，建单元 nav + 清单加行，再继续任务。

## feature 清单（改某个能力从这进）

| 功能 | 一句话 | 状态 |
|---|---|:--:|
| [会话持久化与恢复](feature/session-resume/) | JSONL append-only 存储、`-r <id>` / `-c` / Picker 恢复、标题更新 | ⏳ |
| [退出提示](feature/exit-hint/) | Ctrl+C 退出时打印 `deepdive -r <会话id>`，复制即续会话（免去 Picker） | ⏳ |
| [AI 会话标题](feature/ai-title/) | 新会话首条消息后用 flash 生成中文标题，写入 meta.title 并同步终端标题 | ⏳ |

## design 清单（被 feature 依赖的下层机制，按需深入）

_（暂无 — 项目目录 / sanitize 规则先挂在 feature/session-resume 闭包）_

## 关键词全集

会话 / session / 恢复 / resume / 继续 / `-r` / `-c` / 会话id / sessionId / `newSessionId` / `loadSession` / `listSessions` / `lastSessionId` / `sessionExists` / `SessionPicker` / JSONL / `~/.deepdive/projects` / ctrl+c / ctrl-c / 退出 / exit / 退出提示 / AI 标题 / 自动标题 / 会话标题 / 标题生成 / `generateSessionTitle` / `SESSION_TITLE_PROMPT` / `firstRealUserText`
