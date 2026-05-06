# Design

核心设计决策与架构理由。

---

## 1. 技术选型

- **Node.js + TypeScript**：JSON/SSE 流式处理原生强项，Ink (React TUI) 生态成熟，上手成本低。不需要 Rust 级别的系统控制。
- **Ink**：React 渲染到终端，组件化 UI。对标 DeepSeek-TUI 的 ratatui。
- **fetch / undici**：HTTP + SSE 流式客户端。

---

## 2. 项目结构

```
src/
├── cli.ts              # 入口，解析参数，启动 App
├── config.ts           # 配置加载（环境变量 + config 文件）
├── client.ts           # DeepSeek API 客户端（SSE 流式）
├── types.ts            # 共享类型（Message, ToolCall, Usage 等）
├── components/
│   ├── App.tsx          # 顶层组件，管理消息循环
│   ├── Header.tsx       # 顶栏（模式、模型名）
│   ├── Chat.tsx         # 消息列表渲染
│   ├── InputBox.tsx     # 底部输入框
│   └── Thinking.tsx     # 推理块（折叠/展开）
└── prompts/
    └── base.md          # System Prompt 模板
```

---

## 3. Ink 组件树

```
<App>
  <Header />          ← 模式 | 模型名
  <Chat>              ← 滚动消息列表
    <Message />       ← 用户消息 / 助手回复
    <Thinking />      ← reasoning_content 块
  </Chat>
  <InputBox />        ← 底部输入 + 发送
</App>
```

状态管理用 React `useState` + `useReducer`，不引入外部状态库（MVP 阶段状态够简单）。

---

## 4. SSE 流式客户端

```typescript
// client.ts
async function* chat(messages: Message[], config: Config): AsyncGenerator<Chunk>
```

- 用 `fetch()` POST 到 `{base_url}/chat/completions`
- 读 `response.body` 的 ReadableStream，逐行解析 SSE
- SSE 行格式：`data: {"choices":[{"delta":...}]}`
- 区分 `delta.reasoning_content` 和 `delta.content`
- 超时：连接阶段 45s，chunk 间隔 300s
- 重试：429/5xx 带 `Retry-After`，最多 3 次

---

## 5. 消息循环

```
用户输入 → POST → 流式渲染 → finish_reason: stop → 等待下一轮
```

第一阶段不处理 `finish_reason: tool_calls`，模型调工具时仅展示 tool_use block 但不执行。后续阶段再加工具循环。

---

## 6. 配置加载

优先级：命令行参数 > 环境变量 > `~/.deepdive/config.toml`

```typescript
interface Config {
  apiKey: string;          // DEEPSEEK_API_KEY
  baseUrl: string;         // 默认 https://api.deepseek.com
  model: string;           // 默认 deepseek-v4-pro
  reasoningEffort: string; // 默认 high
  maxTokens: number;       // 默认 32000
}
```

---

## 7. Prompt 构建策略

KV prefix cache 给 cache-hit token ~90% 折扣。Prompt 按 **最静态到最易变** 顺序拼接：

```
[System Prompt 静态段] → [Tools Schema] → [项目上下文] → [消息历史] → [当前消息]
 ↑ 编译时嵌入，永远不变                              ↑ 放最后，只牺牲尾部缓存
```

- 工具 Schema 按名称排序，保证请求间字节一致
- 项目上下文（CLAUDE.md）同项目内不变
- Compaction 只在末尾追加，不修改已有消息（保护 prefix cache）

---

## 8. 工具执行模型

```
Model → tool_use block → Client 执行工具 → tool_result block → 循环
```

- 读操作（ReadFile, Glob, Grep）可并行执行
- 写操作和 Shell 串行执行
- 审批门控：[Plan: 只读] [Agent: 弹确认] [YOLO: 全自动]

---

## 9. 会话持久化

- 消息历史 JSONL 格式，每行一个消息对象
- 存储路径：`~/.deepdive/sessions/{id}/messages.jsonl`
- 支持 `--resume {id}` 恢复上次会话

---

## 10. 上下文窗口管理

- Footer 实时显示 token 用量占比
- ~80% 窗口时触发 compaction（模型生成摘要，追加到消息列表末尾）
- Circuit breaker：连续 3 次 compaction 失败停止重试
