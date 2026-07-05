# MCP 模块导航（nav）

> Model Context Protocol 客户端：连接外部 MCP 服务器，发现工具，暴露给模型并路由调用。
> 参考 Claude Code。TS 与 Rust 双实现，行为对齐（配置格式 / 工具命名 / 审批规则 / UX 一致）。

## 单元清单

| 单元 | 关键词 | 位置（TS / Rust） | 说明 |
|---|---|---|---|
| 配置加载 | mcpServers, .mcp.json, 合并 | `src/mcp/config.ts` / `deepdive-rs/…/mcp/config.rs` | 全局 `mcpServers` + 项目 `.mcp.json`，项目覆盖同名；传输推断（command→stdio，否则 type/url） |
| 命名 | mcp__server__tool, 反解析, sanitize | `src/mcp/index.ts` / `mcp/protocol.rs` | `mcp__<server>__<tool>`，按首个 `__` 反解析，server 名 sanitize |
| 传输 | stdio, http, sse, JSON-RPC | `mcp/manager.ts`(SDK) / `mcp/transport.rs`(手写) | stdio(子进程行分隔) + streamable HTTP + legacy SSE；Rust 零依赖，TS 用官方 SDK |
| 客户端 | initialize, tools/list, tools/call | SDK 内部 / `mcp/client.rs` | 握手→发现→调用；结果 content 扁平化（text 拼接，image/resource 占位） |
| 管理器 | connect_all, tool_schemas, call, statuses | `mcp/manager.ts` / `mcp/manager.rs` | 并发连接、聚合 schema（排序冻结）、路由调用、状态、shutdown |

## 接入点（宿主代码）

- **schema 注入**：`client.ts:buildBody` / `client.rs:build_body` — 主 agent 在 `ALL_TOOLS` 后追加冻结的 MCP schema（子代理 v1 不含）
- **调用路由**：`App.tsx` 主分派 `mcp__` 分支 / `engine.rs:dispatch_interactive` `mcp__` 臂 → manager.call
- **审批**：`approval.{ts,rs}`（MCP 非 yolo 必弹、plan 屏蔽）+ `permissions.{ts,rs}`（`mcp__server__tool`/`mcp__server` 规则，deny>ask>allow）
- **生命周期**：CLI `interactive.rs`/`cli.tsx` 启动连接；TUI `main.rs` 引擎任务内连接；Session 持 `Arc<McpManager>`，`/clear`·`/resume` 保留
- **UI**：`/mcp` 命令（`commands/mcp.ts` / CLI `print_mcp_status` / TUI `handle_slash`）；`format.{ts,rs}:tool_display_name` 显示 `server: tool`

## v1 范围与 ADR

- 仅 **tools**（`tools/list`+`tools/call`）；Resources / Prompts / OAuth / GUI 面板预留后续
- 仅 **主 agent** 用 MCP（子代理不注入 MCP schema → 不会调用）
- plan 模式屏蔽 MCP（未按 `readOnlyHint` 放宽）
- 「always allow」仅持久化精确工具规则 `mcp__server__tool`（整服务器授权需手动加 `mcp__server`）
