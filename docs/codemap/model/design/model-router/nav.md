# 自动路由单元导航（nav）

**一句话**：`auto` 模式下用轻量模型把用户消息判成 "pro" 或 "flash"，避免手动切换；仅在用户提交时触发（后台延续不判）。

**关键词**：auto / 判题 / 分类 / `routeModel` / pro / flash

## 上下文闭包

- 调用方 → [feature/model-config](../../feature/model-config/)：`App.tsx` 每轮首条消息 `await routeModel(...)`，`engine.rs` 对应 `ModelRoute` 分发
- 落点 → `src/tools/model-router.ts`（TS 判题模型 `deepseek-v4-pro`）、`deepdive-rs/crates/deepdive-core/src/model_router.rs`（Rust 判题模型 `deepseek-v4-flash`）
- 必读红线 → **TS 与 Rust 判题模型不一致**（pro vs flash）：双实现宣称行为对齐，此处例外；改动判题模型前先确认双端意图
- 数据契约 → 判题结果仅接受一行 `<pro|flash> | <原因>`；首 token 计数解析，其它一律回落 pro（`deepdive-rs` 注释同款）

**状态**：⏳
