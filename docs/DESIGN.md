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
- 审批门控：[Plan: 只读] [Default: 弹确认] [YOLO: 全自动]

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

## 11. 垂直间距规范（`<Block>`）

transcript 的块间空行由 `src/components/Block.tsx` 这一个原语统一管理，**不靠
约定靠代码**：每个顶层可渲染块（消息 / 工具调用+结果 / thinking / 流式预览 /
running-bash / 审批框 / spinner）外层包恰好一个 `<Block>`，由它持有唯一的尾部
空行。

规则（理由见 `Block.tsx` JSDoc，此处只记结论）：

- 内层 / 叶子组件**绝不**设 `marginTop / marginBottom / marginY`；间距属于
  块根，不属于"碰巧最后渲染的那个子节点"——hidden `read` 丢失间隔正是这个
  耦合导致的。
- 间距永远是**尾部（bottom）**，绝不用**顶部（top）**：transcript 是
  append-only / `<Static>`，块渲染时后继还不存在，必须自己持有"下方"的空行。
- Ink 不折叠 margin，全局只用一个方向（bottom）避免相邻块叠成 2 行空行。
- **绝不嵌套 `Block`**：两层 `Block` 的尾部 margin 会叠成 2 行空行。
  一条"消息"不是一个块，而是若干块的容器——`MessageItem` 用普通 Box，
  thinking / 正文 / 工具组各自包一个 `Block`。
- 块内子区域的分隔（如 ConfirmBox 内部）用父级 `gap`，同样不用 `marginTop`。
- 工具结果块（`⎿ …`）统一走 `src/components/ToolResult.tsx`：左缩进 2 +
  `⎿ `/`  ` 前缀 2 + 右留 1 空格 ⇒ 内容按 `cols-5` 响应式截断。Chat 的已完成
  结果、App 的运行中 bash 输出、未来一个 bash 的多段输出都共用它，规格不漂移。

新增任何 transcript 块时：包 `<Block>`，子组件不写垂直 margin。这样写错需要
刻意不用 `Block` 或手加 `marginTop`，在 review 中显眼。
