/**
 * 手机/浏览器远程控制 — 局域网 HTTP 服务器（零依赖，node:http）。
 *
 * 设计（对齐 Claude Code Remote Control 的「本地会话的窗口」模型 + OpenClaw
 * Control UI 的自托管思路）：
 *  - 进程内嵌一个 0.0.0.0 监听的小服务器，同端口出单页 UI + 实时通道；
 *  - GET /           → 移动端单页（src/remote/page.ts，无构建步骤）；
 *  - GET /events     → SSE 流：连上即推当前完整快照，之后每 ~150ms 节流推增量；
 *  - POST /api/message → 校验 token 后把手机消息注入当前会话（走与终端输入
 *    同一条 handleSend 路径：streaming 中自动进队列）。
 *  - 安全：URL 里带随机 128-bit token（capability URL，扫码即获得），服务端
 *    对 SSE 握手与 POST 都校验；局域网内够用，不做账号系统。
 *  - 数据全程局域网直连，不经任何第三方。
 *
 * 已知边界（Windows）：0.0.0.0 绑定会被 Windows 防火墙拦，首次启动时系统会
 * 弹「允许访问」对话框，需勾选专用网络；否则手机连不上（127.0.0.1 仍通）。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import type { Message } from "../types.js";
import { pageHtml } from "./page.js";

export interface WireToolCall {
  name: string;
  args: string;
}

/** 过网线（HTTP/SSE）的会话消息形态 — 只带手机端展示需要的字段。 */
export interface WireMsg {
  role: "user" | "assistant" | "tool";
  content: string;
  reasoning?: string;
  toolCalls?: WireToolCall[];
  bashOutput?: string;
  error?: boolean;
  bash?: boolean;
}

/** 每次会话状态变化推给手机端的完整快照。 */
export interface RemoteSnapshot {
  sessionId: string;
  isStreaming: boolean;
  /** 已提交但首个输出尚未产生、仍悬在动态区的用户消息。 */
  pendingUser: string | null;
  messages: WireMsg[];
  /** 正在流的 assistant 正文（未提交 messages 的尾部）。 */
  streaming: string;
  /** 正在流的 thinking。 */
  thinking: string;
}

/** App 注册进来的会话侧接口 — 服务器只通过它进出会话，不碰 React。 */
export interface RemoteApi {
  sendMessage(text: string): void;
  getSnapshot(): RemoteSnapshot;
}

export interface RemoteStatus {
  running: boolean;
  url: string;
  qr: string;
  port: number;
  token: string;
}

const DEFAULT_PORT = 3838;
const PORT_RETRIES = 20;
const PUSH_INTERVAL_MS = 150;
const HEARTBEAT_MS = 25_000;

// ── 单例状态 ─────────────────────────────────────────────
let api: RemoteApi | null = null;
let server: ReturnType<typeof createServer> | null = null;
let token = "";
let port = 0;
let url = "";
let qr = "";
let current: RemoteStatus | null = null;
const clients = new Set<ServerResponse>();
const statusListeners = new Set<(s: RemoteStatus | null) => void>();

/** App 挂载时注册会话接口，卸载时传 null 注销。 */
export function registerRemoteApi(next: RemoteApi | null): void {
  api = next;
}

export function getRemoteStatus(): RemoteStatus | null {
  return current;
}

/** 订阅服务器启停状态（App 用来渲染二维码块）。返回退订函数。 */
export function subscribeRemoteStatus(
  listener: (s: RemoteStatus | null) => void,
): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

/** Message → WireMsg。meta 提醒（日期变更等）手机端不显示，由调用方过滤。 */
export function toWireMsg(msg: Message): WireMsg {
  const wire: WireMsg = {
    role: msg.role === "system" ? "assistant" : msg.role,
    content: msg.content ?? "",
  };
  if (msg.reasoning_content) wire.reasoning = msg.reasoning_content;
  if (msg.bashOutput) wire.bashOutput = msg.bashOutput;
  if (msg.error) wire.error = true;
  if (msg.bash) wire.bash = true;
  if (msg.tool_calls?.length) {
    wire.toolCalls = msg.tool_calls.map((tc) => ({
      name: tc.function.name,
      args: tc.function.arguments,
    }));
  }
  return wire;
}

/** 挑一个非内部 IPv4 作为手机可访问的局域网地址。 */
function getLanAddress(): string {
  const nets = networkInterfaces();
  for (const group of Object.values(nets)) {
    for (const net of group ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}

function listen(port: number): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolve, reject) => {
    const srv = createServer(handleRequest);
    srv.once("error", reject);
    srv.listen(port, "0.0.0.0", () => {
      srv.removeListener("error", reject);
      resolve(srv);
    });
  });
}

function writeJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const u = new URL(req.url ?? "/", "http://localhost");

  // 单页 UI
  if (req.method === "GET" && u.pathname === "/") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(pageHtml);
    return;
  }

  // SSE 实时流
  if (req.method === "GET" && u.pathname === "/events") {
    if ((u.searchParams.get("t") ?? "") !== token || !api) {
      res.writeHead(401).end("unauthorized");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write(
      `data: ${JSON.stringify({ type: "snapshot", ...api.getSnapshot() })}\n\n`,
    );
    clients.add(res);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
    req.on("close", () => {
      clients.delete(res);
      clearInterval(heartbeat);
    });
    return;
  }

  // 手机发消息
  if (req.method === "POST" && u.pathname === "/api/message") {
    const currentApi = api;
    if (!currentApi) {
      writeJson(res, 503, { ok: false, error: "会话未就绪" });
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      let parsed: { token?: string; text?: string };
      try {
        parsed = JSON.parse(body);
      } catch {
        writeJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
        return;
      }
      if (parsed.token !== token) {
        writeJson(res, 401, { ok: false, error: "token 无效" });
        return;
      }
      const text = (parsed.text ?? "").trim();
      if (!text) {
        writeJson(res, 400, { ok: false, error: "消息为空" });
        return;
      }
      currentApi.sendMessage(text);
      writeJson(res, 200, { ok: true });
    });
    return;
  }

  res.writeHead(404).end("not found");
}

// ── 节流广播：streaming 期间每 150ms 至多推一次 ──────────
let lastPush = 0;
let pendingSnap: RemoteSnapshot | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

function writeSnap(snap: RemoteSnapshot): void {
  const payload = `data: ${JSON.stringify({ type: "snapshot", ...snap })}\n\n`;
  for (const c of clients) c.write(payload);
}

export function pushSnapshot(snap: RemoteSnapshot): void {
  if (clients.size === 0) return;
  const now = Date.now();
  if (now - lastPush >= PUSH_INTERVAL_MS) {
    lastPush = now;
    writeSnap(snap);
    return;
  }
  // 窗口内每次调用都覆盖 pendingSnap（保留最新）：流式 ~40ms 一帧、节流
  // 150ms，窗口内往往挤进多帧，只记第一帧会让手机端卡在旧文本——流结束
  // 的最终快照（isStreaming:false + 完整消息）若被吞，手机永远停在
  // streaming 节点，表现为"看不到回复的最后几个字"。
  pendingSnap = snap;
  if (!pendingTimer) {
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      const snapToPush = pendingSnap;
      pendingSnap = null;
      lastPush = Date.now();
      if (snapToPush) writeSnap(snapToPush);
    }, PUSH_INTERVAL_MS - (now - lastPush));
  }
}

// ── 启停 ─────────────────────────────────────────────────
export async function startRemoteServer(
  preferredPort = DEFAULT_PORT,
): Promise<RemoteStatus> {
  if (server) return current!;

  token = randomBytes(16).toString("hex");
  const ip = getLanAddress();

  let started: { port: number; srv: ReturnType<typeof createServer> } | null =
    null;
  for (let p = preferredPort; p < preferredPort + PORT_RETRIES; p++) {
    try {
      started = { port: p, srv: await listen(p) };
      break;
    } catch {
      // EADDRINUSE 等 → 试下一个端口
    }
  }
  if (!started) {
    throw new Error(
      `无法监听 ${preferredPort}-${preferredPort + PORT_RETRIES - 1}，端口均被占用`,
    );
  }

  server = started.srv;
  port = started.port;
  url = `http://${ip}:${port}/?t=${token}`;
  qr = await QRCode.toString(url, { type: "terminal", small: true });

  current = { running: true, url, qr, port, token };
  for (const fn of statusListeners) fn(current);
  return current;
}

export function stopRemoteServer(): void {
  if (server) server.close();
  server = null;
  for (const c of clients) c.end();
  clients.clear();
  current = null;
  for (const fn of statusListeners) fn(null);
}
