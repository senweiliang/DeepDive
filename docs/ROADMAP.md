# DeepDive — ROADMAP

DeepSeek 专属终端 AI 编程代理，Node.js + TypeScript + Ink 实现。

---

## 第一层：基础通信

### 1. OpenAI 兼容 SSE 流式客户端

- POST 到 `/chat/completions`，OpenAI 兼容协议
- SSE 流式解析（`response.body` stream）
- 重试策略：429/5xx + `Retry-After` header
- 连接阶段超时（45s）和流式 idle 超时（300s）分别设置
- 支持 `http_proxy` 环境变量（国内用户必备）

### 2. 推理内容实时展示

- DeepSeek V4 的 `reasoning_content` 和 `content` 交替到达
- thinking 块独立渲染，默认折叠，可展开
- 推理强度档位标识（off / low / medium / high / max）

### 3. 基础消息循环

- 用户输入 → API 请求 → 流式渲染响应 → 等待下一轮
- 当模型返回 `finish_reason: tool_calls` 时进入工具执行循环

---

## 第二层：工具执行循环

### 4. Tool Calling 闭环

```
Model → tool_use block → Client 执行工具 → tool_result block → Model 继续
                                                                    ↓
                                           finish_reason: stop ← 不再调工具
```

### 5. 最少工具集（6 个）

| 工具 | 功能 |
|---|---|
| `read_file` | 读文件 |
| `write_file` | 写/创建文件 |
| `edit_file` | 精确字符串替换编辑 |
| `glob` | 文件名/路径模式匹配 |
| `grep` | 文件内容正则搜索 |
| `bash` | Shell 命令执行 |

### 6. 审批门控

- **Plan 模式**：只读工具可用，写操作和 Shell 执行拒绝
- **Default 模式**：Shell 执行和文件写入弹确认框
- **YOLO 模式**：全自动，无需确认

用工具能力标签（`ReadOnly` / `WritesFiles` / `ExecutesCode`）+ 模式判断。

---

## 第三层：DeepSeek 专属优化

### 7. Prefix Cache 友好的 Prompt 构建

静态前缀 → 易变后缀的拼接顺序，最大化跨 turn / 跨会话缓存命中：

```
[System Prompt 静态段] → [Tools Schema] → [项目上下文] → [会话易变内容]
 ↑ 编译时嵌入，永远不变                              ↑ 放最后，只牺牲尾部缓存
```

- System Prompt 静态段 = 编译时嵌入的字符串（行为准则、安全规则）
- Tools Schema = 按工具名排序，保证每次请求字节一致
- 项目上下文 = CLAUDE.md 等，同项目内不变
- 易变内容 = 当前消息、handoff 记录

### 8. 推理强度控制

DeepSeek V4 支持的 `reasoning_effort` 档位：

| 档位 | 适用场景 |
|---|---|
| `off` | 简单翻译、格式化 |
| `low` | 搜索、子代理任务 |
| `high` | 日常编程（默认） |
| `max` | 调试错误、复杂架构 |

快捷键切换（如 `Shift+Tab`），Footer 显示当前档位。

### 9. 缓存感知的成本追踪

利用 API 返回的 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`：

```
Input:  48K tokens (cache hit 36K / miss 12K)  ¥0.276
Output: 2K tokens                                ¥0.012
─────────────────────────────────────────────────
Turn:   ¥0.288  |  Session: ¥3.45
```

- 每轮展示输入/输出 token 数和缓存命中率
- 按 DeepSeek 官方定价实时计费（区分 hit/miss 单价）
- 会话累计成本在 Footer 常驻
- 支持 ¥ / $ 切换

### 10. 上下文窗口管理

- Footer 实时展示当前 token 用量和窗口占比（如 `48K/1M (4.8%)`）
- 达到 ~80% 窗口时触发 compaction：
  - 模型生成历史摘要
  - 摘要追加到消息列表末尾，不修改已有消息（保护 prefix cache）
- compaction 失败有 circuit breaker（连续 3 次失败停止重试）

---

## 第四层：体验底线

### 11. 会话持久化

- 消息历史序列化为 JSONL 存储（`~/.deepdive/sessions/{id}/`）
- 支持 `--resume` 恢复中断的会话
- 退出时自动保存，启动时可选择继续或新建

### 12. 工作目录感知

- `deepdive` 启动时传入工作目录（默认 `$PWD`）
- 所有文件操作和 Shell 执行相对于工作目录
- Footer 显示当前工作目录

### 13. 基础配置

配置文件 `~/.deepdive/config.toml` 或 `config.json`：

```toml
api_key = "sk-xxx"
base_url = "https://api.deepseek.com"
model = "deepseek-v4-pro"
reasoning_effort = "high"
max_tokens = 32000
approval_mode = "agent"
```

环境变量兜底：`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`。

---

## 第五层：联网能力（Web 工具）

调研结论：`WebFetch` 与 `WebSearch` 实现路径完全不同，关键区别是「搜索」这一步在谁家服务器上跑。

### 15. WebFetch —— 本机抓取 + 小模型摘要

官方 Claude Code 做法（逆向）：

- 在**用户本机**发 HTTP 请求（Node `fetch`/`undici`/`axios` 即可，不走模型厂商服务器）
- HTML → Markdown 用 **Turndown** 转换
- 截断到约 **100KB** 文本（超出给 warning）
- 抓取内容 + 用户问题拼成 prompt，交给**小快模型**（空 system prompt）做提炼
- 每个 URL **缓存 15 分钟** TTL
- 安全设计：跨域重定向不自动跟随，返回主 agent 重新决策（降低 SSRF/注入面）

DeepDive 自己实现即可，不依赖 shell curl：`fetch` + `turndown` + 小模型摘要 + 内存缓存。

### 16. WebSearch —— 必须接搜索提供方，不能裸 curl

核心矛盾：**「完全免费 + 零配置 + 稳定可靠」三者不可兼得**。免费且零配置的方案都靠抓取公共端点，必然牺牲稳定性（限流/封 IP）；稳定的方案都要 key 或自建。

产品取向：**尽量免费，用户无需安装/配置**。按此约束的方案对比：

| 方案 | 用户要 key/装? | 免费度 | 可靠性 | 说明 |
|---|---|---|---|---|
| DuckDuckGo Lite/HTML 端点 | 都不要 | 完全免费 | 差 | POST `lite.duckduckgo.com/lite` 解析 HTML，无 key；频繁 `202 Ratelimit`、按 IP 封禁 |
| SearXNG 公共实例 | 不要（蹭别人实例） | 完全免费 | 差 | 公共实例随时挂/限流；自建才稳但要 Docker（违反零配置） |
| 模型厂商 server-side 搜索 | 不要 | 随 token 计费 | 好 | 若 DeepSeek 后端有 `web_search` server tool，厂商侧跑、零配置——**需先确认 DeepSeek 是否支持** |
| Brave Search API | 要 key | $5/月免费额度（≈1000 次，自动续） | 最佳 | 2026 benchmark Agent Score 第一、延迟最低 |
| Tavily / Exa / Firecrawl | 要 key | 1000 次（或 credits）/月免费 | 好 | agent 专用，结构化结果 |

**实现决策：分层降级链**（不单押一个 provider）：

1. **默认开箱**：DuckDuckGo Lite 端点抓取（零 key 零配置），配合指数退避 + 结果缓存（同 query 15 min 复用）+ 限并发，降低被封概率；需管理用户预期——会偶发限流
2. **首选（若可用）**：开工前确认 DeepSeek 是否提供 server-side 搜索工具；有则作为最优解，DDG 退为 fallback
3. **可选升级**：`config.toml` 可填 Brave/Tavily key，填了走 API（稳定），没填回落 DDG——对普通用户零感知，对重度用户可提质

WebSearch 只取 `title`/`url`，要正文再发 WebFetch。

**实现状态（已落地，第 1 层）：**

- `web_search` 工具：`src/tools/websearch.ts`，DDG Lite POST + 单引号选择器解析（`result-link`/`result-snippet`）+ `uddg=` 重定向解码 + 15 min 缓存 + 3 次线性退避；HTTP 202 返回非致命的「限流，稍后重试」提示
- 归类为 read-only：plan 模式可用、永不弹审批（`approval.ts` / `format.ts` / `permissions.ts` 已接线）
- 解析器单测固化真实 HTML 结构（`src/__tests__/websearch.test.ts`，5 例全过）
- **踩坑**：Node `fetch`(undici) 默认不读 `http_proxy` 等环境变量（curl/git 会读），国内连 DDG 必经代理 → 已加 `undici` 依赖 + 启动时 `EnvHttpProxyAgent` 全局 dispatcher（`src/net.ts`，`cli.tsx` 首个 import），同时覆盖第 1 层第 1 项的 `http_proxy` 需求
- 待办：DeepSeek server-side 搜索可用性确认；可选 Brave/Tavily key 升级路径

---

---

## 测试

### 14. 回归测试

| 层级 | 范围 | 状态 |
|---|---|---|
| 单元测试 | executor / approval / client 纯逻辑 | ✓ 已实现 |
| 组件测试 | Ink 组件渲染输出 | 待实现 |
| 集成测试 | 模拟 API → 消息循环 → 工具执行 | 待实现 |

---

## MVP 砍掉的功能

| 不做 | 原因 |
|---|---|
| 子代理/fork | 单 agent 先行 |
| MCP 协议 | 6 个内置工具够 MVP 用 |
| LSP 诊断 | 需要集成 LSP server，复杂 |
| Workspace 回滚 / side-git | 好功能但非 MVP |
| Skills 系统 | CLAUDE.md 注入即可 |
| 本地化 | 先英文 |
| 自动模式选择 | 手动切档即可 |
