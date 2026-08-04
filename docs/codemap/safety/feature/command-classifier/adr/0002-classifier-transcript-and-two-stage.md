# 0002. 分类器输入投影 + 两阶段判定

- **状态**：Accepted
- **日期**：2026-08-04

## 背景

分类器此前把「单条命令 + 极简 platform/cwd」交给 flash 做一次开放式三分类（allow/block/ask），
没有用户意图、没有历史工具轨迹、也没有复核阶段。实测（会话 fcb16020-ae9c-433b-9c5d-ab75551bf986）里，
完全相同的 `browser-harness --doctor` 在模型路径上两次 block、两次 allow——边界语义随上下文漂移。
用户提问：是否因为给分类器的上下文太少导致误判；Claude Code Auto mode 的做法（紧凑 transcript 投影 +
fast→thinking 两阶段）能否在 DeepDive 对齐实现。

## 决策

对齐 Claude Code Auto mode 分类器的客户端侧设计，TS+Rust 双实现保持同一语义：

1. **输入投影**：分类器只见「真实 user 文本 + assistant 工具调用」构成的紧凑 JSONL transcript，
   每个工具经 `toClassifierToolInput` 只暴露安全相关字段；assistant 自由文本与 tool 结果被**刻意排除**；
   待审命令以 `{"bash": …}` 追加在末尾、恰好一次。
2. **两阶段判定**：FAST（低 token，只输出 `allow`/`review`）→ 仅明确 `allow` 直接返回；
   其余（`review` / 空输出 / 解析失败）进入 REVIEW（完整三分类 + 理由）。任何 API 错误回落 `ask`（fail-closed）。
3. **确定性快速路径扩面**：对「明确安全形态」补窄范围正则（临时 `set PATH` 自检、Chrome for Testing
   受限启动、工作区内相对路径单文件 `del`），并新增 `contextualHeuristicClassify`——`taskkill /im chrome.exe`
   清理命令只有在 transcript 显示本轮确实启动了专用 Chrome 时才放行。

## 被放弃的方案

**A. 单阶段 + 更多原始上下文（原状小修）**：直接把完整历史（含 assistant 文本与 tool 结果）拼进一次
模型请求。否决理由：① 上下文多不等于判定稳——tool 结果可被注入内容污染，assistant 自由文本可能是
「忽略安全策略」式话术，给分类器的上下文越多提示注入面越大；② 一次请求没有复核，边界漂移依旧。
Claude 官方文档明确分类器刻意去掉工具输出，并配合服务端注入探测，DeepDive 没有服务端探测，客户端
过滤是同等效果的本地替代。

**B. 两阶段 + 完整原始历史**：保留 A 的完整历史但拆成 fast/review 两次调用。否决理由同上——注入面
不减，且多一次调用只买到「复核」没买到「输入卫生」。

**C. heuristic 覆盖全部四个误判案例**：把 `taskkill /im chrome.exe` 之类直接加进放行白名单。否决理由：
按进程名杀进程无上下文就是危险操作（会杀掉用户所有 Chrome），白名单化等于把真实风险变成常态放行；
「自己启动、自己 kill」必须靠启动轨迹证明，所以只做 context 版、不做无条件白名单。

## 后果

- 换来了：边界语义稳定（两阶段 + 投影）；真实误判案例（`set PATH` 自检、Chrome 启动/清理、工作区 `del`）
  全部确定性放行；提示注入无法借道 tool 结果/assistant 文本。
- 代价：模型路径上每个待审命令最多 2 次 flash 调用（fast 明确 allow 时 1 次）——延迟与 token 成本翻倍
  只在「heuristic 拿不定」的命令上发生，heuristic 命中（日常构建/只读/git 操作）仍零模型调用；
  flash 偶发把 `allow` 输成 `review` 时被当作 review 交给第二阶段，是设计内行为而非故障。
- 翻案前须知：输入过滤与两阶段来自用户认可的 Claude Code 对齐方向 + 不稳定现场，改回「完整上下文单阶段」
  需先确认用户意图；「下载放行」边界（adr/0001）不受影响。
