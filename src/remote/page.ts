/**
 * 手机/浏览器远程控制 — 单页移动端 UI。
 *
 * 零构建：一个内联 HTML 字符串由 HTTP 服务器直接吐出（GET /）。手机扫码
 * 打开后通过 EventSource 订阅 /events（SSE），发消息走 POST /api/message。
 * 数据全程局域网内直连，不经任何第三方。
 *
 * 快照驱动 + 增量渲染：服务端每次会话状态变化推一个完整快照（见 server.ts 的
 * RemoteSnapshot），页面按「消息签名」做增量 diff——签名没变的消息节点原地
 * 复用，只重建变化的节点、只更新 streaming 尾部文本。避免整体重绘造成的
 * 闪动 / 滚动跳动（streaming 期间每 150ms 一帧全量重建在手机上会明显卡）。
 * 滚动策略不变：贴近底部自动跟随，滚上去读历史则保持原位并浮出「↓ 新消息」。
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
  #app { display:flex; flex-direction:column; height:100vh; height:100dvh; max-width:720px; margin:0 auto; }
  header { display:flex; align-items:center; gap:8px; padding:10px 14px; padding-top:calc(10px + env(safe-area-inset-top)); border-bottom:1px solid var(--border); background:var(--panel); }
  .dot { width:9px; height:9px; border-radius:50%; background:var(--dim); flex:none; }
  .dot.on { background:var(--ok); }
  .dot.err { background:var(--err); }
  .dot.busy { background:var(--warn); animation:pulse 1.1s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity:.35; } }
  .title { font-weight:600; font-size:14px; }
  .sub { color:var(--dim); font-size:12px; margin-left:auto; }
  #log { flex:1; overflow-y:auto; padding:14px; -webkit-overflow-scrolling:touch; }
  .msg { margin-bottom:14px; }
  .msg .who { font-size:12px; color:var(--dim); margin-bottom:2px; }
  .msg.user { display:flex; flex-direction:column; align-items:flex-end; }
  .msg.user .bubble { background:var(--user); border:1px solid #2d4a75; padding:8px 12px; border-radius:12px 12px 2px 12px; max-width:92%; white-space:pre-wrap; word-break:break-word; }
  .msg.user .bubble.pending { opacity:.7; border-style:dashed; }
  .msg.assistant .body { padding:0 2px; }
  .msg.tool .body { color:var(--dim); font-family:ui-monospace,Consolas,monospace; font-size:13px; white-space:pre-wrap; word-break:break-word; margin-left:8px; }
  .msg.error .body { color:var(--err); }
  .toolcall { color:var(--dim); font-size:12px; font-family:ui-monospace,Consolas,monospace; margin:4px 0 2px; word-break:break-all; }
  details { margin:4px 0; }
  details summary { color:var(--warn); font-size:12px; cursor:pointer; padding:4px 2px; -webkit-tap-highlight-color:transparent; }
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
  /* 连接中骨架屏（首快照到达前显示，避免空白屏） */
  .sk { padding:2px 2px 12px; }
  .sk-line { height:14px; border-radius:6px; margin-bottom:10px; background:linear-gradient(90deg,var(--panel) 25%,#26313f 50%,var(--panel) 75%); background-size:200% 100%; animation:skmove 1.2s linear infinite; }
  .sk-line:last-child { margin-bottom:0; }
  @keyframes skmove { 0% { background-position:200% 0; } 100% { background-position:-200% 0; } }
  /* 空会话引导 */
  .empty { text-align:center; color:var(--dim); padding:56px 24px; }
  .empty .big { font-size:15px; color:var(--fg); opacity:.85; }
  .empty .sub2 { font-size:13px; margin-top:6px; opacity:.8; }
  /* 回到底部悬浮按钮（滚上去读历史时浮出，新内容到达时高亮计数） */
  #jump { position:fixed; right:18px; bottom:calc(88px + env(safe-area-inset-bottom)); z-index:20; border:none; border-radius:999px; background:var(--accent); color:#0b0f14; font-size:13px; font-weight:600; padding:0 16px; height:40px; box-shadow:0 4px 14px rgba(0,0,0,.45); cursor:pointer; -webkit-tap-highlight-color:transparent; transition:transform .15s ease, opacity .2s; }
  #jump:active { transform:scale(.97); }
  #jump.new { animation:jumpPulse 1.4s ease-in-out infinite; }
  @keyframes jumpPulse { 0%,100% { box-shadow:0 4px 14px rgba(0,0,0,.45); } 50% { box-shadow:0 4px 22px rgba(97,175,239,.55); } }
  /* 错误 toast（替代 alert，不打断浏览） */
  #toast { position:fixed; left:50%; transform:translateX(-50%); bottom:calc(92px + env(safe-area-inset-bottom)); z-index:21; background:#d73a49; color:#fff; font-size:13px; padding:9px 16px; border-radius:10px; max-width:86%; text-align:center; opacity:0; pointer-events:none; transition:opacity .2s; box-shadow:0 4px 14px rgba(0,0,0,.4); }
  #toast.show { opacity:1; }
  #composer { display:flex; gap:8px; align-items:flex-end; padding:10px 14px; padding-bottom:calc(10px + env(safe-area-inset-bottom)); border-top:1px solid var(--border); background:var(--panel); }
  #input { flex:1; background:var(--bg); color:var(--fg); border:1px solid var(--border); border-radius:10px; padding:10px 12px; font-size:16px; outline:none; resize:none; max-height:140px; font-family:inherit; }
  #input:focus { border-color:var(--accent); }
  #send { background:var(--accent); color:#0b0f14; border:none; border-radius:10px; min-width:64px; min-height:44px; padding:0 18px; font-size:16px; font-weight:600; cursor:pointer; -webkit-tap-highlight-color:transparent; transition:transform .15s ease, opacity .2s; }
  #send:active { transform:scale(.97); }
  #send:disabled { opacity:.5; }
  @media (prefers-reduced-motion: reduce) {
    .cur, .dot.busy, .sk-line, #jump.new { animation:none !important; }
    #send, #jump { transition:none; }
  }
</style>
</head>
<body>
<div id="app">
  <header>
    <span class="dot" id="dot"></span>
    <span class="title">DeepDive</span>
    <span class="sub" id="sub">连接中…</span>
  </header>
  <div id="log">
    <div class="sk"><div class="sk-line" style="width:72%"></div><div class="sk-line" style="width:90%"></div></div>
    <div class="sk"><div class="sk-line" style="width:48%"></div><div class="sk-line" style="width:64%"></div></div>
    <div class="sk"><div class="sk-line" style="width:80%"></div><div class="sk-line" style="width:36%"></div></div>
  </div>
  <div id="composer">
    <textarea id="input" rows="1" placeholder="发消息给当前会话…" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="send" aria-label="发消息给当前会话"></textarea>
    <button id="send" aria-label="发送">发送</button>
  </div>
</div>
<button id="jump" hidden aria-label="回到底部">↓ 新消息</button>
<div id="toast" role="status" aria-live="polite"></div>
<script>
(function () {
  "use strict";
  var token = new URLSearchParams(location.search).get("t") || "";
  var logEl = document.getElementById("log");
  var dotEl = document.getElementById("dot");
  var subEl = document.getElementById("sub");
  var input = document.getElementById("input");
  var sendBtn = document.getElementById("send");
  var jumpEl = document.getElementById("jump");
  var toastEl = document.getElementById("toast");
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
  // 消息签名：内容任何一个字段变化 → 签名变化 → 增量渲染只重建这一条节点。
  function sig(m) {
    var p = [m.role, m.content || ""];
    if (m.reasoning) p.push("r:" + m.reasoning);
    if (m.bashOutput) p.push("o:" + m.bashOutput);
    if (m.error) p.push("e:1");
    if (m.bash) p.push("b:1");
    if (m.toolCalls && m.toolCalls.length) {
      p.push("t:" + m.toolCalls.map(function (tc) { return tc.name + "=" + (tc.args || ""); }).join(";"));
    }
    return p.join("\\u0001");
  }
  function buildMsgEl(m) {
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
    return wrap;
  }
  function buildPendingEl(text) {
    // 已提交但尚未入列的本地消息：虚线气泡（等 streaming 结束自动入列）。
    var w = el("div", "msg user");
    var b = el("div", "bubble pending");
    b.textContent = text;
    w.appendChild(b);
    return w;
  }
  function buildStreamWrap() {
    var w = el("div", "msg assistant");
    var sb = el("div", "stream");
    w.appendChild(sb);
    return { wrap: w, body: sb };
  }
  function setStreamText(sb, text) {
    // 只更新流式区文本，保留 wrapper 节点 → streaming 期间不重建 DOM。
    sb.textContent = "";
    sb.innerHTML = fmt(text);
    sb.appendChild(el("span", "cur", "▍"));
  }
  function buildEmptyEl() {
    var w = el("div", "empty");
    w.appendChild(el("div", "big", "会话还没有消息"));
    w.appendChild(el("div", "sub2", "在下方输入框发一条消息，与桌面端当前会话对话"));
    return w;
  }

  // 渲染状态：msgEls/lastSigs 与快照 messages 一一对应，只 diff 变化的部分。
  var msgEls = [];
  var lastSigs = [];
  var firstSnapshot = false;
  var pendingNode = null;
  var lastPending = null;
  var streamNode = null;
  var streamBody = null;
  var lastStreamKey = null;
  var emptyNode = null;
  var jumpCount = 0;
  var toastTimer = 0;

  function nearBottom() {
    return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 80;
  }
  function setJump(hasNew) {
    if (!jumpEl) return;
    if (nearBottom()) {
      jumpEl.hidden = true;
      jumpEl.classList.remove("new");
      jumpCount = 0;
      return;
    }
    jumpEl.hidden = false;
    if (hasNew) {
      jumpCount++;
      jumpEl.classList.add("new");
      jumpEl.textContent = "↓ " + jumpCount + " 条新消息";
    }
  }
  function onScroll() {
    if (!jumpEl) return;
    if (nearBottom()) {
      jumpEl.hidden = true;
      jumpEl.classList.remove("new");
      jumpCount = 0;
    } else {
      jumpEl.hidden = false;
    }
  }

  function render(snap) {
    var wasNear = nearBottom();
    // 首快照到达：清掉骨架屏占位。
    if (!firstSnapshot) {
      firstSnapshot = true;
      logEl.textContent = "";
    }

    var msgs = snap.messages || [];
    var changed = false;
    var i, n = msgs.length;
    for (i = 0; i < n; i++) {
      var s = sig(msgs[i]);
      if (i < msgEls.length) {
        if (lastSigs[i] !== s) {
          var fresh = buildMsgEl(msgs[i]);
          msgEls[i].replaceWith(fresh);
          msgEls[i] = fresh;
          lastSigs[i] = s;
          changed = true;
        }
      } else {
        var node = buildMsgEl(msgs[i]);
        logEl.appendChild(node);
        msgEls.push(node);
        lastSigs.push(s);
        changed = true;
      }
    }
    while (msgEls.length > n) {
      var ex = msgEls.pop();
      lastSigs.pop();
      ex.remove();
      changed = true;
    }

    var pu = snap.pendingUser || null;
    if (pu !== lastPending) {
      if (pendingNode) { pendingNode.remove(); pendingNode = null; }
      if (pu) {
        pendingNode = buildPendingEl(pu);
        logEl.appendChild(pendingNode);
      }
      lastPending = pu;
      changed = true;
    }

    var sk = snap.isStreaming ? (snap.streaming || snap.thinking || "…") : "";
    if (sk !== lastStreamKey) {
      lastStreamKey = sk;
      if (sk) {
        if (!streamNode) {
          var built = buildStreamWrap();
          streamNode = built.wrap;
          streamBody = built.body;
          logEl.appendChild(streamNode);
        }
        setStreamText(streamBody, sk);
        changed = true;
      } else if (streamNode) {
        streamNode.remove();
        streamNode = null;
        streamBody = null;
      }
    }

    var wantEmpty = msgs.length === 0 && !snap.isStreaming && !snap.pendingUser;
    if (wantEmpty && !emptyNode) {
      emptyNode = buildEmptyEl();
      logEl.appendChild(emptyNode);
      changed = true;
    } else if (!wantEmpty && emptyNode) {
      emptyNode.remove();
      emptyNode = null;
    }

    if (wasNear) logEl.scrollTop = logEl.scrollHeight;
    else setJump(changed);
  }

  function showToast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 3500);
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
      dotEl.className = data.isStreaming ? "dot busy" : "dot on";
    }
  };

  if (logEl.addEventListener) logEl.addEventListener("scroll", onScroll);
  if (jumpEl && jumpEl.addEventListener) {
    jumpEl.addEventListener("click", function () {
      logEl.scrollTop = logEl.scrollHeight;
      jumpEl.hidden = true;
      jumpEl.classList.remove("new");
      jumpCount = 0;
    });
  }

  function send() {
    var text = input.value.trim();
    if (!text || sendBtn.disabled) return;
    sendBtn.disabled = true;
    sendBtn.textContent = "…";
    // 失败不清空输入：错误只弹 toast，用户文字保留可重试。
    fetch("api/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token, text: text })
    }).then(function (r) { return r.json(); }).then(function (j) {
      sendBtn.disabled = false;
      sendBtn.textContent = "发送";
      if (j.ok) { input.value = ""; grow(); input.focus(); }
      else showToast(j.error || "发送失败");
    }).catch(function () {
      sendBtn.disabled = false;
      sendBtn.textContent = "发送";
      showToast("发送失败：无法连接");
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
