# 工具执行安全模块导航（nav）

> bash 工具执行前的安全判定与审批：classifier（启发式 + flash 模型两级判定）、permissions、approval。
> TS 在 `src/tools/`，Rust 对应实现 `deepdive-rs/crates/deepdive-core/src/tools/`。

## 读取规则

1. 按任务在 feature / design 清单定位 → 读单元 `nav.md` 的「上下文闭包」。
2. 按闭包的「触发条件 → 读什么」，只读命中条目（spec / attention / adr / 依赖单元），命中即停，勿外溢。
3. 推翻任何现状设计前 → 必查该单元与本模块 `adr/`。
4. **清单未命中** → 视为文档缺口，强制 / 立即 / 无需询问 user 回写（[SPEC.md](../SPEC.md) §五 R1–R3）：兜底定位代码，判断 feature/design，建单元 nav + 清单加行，再继续任务。

## feature 清单（改某个能力从这进）

| 功能 | 一句话 | 状态 |
|---|---|:--:|
| [命令安全分类](feature/command-classifier/) | bash 命令 allow/block/ask 判定：heuristic 正则 + deepseek-v4-flash 模型；block 会拦截工具执行 | ⏳ |

## design 清单（被 feature 依赖的下层机制，按需深入）

_（暂无 — permissions / approval 先挂在 feature/command-classifier 闭包）_

## 关键词全集

classifier / 分类器 / 安全分类 / block / 拦截 / 危险 / 安全 / 审批 / approval / permissions / 权限 / ConfirmBox / Allow once / Allow always / Deny / checkPermission / toolNeedsApproval / 分类器日志 / `~/.deepdive/logs` / `heuristicClassify` / `extractVerdict` / `CLASSIFIER_PROMPT` / `downloads and executes untrusted code` / plan / yolo / auto / acceptEdits
