# 手机远程控制（局域网）— spec

**一句话**：`/remote` 开启进程内嵌 HTTP 服务器（`0.0.0.0`），终端打印带随机 128-bit token 的 URL + ANSI 二维码；手机扫码打开内联单页，SSE 实时看当前会话、POST 发消息。手机消息与终端输入走同一条 `handleSend`（streaming 中进队列）。数据全程局域网直连，不经第三方。

## 行为契约

### HTTP 路由（`node:http`，`src/remote/server.ts`）

| 路由 | 方法 | 鉴权 | 行为 |
|---|---|---|---|
| `/` | GET | 无 | 返回内联单页 `pageHtml`（`src/remote/page.ts`），`Cache-Control: no-store` |
| `/events` | GET | `?t=` 必须等于当前 token | SSE：连接即推 `data: {type:"snapshot", ...}` 完整快照；之后每次 `pushSnapshot` 节流（≥150ms 合并）推全量快照；25s 心跳 `: ping` 保活 |
| `/api/message` | POST | body.token 必须等于当前 token | 校验后 `api.sendMessage(text)` → 200 `{ok:true}`；JSON 非法 / text 空白 → 400；token 错 → 401；api 未注册 → 503 |
| 其它 | — | — | 404 |

- 每次 `startRemoteServer` 生成新 token（`randomBytes(16).hex`，32 字符）与新 URL `http://<LAN-IP>:<port>/?t=<token>`（capability URL：持有即获得，扫码即持有）。
- 端口：默认 3838（`DEEPDIVE_REMOTE_PORT` 可改），被占用自动 +1 重试至多 20 个。
- LAN IP：`os.networkInterfaces()` 首个非 internal IPv4；无则回退 `127.0.0.1`（手机将连不上，仅本机可用）。
- 二维码：`qrcode` 包 `type:"terminal", small:true` → ANSI 半块字符（~19 行），Ink `<Text>` 直接透传渲染（实测安全）。

### 会话接线（`src/components/App.tsx`）

- 挂载时 `registerRemoteApi({ sendMessage, getSnapshot })`；`getSnapshot` 读 `remoteSnapshotRef`（ref 镜像，避免 `[]` effect 闭包旧值）。
- 状态变化（messages/response/thinking/isStreaming/pendingUser/sessionId）→ 更新 ref + `pushSnapshot`。快照消息 = `visibleMessages.filter(!remote).map(toWireMsg)`（口径与终端一致：system 排除、meta 仅 memory recall；远程横幅是桌面专属 UI，不进手机快照）。
- 二维码横幅：**是一条 `remote: true` 的普通 Message**（`content`=URL、`qr`=ANSI 二维码字符串），在 `remoteStatus.running` 翻转时经 effect 追加进 `messages` 一次，由 MessageItem 渲染为专用块（DESIGN.md §11：恰好一个 Block）。**不要**改回 staticItems 尾插条目——`<Static>` 按 index 追加，尾插条目每来一条新消息 index 后移、会被反复重印（曾导致二维码反复出现在历史对话中）。
- 横幅消息客户端专属：`stripNonApiFields` 过滤（不进模型）、持久化 effect 跳过（`-r` 恢复不重放死掉的 URL/QR）、手机快照过滤。
- 卸载时 `registerRemoteApi(null)` + `stopRemoteServer()`——防止监听 socket 拖住事件循环不退出。

### 手机消息注入

`sendMessage(text)` → `handleSendRef.current(text)`：与终端输入完全同路径；streaming 中自动进 `pendingQueueRef`（含 `/` 斜杠命令与 `!` bash 语义，与终端一致）。

## 用户场景

1. 桌面跑 DeepDive，输 `/remote` → 终端出现「Remote control: on + URL + 二维码」块。
2. 手机同一 Wi-Fi 扫码（或浏览器开 URL）→ 看到当前会话完整 transcript，实时看到 streaming 输出，可发消息。
3. 再输 `/remote` 关闭（出「Remote control stopped」提示）；`DEEPDIVE_REMOTE=1` 启动即开；`DEEPDIVE_REMOTE_PORT=<port>` 改端口。
4. 验收口径：手机发消息后桌面 transcript 出现同一 user 消息并正常触发回合；手机端内容与终端一致；错误 token 的请求全部 401。

## 不变量

- token 只存在进程内存，重启 / 重新 `/remote` 即换新；SSE 握手与 POST 无有效 token 一律 401。
- 快照全量推送（协议不做增量 diff，wire 不变）；手机端收到后按**消息签名**做增量渲染——签名（role/content/reasoning/toolCalls/bashOutput/error/bash）没变的消息节点原地复用，只重建变化的节点、只更新 streaming 尾部文本（不重建 wrapper）。避免整体重绘在 streaming 期间（150ms 一帧）造成的闪动与滚动跳动。
- 手机消息与终端输入走同一条 `handleSend` → 不引入第二套会话逻辑。
- 退出（App unmount）必然 `stopRemoteServer` → 进程不残留监听。
- Windows 防火墙可能拦 `0.0.0.0` 绑定：首次启动系统弹「允许访问」需勾选专用网络（`127.0.0.1` 不受影响）。

## 落点与验证

- `src/remote/server.ts` — HTTP/SSE/POST/节流/单例/QR/token
- `src/remote/page.ts` — 内联移动端单页（EventSource + fetch，快照驱动**增量渲染**：骨架屏 → 首快照、连接态点、空状态引导、流式尾部原地更新、滚出底部浮出「↓ 新消息」、发送错误 toast 替代 alert）
- `src/commands/remote.ts` — `/remote` 命令（开关 + 停止提示）
- `src/commands/index.ts` — 命令注册
- `src/config.ts` — `remoteEnabled` / `remotePort`（env `DEEPDIVE_REMOTE` / `DEEPDIVE_REMOTE_PORT`）
- `src/components/App.tsx` — 注册 API、快照推送、启动时追加远程横幅消息（`remote:true`）
- `src/components/Chat.tsx` — MessageItem 渲染远程横幅块
- `src/types.ts` — Message 增 `remote` / `qr`（客户端专属）
- `src/client.ts` — `stripNonApiFields` 过滤 remote 消息
- 测试：`src/__tests__/remote-server.test.ts`（7 例：URL/QR、页面、SSE 快照、401、POST 注入、400/401、404）；`src/__tests__/remote-page.test.ts`（18 例：5 例 markdown 渲染 + 13 例 DOM 桩快照渲染——结构顺序、tool 截断 3 行+`… +N lines`、toolcall/思考折叠、XSS 转义、流式尾、滚动保持/自动跟随、**增量渲染**（未变节点复用 / 只替换变化节点 / 流式原地更新不重建 wrapper）、空状态引导、pending 虚线气泡增删、滚出底部浮出跳底按钮）
- 验证：`pnpm run typecheck` && `pnpm run test`；真机：`/remote` 后手机扫码发消息、桌面端看回合正常、确认二维码块只出现一次、关 Wi-Fi 验证断线重连。真实浏览器 CDP 冒烟（2026-08-05，browser-harness）：手机视口 390×844 渲染 4 条消息、骨架屏清除、连接态 `已连接 · e2e-test`、发送按钮 44px、输入框 16px；DOM 点击发送 → POST 成功 → 输入清空、按钮恢复、无错误 toast、服务端收到消息。

<!-- verified: 2d9f84d -->
