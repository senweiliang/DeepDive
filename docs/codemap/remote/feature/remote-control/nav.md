# 手机远程控制（局域网）

**一句话**：`/remote` 在终端打印带随机 token 的 capability URL + ANSI 二维码；手机扫码打开内联单页，SSE 实时看当前会话、POST 发消息。手机消息与终端输入走同一条 `handleSend`（streaming 中自动进队列），手机只是当前会话的第二个「窗口」。
**关键词**：/remote / 扫码 / 二维码 / QR / 手机 / 局域网 / LAN / 移动端 / SSE / EventSource / capability URL / token / 实时看会话 / 手机发消息 / `startRemoteServer` / `stopRemoteServer` / `pushSnapshot` / `registerRemoteApi` / `toWireMsg` / `RemoteSnapshot` / `WireMsg` / `DEEPDIVE_REMOTE` / `DEEPDIVE_REMOTE_PORT`

## 上下文闭包

- 改行为语义 / 协议（HTTP 路由、SSE/POST、token 校验、节流、端口/QR 策略）→ [spec.md](spec.md)
- 改移动端 UI（页面结构 / 样式 / 渲染逻辑）→ 源码 `src/remote/page.ts`（内联 HTML 单页，零构建，快照驱动**增量渲染**）
- 改会话侧接线（App 注册 API / 快照推送 / 二维码块渲染）→ 源码 `src/components/App.tsx` 的「手机/浏览器远程控制」区块
- 机制依赖：消息注入走 App 的 `handleSend`（streaming 中进 `pendingQueueRef`）；快照数据来自 `visibleMessages`（口径与终端一致：system 排除、meta 仅 memory recall）
- 同源功能：[../../../session/feature/session-resume/](../../../session/feature/session-resume/) — 手机消息与终端消息无差别入同一消息流 / 持久化
- 范围边界：**不是** Web 终端（不渲染整个 TUI），只是当前会话的「窗口」——看 transcript + 发消息；改 TUI 渲染本身请走 ui 模块
- 源码：`src/remote/server.ts` · `src/remote/page.ts` · `src/commands/remote.ts` · `src/config.ts`（remoteEnabled/remotePort）

## 详情

spec.md — ✅ 已建
