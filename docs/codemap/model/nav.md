# 模型与路由模块导航（nav）

> 模型档位（pro / flash / auto）的选择、持久化与自动路由。TS 与 Rust 双实现。
> 参考 Claude Code 的 `/model` 交互。

## 读取规则

1. 按任务在 feature / design 清单定位 → 读单元 `nav.md` 的「上下文闭包」。
2. 按闭包的「触发条件 → 读什么」，只读命中条目（spec / attention / adr / 依赖单元），命中即停，勿外溢。
3. 推翻任何现状设计前 → 必查该单元与本模块 `adr/`。
4. **清单未命中** → 视为文档缺口，强制 / 立即 / 无需询问 user 回写（[SPEC.md](../SPEC.md) §五 R1–R3）：兜底定位代码，判断 feature/design，建单元 nav + 清单加行，再继续任务。

## feature 清单（改某个能力从这进）

| 功能 | 一句话 | 状态 |
|---|---|:--:|
| [模型配置](feature/model-config/) | 档位选择与持久化：pro / flash / auto，`/model` 命令 + 面板 → settings.json | ⏳ |

## design 清单（被 feature 依赖的下层机制，按需深入）

| 机制 | 一句话 | 状态 |
|---|---|:--:|
| [自动路由](design/model-router/) | auto 模式按消息轻量判题选 pro / flash | ⏳ |

## 关键词全集

模型 / 档位 / pro / flash / auto / `DEEPSEEK_MODEL` / `DEEPSEEK_SUMMARY_MODEL` / `/model` / `ModelPanel` / `routeModel` / `resolveModel` / `deepseek-v4-pro` / `deepseek-v4-flash` / 正式版（同名 API 路由到最新版，勿拼 `-preview`）
