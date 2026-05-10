# Changelog

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
