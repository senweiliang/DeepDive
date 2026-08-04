# 远程控制模块导航（读取规则 + 清单）

> 手机/浏览器远程控制：进程内嵌局域网 HTTP 服务器（`node:http` 零依赖），终端打印带随机 token 的 URL + ANSI 二维码；手机扫码打开内联单页，SSE 实时看当前会话、POST 发消息。TS 实现（MVP 单实现，Rust 无对应）。

## 读取规则

1. 按任务在 feature / design 清单定位 → 读单元 `nav.md` 的「上下文闭包」。
2. 按闭包的「触发条件 → 读什么」，只读命中条目，命中即停，勿外溢。
3. 推翻任何现状设计前 → 必查该单元与本模块 `adr/`。
4. **清单未命中** → 视为文档缺口，强制 / 立即 / 无需询问 user 回写（[SPEC.md](../SPEC.md) §五 R1–R3）：兜底定位代码，建单元 nav + 清单加行，再继续任务。

## feature 清单（改某个能力从这进）

| 功能 | 一句话 | 状态 |
|---|---|:--:|
| [手机远程控制](feature/remote-control/) | `/remote` 开服务器 + 终端二维码；手机扫码实时看会话、可发消息（SSE + POST） | ✅ |

## design 清单（被 feature 依赖的下层机制，按需深入）

_（暂无 — 单页 UI 与服务器同属 feature 闭包，未抽出复用机制）_

## 关键词全集

remote / /remote / 远程 / 远程控制 / 手机 / 扫码 / 二维码 / QR / qrcode / 局域网 / LAN / 移动端 / 手机控制会话 / 实时看会话 / 手机发消息 / `server.ts` / `page.ts` / `startRemoteServer` / `stopRemoteServer` / `pushSnapshot` / `registerRemoteApi` / `subscribeRemoteStatus` / `toWireMsg` / `RemoteSnapshot` / `WireMsg` / `EventSource` / SSE / `DEEPDIVE_REMOTE` / `DEEPDIVE_REMOTE_PORT` / 3838
