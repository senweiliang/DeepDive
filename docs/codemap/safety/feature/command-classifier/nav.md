# 命令安全分类

**一句话**：bash 工具执行前的安全判定与审批：heuristic 正则 + 紧凑 transcript 投影 + deepseek-v4-flash 两阶段（fast→review）判定，deny>ask>allow 权限规则，ConfirmBox 审批 UI。
**关键词**：classifier / 分类器 / 安全分类 / block / allow / ask / 危险 / 审批 / approval / permissions / 权限 / ConfirmBox / Allow once / Allow always / Deny / checkPermission / suggestPermissionPattern / toolNeedsApproval / 分类器日志 / `~/.deepdive/logs` / `heuristicClassify` / `contextualHeuristicClassify` / `buildClassifierTranscript` / `toClassifierToolInput` / `parseReviewDecision` / `extractVerdict` / `CLASSIFIER_PROMPT` / `FAST_STAGE_SUFFIX` / `REVIEW_STAGE_SUFFIX` / 下载 / 执行不确定内容 / 下载并执行 / model-fast / model-review / heuristic-context

## 上下文闭包（触发条件 → 读什么）

- 改判定逻辑 / 分类器 prompt / 输出解析 / 两阶段请求 → `src/tools/classifier.ts`（Rust 对等实现 `deepdive-rs/crates/deepdive-core/src/tools/classifier.rs`，提示词/正则/解析须同步）
- 改权限规则（deny/ask/allow 匹配顺序、`Bash(git log:*)` 之类规则生成）→ `src/tools/permissions.ts`
- 改审批 UI / 选项按键 → `src/components/ConfirmBox.tsx` + `App.tsx` 的 pendingTool 分支（约 L1400–1520）
- 改模式语义（plan / yolo / auto / default / acceptEdits 谁要审批）→ `src/tools/approval.ts`
- 查一次审批的来龙去脉（谁判的、判成什么）→ `~/.deepdive/logs/<sessionId>.log` 的 `[classifier]` / `[approval]` 行（日志路径与格式见 `src/log.ts`）；判定来源标签：`heuristic` = 正则快判、`heuristic-context` = 结合 transcript 的资源生命周期判定、`model-fast` = 两阶段 fast 放行、`model-review` = review 最终判定、`error` = 失败回落 ask
- 机制依赖：模型判定走 [../../../model/nav.md](../../../model/nav.md) 的 flash 模型；`model-fast` / `model-review` 来源表示已调用 flash
- 设计依据（为什么选 A 弃 B）→ [adr/](adr/) 索引：transcript 投影与两阶段取舍 → [0002](adr/0002-classifier-transcript-and-two-stage.md)；下载 vs 执行边界（2026-08-03 用户原则「下载放行，执行不确定内容才拦」）→ [0001](adr/0001-download-vs-execute.md)

## 详情

→ [spec.md](spec.md) — ✅ 已建
