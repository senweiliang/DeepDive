# 模型配置单元导航（nav）

**一句话**：模型档位（pro / flash / auto）的选择、保存与生效；`/model` 命令打开选择面板，写入 settings.json，下一轮请求起生效。

**关键词**：模型 / 档位 / `/model` / `DEEPSEEK_MODEL` / `ModelPanel` / `saveModel` / `resolveModel`

## 上下文闭包

- 机制依赖 → [design/model-router](../../design/model-router/)：`auto` 模式下每轮首条消息由 `routeModel` 判题
- 数据契约 → `~/.deepdive/settings.json` flat 键 `model`（env `DEEPSEEK_MODEL` 优先），`src/config.ts` 统一读取；auto 解析回落为 `deepseek-v4-pro`
- 落点 → `src/config.ts`、`src/commands/model.ts`、`src/components/ModelPanel.tsx`、`src/components/SettingsPanel.tsx`、`deepdive-rs/crates/deepdive-core/src/config.rs`
- 必读红线 → 模型 ID 用 `deepseek-v4-pro` / `deepseek-v4-flash` 原样，**不要拼 `-preview` 后缀**：官方 API 同名路由到最新正式版（2026-07-31 起为 V4-Flash-0731），改名反而无效

**状态**：⏳
