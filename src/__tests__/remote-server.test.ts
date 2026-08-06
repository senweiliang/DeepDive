import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  registerRemoteApi,
  startRemoteServer,
  stopRemoteServer,
  getRemoteStatus,
  pushSnapshot,
  type RemoteSnapshot,
} from "../remote/server.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("remote control server (LAN)", () => {
  const received: string[] = [];
  const snapshot: RemoteSnapshot = {
    sessionId: "test-session",
    isStreaming: false,
    pendingUser: null,
    messages: [{ role: "user", content: "hi" }],
    streaming: "",
    thinking: "",
  };
  let port = 0;
  let token = "";

  beforeAll(async () => {
    registerRemoteApi({
      sendMessage: (text) => received.push(text),
      getSnapshot: () => snapshot,
    });
    const status = await startRemoteServer(18123);
    port = status.port;
    token = status.token;
  });

  afterAll(() => {
    stopRemoteServer();
    registerRemoteApi(null);
  });

  it("exposes the capability URL with a token and an ANSI QR", () => {
    const status = getRemoteStatus();
    expect(status?.running).toBe(true);
    expect(status?.url).toMatch(new RegExp(`^http://[^/]+:${port}/\\?t=${token}$`));
    expect(status?.qr).toContain("\x1b[");
    expect(status?.qr.split("\n").length).toBeGreaterThan(10);
  });

  it("serves the single-page mobile UI at GET /", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("DeepDive Remote");
    expect(html).toContain("EventSource");
  });

  it("streams an initial snapshot over SSE with the token", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/events?t=${token}`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const event = new TextDecoder().decode(value);
    expect(event).toContain('"type":"snapshot"');
    expect(event).toContain('"sessionId":"test-session"');
  });

  it("rejects SSE without a valid token", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/events?t=wrong`);
    expect(res.status).toBe(401);
  });

  it("accepts a phone message via POST and forwards it to the session", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, text: "从手机发的消息" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(received).toContain("从手机发的消息");
  });

  it("rejects POST with a bad token or empty text", async () => {
    const bad = await fetch(`http://127.0.0.1:${port}/api/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "wrong", text: "x" }),
    });
    expect(bad.status).toBe(401);

    const empty = await fetch(`http://127.0.0.1:${port}/api/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, text: "   " }),
    });
    expect(empty.status).toBe(400);
  });

  it("404s unknown routes", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
  });

  it("throttle window coalesces to the NEWEST snapshot (streaming tail not lost)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/events?t=${token}`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read(); // 消费连接即推的首快照

    // 第一帧距 lastPush(0) 足够远 → 立即推。
    pushSnapshot({ ...snapshot, messages: [{ role: "assistant", content: "middle" }] });
    await sleep(20);
    // 之后两帧都落在同一 150ms 窗口内：pending 已挂时到达的帧必须覆盖旧载荷。
    pushSnapshot({ ...snapshot, messages: [{ role: "assistant", content: "tail" }] });
    await sleep(20);
    pushSnapshot({ ...snapshot, messages: [{ role: "assistant", content: "done" }] });

    // 等节流边界把窗口内最新快照推出来。
    await sleep(300);
    let buf = "";
    const deadline = Date.now() + 800;
    while (Date.now() < deadline && buf.indexOf('"content":"done"') === -1) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
    }
    await reader.cancel();

    const frames = buf
      .split("\n\n")
      .filter((f) => f.startsWith("data: {"));
    const lastFrame = frames[frames.length - 1];
    expect(lastFrame).toBeDefined();
    const last = JSON.parse(lastFrame!.slice("data: ".length));
    expect(last.messages[0].content).toBe("done");
  });
});
