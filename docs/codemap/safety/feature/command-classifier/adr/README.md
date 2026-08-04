# ADR 索引 — 命令安全分类（feature/command-classifier）

## 何时写

三条 **AND** 都满足才写（难逆 / 缺上下文会意外 / 存在真权衡）；「以后都这么做」的规范进 AGENTS.md 或 spec 不变量，不写 ADR。
命名：`NNNN-短标题-kebab.md`，编号四位单调递增；废弃用 `Status: Superseded by NNNN`。

## 当前列表

| 编号 | 标题 | 状态 | 日期 |
|---|---|---|---|
| [0001](0001-download-vs-execute.md) | 下载放行、执行不确定内容才拦 | Accepted | 2026-08-03 |
| [0002](0002-classifier-transcript-and-two-stage.md) | 分类器输入投影 + 两阶段判定 | Accepted | 2026-08-04 |
