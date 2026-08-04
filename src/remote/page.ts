/**
 * 手机/浏览器远程控制 — 单页移动端 UI。
 *
 * 零构建：一个内联 HTML 字符串由 HTTP 服务器直接吐出（GET /）。手机扫码
 * 打开后通过 EventSource 订阅 /events（SSE），发消息走 POST /api/message。
 * 数据全程局域网内直连，不经任何第三方。
 *
 * 快照驱动：服务端每次会话状态变化推一个完整快照（见 server.ts 的
 * RemoteSnapshot），页面每次收到就整体重绘 + 贴近底部时自动滚动——规模小，
 * 不需要做增量 diff。
 */

export const pageHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>DeepDive Remote</title>
<style>
  :root { color-scheme: dark; --bg:#0d1117; --panel:#161b22; --border:#21262d; --fg:#c9d1d9; --dim:#8b949e; --accent:#61afef; --user:#1f3a5f; --err:#e06c75; --ok:#8cd369; --warn:#f0c14b; }
  * { box-sizing:border-box; }
  html,body { margin:0; height:100%; background:var(--bg); color:var(--fg); font:15px/1.55 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }
  #app { display:flex; flex-direction:column; height:100dvh; max-width:720px; margin:0 auto; }
  header { display:flex; align-items:center; gap:8px; padding:10px 14px; border-bottom:1px solid var(--border); background:var(--panel); }
  .dot { width:9px; height:9px; border-radius:50%; background:var(--dim); flex:none; }
  .dot.on { background:var(--ok); }
  .dot.err { background:var(--err); }
  .title { font-weight:600; font-size:14px; }
  .sub { color:var(--dim); font-size:12px; margin-left:auto; }
  #log { flex:1; overflow-y:auto; padding:14px; -webkit-overflow-scrolling:touch; }
  .msg { margin-bottom:14px; }
  .msg .who { font-size:12px; color:var(--dim); margin-bottom:2px; }
  .msg.user { display:flex; flex-direction:column; align-items:flex-end; }
  .msg.user .bubble { background:var(--user); border:1px solid #2d4a75; padding:8px 12px; border-radius:12px 12px 2px 12px; max-width:92%; white-space:pre-wrap; word-break:break-word; }
  .msg.assistant .body { padding:0 2px; }
  .msg.tool .body { color:var(--dim); font-family:ui-monospace,Consolas,monospace; font-size:13px; white-space:pre-wrap; word-break:break-word; margin-left:8px; }
  .msg.error .body { color:var(--err); }
  .toolcall { color:var(--dim); font-size:12px; font-family:ui-monospace,Consolas,monospace; margin:4px 0 2px; word-break:break-all; }
  details { margin:4px 0; }
  details summary { color:var(--warn); font-size:12px; cursor:pointer; }
  details .think { color:var(--dim); font-size:13px; white-space:pre-wrap; }
  pre { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:10px 12px; overflow-x:auto; font-family:ui-monospace,Consolas,monospace; font-size:13px; line-height:1.5; white-space:pre; }
  code { font-family:ui-monospace,Consolas,monospace; font-size:0.92em; }
  :not(pre) > code { background:rgba(110,118,129,0.25); padding:1px 5px; border-radius:4px; }
  h1,h2,h3 { margin:12px 0 6px; line-height:1.3; }
  h1 { font-size:17px; } h2 { font-size:16px; } h3 { font-size:15px; }
  ul,ol { margin:6px 0; padding-left:22px; }
  table { border-collapse:collapse; margin:8px 0; }
  th,td { border:1px solid var(--border); padding:4px 10px; font-size:13px; }
  blockquote { margin:8px 0; padding:2px 12px; border-left:3px solid var(--accent); color:var(--dim); }
  hr { border:none; border-top:1px solid var(--border); margin:12px 0; }
  .stream { border-left:3px solid var(--accent); padding-left:10px; opacity:.9; white-space:pre-wrap; word-break:break-word; }
  .cur { color:var(--accent); animation:blink 1s steps(1) infinite; }
  @keyframes blink { 50% { visibility:hidden; } }
  #composer { display:flex; gap:8px; padding:10px 14px; border-top:1px solid var(--border); background:var(--panel); padding-bottom:calc(10px + env(safe-area-inset-bottom)); }
  #input { flex:1; background:var(--bg); color:var(--fg); border:1px solid var(--border); border-radius:10px; padding:10px 12px; font-size:16px; outline:none; resize:none; max-height:140px; font-family:inherit; }
  #input:focus { border-color:var(--accent); }
  #send { background:var(--accent); color:#0b0f14; border:none; border-radius:10px; padding:0 18px; font-size:16px; font-weight:600; cursor:pointer; }
  #send:disabled { opacity:.5; }
</style>
</head>
<body>
<div id="app">
  <header>
    <span class="dot" id="dot"></span>
    <span class="title">DeepDive</span>
    <span class="sub" id="sub">连接中…</span>
  </header>
  <div id="log"></div>
  <div id="composer">
    <textarea id="input" rows="1" placeholder="发消息给当前会话…" autocomplete="off"></textarea>
    <button id="send">发送</button>
  </div>
</div>
<script>
(function () {
  "use strict";
  var token = new URLSearchParams(location.search).get("t") || "";
  var logEl = document.getElementById("log");
  var dotEl = document.getElementById("dot");
  var subEl = document.getElementById("sub");
  var input = document.getElementById("input");
  var sendBtn = document.getElementById("send");
  var sid = "";

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  // 最小 markdown：先转义再套标签，转义在先所以插入的标签是唯一 HTML。
  function fmt(s) {
    var e = esc(s);
    e = e.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, function (m, c) { return "<pre>" + c.replace(/^[a-zA-Z0-9_+.-]+\\n/, "").replace(/\\n$/, "") + "</pre>"; });
    e = e.replace(/\`([^\`\\n]+)\`/g, "<code>$1</code>");
    e = e.replace(/\\*\\*([^*\\n]+)\\*\\*/g, "<strong>$1</strong>");
    e = e.replace(/^### (.*)$/gm, "<h3>$1</h3>");
    e = e.replace(/^## (.*)$/gm, "<h2>$1</h2>");
    e = e.replace(/^# (.*)$/gm, "<h1>$1</h1>");
    e = e.replace(/^&gt; (.*)$/gm, "<blockquote>$1</blockquote>");
    return e;
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function addMsg(m) {
    var wrap = el("div", "msg " + (m.role === "user" ? "user" : m.role === "assistant" ? "assistant" : "tool") + (m.error ? " error" : ""));
    if (m.role === "assistant") {
      wrap.appendChild(el("div", "who", "DeepDive"));
      if (m.reasoning) {
        var d = document.createElement("details");
        d.appendChild(el("summary", "", "思考过程"));
        var th = el("div", "think");
        th.innerHTML = fmt(m.reasoning);
        d.appendChild(th);
        wrap.appendChild(d);
      }
      if (m.toolCalls && m.toolCalls.length) {
        m.toolCalls.forEach(function (tc) {
          var a = tc.args || "";
          wrap.appendChild(el("div", "toolcall", "→ " + tc.name + "(" + a.slice(0, 100) + (a.length > 100 ? "…" : "") + ")"));
        });
      }
      var body = el("div", "body");
      body.innerHTML = fmt(m.content);
      wrap.appendChild(body);
    } else if (m.role === "user") {
      wrap.appendChild(el("div", "bubble", (m.bash ? "! " : "") + m.content));
      if (m.bashOutput) {
        var lines = m.bashOutput.split("\\n");
        wrap.appendChild(el("div", "tool body", "  ⎿ " + lines.slice(0, 6).join("\\n") + (lines.length > 6 ? "\\n…" : "")));
      }
    } else if (m.role === "tool") {
      if (m.content) {
        // Align with desktop ToolResult: 3-line preview + "+N lines" marker.
        var l2 = m.content.replace(/\\n+$/, "").split("\\n");
        var shown = l2.slice(0, 3);
        var more = l2.length - 3;
        var text = "  ⎿ " + shown.join("\\n    ");
        if (more > 0) text += "\\n    … +" + more + " lines";
        wrap.appendChild(el("div", "tool body", text));
      }
    }
    logEl.appendChild(wrap);
  }
  function render(snap) {
    // Preserve scroll: capture position BEFORE clearing, then restore unless
    // the user was already following the bottom (then keep auto-following).
    var wasNearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 80;
    var prevScroll = logEl.scrollTop;
    logEl.textContent = "";
    (snap.messages || []).forEach(addMsg);
    if (snap.pendingUser) {
      var w = el("div", "msg user");
      w.appendChild(el("div", "bubble", snap.pendingUser));
      logEl.appendChild(w);
    }
    if (snap.isStreaming) {
      var sw = el("div", "msg assistant");
      var sb = el("div", "stream");
      sb.innerHTML = fmt(snap.streaming || snap.thinking || "…");
      sb.appendChild(el("span", "cur", "▍"));
      sw.appendChild(sb);
      logEl.appendChild(sw);
    }
    logEl.scrollTop = wasNearBottom ? logEl.scrollHeight : prevScroll;
  }

  var es = new EventSource("events?t=" + encodeURIComponent(token));
  es.onopen = function () { dotEl.className = "dot on"; subEl.textContent = "已连接" + (sid ? " · " + sid.slice(0, 8) : ""); };
  es.onerror = function () { dotEl.className = "dot err"; subEl.textContent = "连接断开，自动重连中…"; };
  es.onmessage = function (ev) {
    var data;
    try { data = JSON.parse(ev.data); } catch (err) { return; }
    if (data && data.type === "snapshot") {
      if (data.sessionId) sid = data.sessionId;
      if (sid && subEl.textContent.indexOf("已连接") === 0) subEl.textContent = "已连接 · " + sid.slice(0, 8);
      render(data);
    }
  };

  function send() {
    var text = input.value.trim();
    if (!text) return;
    input.value = "";
    grow();
    sendBtn.disabled = true;
    fetch("api/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token, text: text })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) alert(j.error || "发送失败");
      sendBtn.disabled = false;
    }).catch(function () {
      alert("发送失败：无法连接");
      sendBtn.disabled = false;
    });
  }
  function grow() { input.style.height = "auto"; input.style.height = Math.min(140, input.scrollHeight) + "px"; }
  sendBtn.addEventListener("click", send);
  input.addEventListener("input", grow);
  input.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); send(); }
  });
})();
</script>
</body>
</html>
`;
