# DeepDive — Agent Instructions

## 工作流程

1. **先读 `docs/status.md`** — 了解当前进度和阻塞
2. **只做 status 里列出的 "进行中" 和 "下一步"** — 不要自行加功能
3. **每次改动后跑 `pnpm typecheck`** — 确保零类型错误
4. **改动完成后更新 `docs/status.md` 和 `docs/CHANGELOG.md`**
5. **遵循 `docs/DESIGN.md` 中的设计决策** — 不要推翻已有架构

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
