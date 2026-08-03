# Footer 状态栏单元导航（nav）

**一句话**：底部状态栏，从左到右：`模型|模式`、`in/out`（会话累计 token）、`cache hit %`（会话累计命中率）、`ctx` 用量、余额 `¥`、后台任务 `⚙ N bg`。

**关键词**：footer / 底部栏 / 状态栏 / 余额 / ¥ / in out / cache hit / ctx / 后台任务 / bg

## 上下文闭包

- 数据契约 → `src/balance.ts` `fetchBalance`：`GET /user/balance` 返回**账户总余额**（非会话消耗）；启动 + 每次工具回合结束后各拉一次
- 同源功能 → `src/theme.ts` `cost` 色：余额、压缩指示同色
- 落点 → `src/components/Footer.tsx`（`balance.totalBalance` 渲染 ¥）、`src/components/App.tsx`（`cumulativeTokens` 会话累计、`cacheTotalsRef` 命中率累计、`setBalance` 刷新点）、`deepdive-rs/crates/deepdive-tui/src/app.rs`（Rust TUI 对应 footer）
- 范围边界 → **余额 ≠ 会话费用**：项目暂无会话/单次费用统计（`docs/ROADMAP.md` 缓存感知成本追踪未落地）；`in/out` 是 token 数不是钱

**状态**：⏳
