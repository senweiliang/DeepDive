# docs/codemap — 项目知识库（codemap v2）

给一句 prompt（开发 X / 改 X / X 有 bug），AI 沿固定路由三跳拿到「最小充分上下文闭包」，
而不是漫无目的地 grep 全库。纯 Markdown + agentic search，无向量库。

## 怎么用（给 agent）

1. 任何代码任务，第一步读 [index.md](index.md)（根 CLAUDE.md/AGENTS.md 已强制）。
2. index → 模块 `nav.md` → 单元 `nav.md` 的「上下文闭包」→ 按「触发条件 → 读什么」读 spec/attention/adr。
3. 路由 miss、或文档与代码不符 → 按 [SPEC.md](SPEC.md) §五回写规则**立即回写**再继续。

## 结构

- `index.md` — 全局路由（模块粗筛关键词 + 导航 SOP）
- `SPEC.md` — 元规范（各文件职责 / 触发器 / 回写规则，维护时读）
- `{module}/nav.md` — 模块路由（feature/design 清单 + 关键词全集）
- `{module}/{feature,design}/<x>/` — 单元：`nav.md`（必有）+ `spec.md`/`attention.md`/`adr/`（按触发器建）
- `templates/` — 起稿模板；`tools/` — 校验脚本；`drills.md` — 路由质检；`codemap.config.json` — 工具配置

## 维护工具

```bash
python3 docs/codemap/tools/check.py                 # 改完必跑：断链/孤儿/骨架/成熟度/锚点/预算
python3 docs/codemap/tools/check.py --backlinks docs/codemap/<module>/design/<x>   # 改被依赖单元前看影响面
python3 docs/codemap/tools/staleness.py             # 源码是否已跑到文档前面（陈旧度）
```

> 核心纪律：文件由内容压力产生（不预写）；只写代码表达不了的事实（HEAD 当前形态）；
> on-touch 增量迁移（碰到才升级，禁止批量回填）。详见 SPEC.md。
