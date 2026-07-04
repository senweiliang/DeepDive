# DeepDive — Agent Instructions

## 工作流程

1. **先读 `docs/status.md`** — 了解当前进度和阻塞
2. **只做 status 里列出的 "进行中" 和 "下一步"** — 不要自行加功能
3. **改动完成后更新 `docs/status.md` 和 `docs/CHANGELOG.md`**
4. **遵循 `docs/DESIGN.md` 中的设计决策** — 不要推翻已有架构

## 代码规范

- **TUI 垂直间距只走 `<Block>`**（`src/components/Block.tsx`）：每个 transcript
  顶层块包恰好一个 `<Block>`，子组件绝不写 `marginTop/marginBottom/marginY`，
  绝不嵌套 `<Block>`。新增/改动渲染块前先读 `Block.tsx` 的 JSDoc。
  详见 `docs/DESIGN.md` §11。
- **工具结果块（`⎿ …`）只走 `<ToolResult>`**（`src/components/ToolResult.tsx`）：
  不要再手写 `⎿`/缩进/截断/`+N lines`。左 2 + 右 1 空格、按 `cols-5` 截断由它统一。

## Git 规范

- **禁止 `git add -A`** — 会把未追踪的工作中文件一并提交。
  始终 `git add <具体文件>`，只加本次改动相关的文件。
- **提交前确认 `git status`** — 只提交预期的改动，不给将来留坑。

## 代码导航（强制，不可跳过）

任何代码相关任务（实现、排查、理解、数据流、纯问答）的**第一个工具调用**必须是读取 [docs/codemap/index.md](docs/codemap/index.md)。读完之前禁止 Grep / Glob / Bash / 业务文件 Read；纯问答任务同样适用。

读完 `index.md` 后进入对应模块 `nav.md`。**递归规则：进任何目录（模块 / 单元）第一步都是读该目录 `nav.md`**——模块 nav → 单元 nav → 按单元「上下文闭包」的「触发条件 → 读什么」按需读 spec / attention / adr。**推翻任何现状设计前必查该单元与模块 `adr/`**。若 `index.md` 无法粗筛到匹配模块，先读 2–3 个语义最近的 `nav.md` 横向比对；仅当所有候选 `nav.md` 均无对应条目时，才用代码搜索工具。任一层 miss、或发现文档与代码不符 → 按 [docs/codemap/SPEC.md](docs/codemap/SPEC.md) §五回写规则立即处理（强制 / 立即 / 无需询问）。
