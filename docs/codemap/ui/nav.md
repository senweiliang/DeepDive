# 界面与状态栏模块导航（nav）

> TUI 渲染层：底部状态栏（Footer）及支撑它的数据获取。TS Ink 实现为主，Rust TUI 有对应渲染。
> 垂直间距等渲染规范见 `docs/DESIGN.md` §11 与 `src/components/Block.tsx`。

## 读取规则

1. 按任务在 feature / design 清单定位 → 读单元 `nav.md` 的「上下文闭包」。
2. 按闭包的「触发条件 → 读什么」，只读命中条目（spec / attention / adr / 依赖单元），命中即停，勿外溢。
3. 推翻任何现状设计前 → 必查该单元与本模块 `adr/`。
4. **清单未命中** → 视为文档缺口，强制 / 立即 / 无需询问 user 回写（[SPEC.md](../SPEC.md) §五 R1–R3）：兜底定位代码，判断 feature/design，建单元 nav + 清单加行，再继续任务。

## feature 清单（改某个能力从这进）

| 功能 | 一句话 | 状态 |
|---|---|:--:|
| [Footer 状态栏](feature/footer/) | 底部栏：model\|mode、in/out、cache hit、ctx%、余额 ¥、bg 任务数 | ⏳ |

## design 清单（被 feature 依赖的下层机制，按需深入）

_（暂无 — 余额获取先挂在 feature/footer 闭包）_

## 关键词全集

footer / 底部栏 / 状态栏 / 余额 / balance / ¥ / in out / cache hit / ctx / 后台任务 / bg / `fetchBalance` / `totalBalance` / `cumulativeTokens`
