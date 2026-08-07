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
  :root { color-scheme: dark; --bg:#0a0f1c; --panel:#101828; --border:#1c2740; --fg:#dbe2ec; --dim:#7e8aa3; --accent:#6ab3f7; --user:#173a63; --user-border:#264d7d; --err:#ef6a80; --ok:#4ade80; --warn:#f5c65c; }
  * { box-sizing:border-box; }
  html,body { margin:0; height:100%; background:var(--bg); color:var(--fg); font:15px/1.55 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; touch-action:manipulation; }
  #app { display:flex; flex-direction:column; height:100vh; height:100dvh; max-width:720px; margin:0 auto; }
  /* header 顶部 1px 品牌渐变细线（低调签名，呼应桌面 splash） */
  header { position:relative; display:flex; align-items:center; gap:8px; padding:10px 14px; padding-top:calc(10px + env(safe-area-inset-top)); border-bottom:1px solid var(--border); background:var(--panel); }
  header::before { content:""; position:absolute; top:0; left:0; right:0; height:1px; background:linear-gradient(90deg,transparent,var(--accent),transparent); opacity:.7; }
  .dot { width:9px; height:9px; border-radius:50%; background:var(--dim); flex:none; box-shadow:0 0 0 3px rgba(126,138,163,.12); }
  .dot.on { background:var(--ok); box-shadow:0 0 0 3px rgba(74,222,128,.14), 0 0 8px rgba(74,222,128,.5); }
  .dot.err { background:var(--err); box-shadow:0 0 0 3px rgba(239,106,128,.14); }
  .dot.busy { background:var(--warn); box-shadow:0 0 0 3px rgba(245,198,92,.14), 0 0 8px rgba(245,198,92,.45); animation:pulse 1.1s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity:.45; } }
  .title { font-weight:600; font-size:14px; font-family:ui-monospace,Consolas,"Courier New",monospace; letter-spacing:.5px; }
  .sub { color:var(--dim); font-size:12px; margin-left:auto; }
  #log { flex:1; overflow-y:auto; padding:14px; -webkit-overflow-scrolling:touch; }
  .msg { margin-bottom:14px; }
  .msg .who { font-size:12px; color:var(--dim); margin-bottom:2px; }
  .msg.user { display:flex; flex-direction:column; align-items:flex-end; }
  .msg.user .bubble { background:var(--user); border:1px solid var(--user-border); padding:9px 13px; border-radius:16px 16px 4px 16px; max-width:92%; white-space:pre-wrap; word-break:break-word; box-shadow:0 2px 8px rgba(0,0,0,.25); }
  .msg.user .bubble.pending { opacity:.7; border-style:dashed; box-shadow:none; }
  .msg.assistant .body { padding:0 2px; }
  .msg.tool .body { color:var(--dim); font-family:ui-monospace,Consolas,monospace; font-size:13px; white-space:pre-wrap; word-break:break-word; margin-left:8px; }
  .msg.error .body { color:var(--err); }
  .toolcall { display:flex; align-items:center; gap:6px; color:var(--accent); font-size:12px; font-family:ui-monospace,Consolas,monospace; margin:6px 0 2px; padding:4px 8px; background:var(--panel); border:1px solid var(--border); border-radius:6px; word-break:break-all; -webkit-tap-highlight-color:transparent; }
  .toolcall::before { content:""; width:6px; height:6px; border-radius:50%; background:var(--accent); flex:none; box-shadow:0 0 6px rgba(106,179,247,.6); }
  .toolcall summary { color:var(--accent); cursor:pointer; list-style:none; }
  .toolcall summary::-webkit-details-marker { display:none; }
  details { margin:4px 0; }
  details summary { color:var(--warn); font-size:12px; cursor:pointer; padding:4px 2px; -webkit-tap-highlight-color:transparent; }
  details .think { color:var(--dim); font-size:13px; white-space:pre-wrap; }
  /* 思考过程折叠：小箭头指示（可点击性提示） */
  details.thinkbox > summary { list-style:none; display:flex; align-items:center; gap:6px; }
  details.thinkbox > summary::-webkit-details-marker { display:none; }
  details.thinkbox > summary .th-arrow { display:inline-flex; align-items:center; justify-content:center; color:var(--warn); transition:transform .15s ease-out; }
  details.thinkbox[open] > summary .th-arrow { transform:rotate(90deg); }
  /* 工具结果 / 命令输出：可折叠卡片，默认收起只占一行（渐进披露，替代平铺长文本） */
  details.toolbox { margin:6px 0; border:1px solid var(--border); border-radius:8px; background:var(--panel); overflow:hidden; }
  details.toolbox > summary { list-style:none; display:flex; align-items:center; gap:8px; color:var(--dim); font-size:12px; font-family:ui-monospace,Consolas,monospace; padding:10px 12px; cursor:pointer; -webkit-tap-highlight-color:transparent; }
  details.toolbox > summary::-webkit-details-marker { display:none; }
  details.toolbox > summary .tb-arrow { display:inline-flex; align-items:center; justify-content:center; color:var(--dim); transition:transform .15s ease-out; flex:none; }
  details.toolbox[open] > summary .tb-arrow { transform:rotate(90deg); }
  details.toolbox > summary .tb-name { font-weight:600; color:var(--accent); }
  details.toolbox .tb-body { margin:0; padding:8px 12px 10px; border-top:1px solid var(--border); color:var(--dim); font-family:ui-monospace,Consolas,monospace; font-size:12px; line-height:1.5; white-space:pre-wrap; word-break:break-word; }
  /* toolbox 展开时内容淡入下移（ease-out；reduced-motion 下关闭） */
  details.toolbox[open] .tb-body { animation:tbIn .16s ease-out; }
  @keyframes tbIn { from { opacity:0; transform:translateY(-3px); } to { opacity:1; transform:none; } }
  /* toolcall 胶囊内的参数区：无边框、紧凑（嵌套在胶囊里不需要分隔线） */
  details.toolcall .tb-body { margin:0; padding:4px 2px 2px; color:var(--dim); font-family:ui-monospace,Consolas,monospace; font-size:12px; line-height:1.5; white-space:pre-wrap; word-break:break-word; }
  /* 新消息入场：轻微上浮淡入（ease-out，非首次渲染才触发） */
  @keyframes msgIn { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }
  .msg.anim-in { animation:msgIn .18s ease-out; }
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
  .sk-line { height:14px; border-radius:6px; margin-bottom:10px; background:linear-gradient(90deg,var(--panel) 25%,#1b2740 50%,var(--panel) 75%); background-size:200% 100%; animation:skmove 1.2s linear infinite; }
  .sk-line:last-child { margin-bottom:0; }
  @keyframes skmove { 0% { background-position:200% 0; } 100% { background-position:-200% 0; } }
  /* 空会话引导（品牌终端风：提示符 + 波纹，呼应 DeepDive 深海启动页） */
  .empty { text-align:center; color:var(--dim); padding:56px 24px; }
  .empty .wave { font-size:26px; letter-spacing:2px; color:var(--accent); opacity:.55; margin-bottom:14px; font-family:ui-monospace,Consolas,monospace; animation:waveFloat 3s ease-in-out infinite; }
  @keyframes waveFloat { 50% { opacity:.25; transform:translateY(-2px); } }
  .empty .prompt { display:inline-block; font-family:ui-monospace,Consolas,monospace; font-size:13px; color:var(--accent); background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:8px 14px; margin-bottom:12px; }
  .empty .big { font-size:15px; color:var(--fg); opacity:.85; }
  .empty .sub2 { font-size:13px; margin-top:6px; opacity:.8; }
  /* 回到底部悬浮按钮（滚上去读历史时浮出，新内容到达时高亮计数） */
  #jump { position:fixed; right:18px; bottom:calc(88px + env(safe-area-inset-bottom)); z-index:20; border:none; border-radius:999px; background:var(--accent); color:#08111f; font-size:13px; font-weight:600; padding:0 16px; height:44px; box-shadow:0 4px 14px rgba(0,0,0,.45); cursor:pointer; -webkit-tap-highlight-color:transparent; transition:transform .15s ease, opacity .2s; }
  #jump:hover { background:#7cbcf7; }
  #jump:active { transform:scale(.97); }
  #jump.new { animation:jumpPulse 1.4s ease-in-out infinite; }
  @keyframes jumpPulse { 0%,100% { box-shadow:0 4px 14px rgba(0,0,0,.45); } 50% { box-shadow:0 4px 22px rgba(106,179,247,.55); } }
  /* 错误 toast（替代 alert，不打断浏览） */
  #toast { position:fixed; left:50%; transform:translateX(-50%); bottom:calc(92px + env(safe-area-inset-bottom)); z-index:21; background:#c2455a; color:#fff; font-size:13px; padding:9px 16px; border-radius:10px; max-width:86%; text-align:center; opacity:0; pointer-events:none; transition:opacity .2s; box-shadow:0 4px 14px rgba(0,0,0,.4); }
  #toast.show { opacity:1; }
  #composer { display:flex; gap:8px; align-items:flex-end; padding:10px 14px; padding-bottom:calc(10px + env(safe-area-inset-bottom)); border-top:1px solid var(--border); background:var(--panel); }
  #input { flex:1; background:var(--bg); color:var(--fg); border:1px solid var(--border); border-radius:10px; padding:10px 12px; font-size:16px; outline:none; resize:none; max-height:140px; font-family:inherit; }
  #input:focus { border-color:var(--accent); }
  #send { background:var(--accent); color:#08111f; border:none; border-radius:10px; min-width:64px; min-height:44px; padding:0 18px; font-size:16px; font-weight:600; cursor:pointer; -webkit-tap-highlight-color:transparent; transition:transform .15s ease, opacity .2s; display:inline-flex; align-items:center; justify-content:center; gap:6px; }
  #send:hover { background:#7cbcf7; }
  #send:active { transform:scale(.97); }
  #send:disabled { opacity:.5; cursor:default; }
  #send:disabled:hover { background:var(--accent); }
  /* 发送中 spinner：disabled + 文字前旋转圆环，替代单调的“…” */
  #send.loading::before { content:""; width:14px; height:14px; border:2px solid rgba(8,17,31,.3); border-top-color:#08111f; border-radius:50%; animation:sendspin .7s linear infinite; flex:none; }
  @keyframes sendspin { to { transform:rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    .cur, .dot.busy, .sk-line, #jump.new, #send.loading::before, .msg.anim-in, details.toolbox > summary .tb-arrow, details.thinkbox > summary .th-arrow, details.toolbox[open] .tb-body, .empty .wave { animation:none !important; }
    #send, #jump { transition:none; }
  }
</style>
</head>
<body>
<div id="app">
  <header>
    <span class="dot" id="dot" role="status" aria-live="polite"></span>
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
    <button id="send" aria-label="发送"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="M22 2 15 22 11 13 2 9z"/></svg><span>发送</span></button>
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
  // 折叠箭头：内联 SVG chevron（跨平台一致，currentColor 跟色，展开时 CSS 旋转 90°）。
  function chevronEl(cls) {
    var s = el("span", cls);
    s.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>';
    return s;
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
        d.className = "thinkbox";
        var sum = el("summary", "");
        sum.appendChild(chevronEl("th-arrow"));
        sum.appendChild(el("span", "", "思考过程"));
        d.appendChild(sum);
        var th = el("div", "think");
        th.innerHTML = fmt(m.reasoning);
        d.appendChild(th);
        wrap.appendChild(d);
      }
      if (m.toolCalls && m.toolCalls.length) {
        m.toolCalls.forEach(function (tc) {
          var a = tc.args || "";
          // 默认只显示工具名；参数太长/太乱，点开才看（渐进披露）。
          var d = document.createElement("details");
          d.className = "toolcall";
          var sum = el("summary", "", tc.name);
          d.appendChild(sum);
          if (a) {
            var ab = el("div", "tb-body");
            ab.textContent = a;
            d.appendChild(ab);
          }
          wrap.appendChild(d);
        });
      }
      var body = el("div", "body");
      body.innerHTML = fmt(m.content);
      wrap.appendChild(body);
    } else if (m.role === "user") {
      wrap.appendChild(el("div", "bubble", (m.bash ? "! " : "") + m.content));
      if (m.bashOutput) {
        var lines = m.bashOutput.split("\\n");
        var d = document.createElement("details");
        d.className = "toolbox";
        var sum = el("summary", "");
        sum.appendChild(chevronEl("tb-arrow"));
        var nm = el("span", "tb-name", "命令输出");
        sum.appendChild(nm);
        if (lines.length > 1) sum.appendChild(el("span", "", " · " + lines.length + " 行"));
        d.appendChild(sum);
        var body = el("div", "tb-body");
        body.textContent = lines.join("\\n");
        d.appendChild(body);
        wrap.appendChild(d);
      }
    } else if (m.role === "tool") {
      if (m.content) {
        // 工具结果折叠成卡片，默认收起只占一行（渐进披露）——替代平铺的 3 行预览。
        var l2 = m.content.replace(/\\n+$/, "").split("\\n");
        var d = document.createElement("details");
        d.className = "toolbox";
        var sum = el("summary", "");
        sum.appendChild(chevronEl("tb-arrow"));
        var nm = el("span", "tb-name", "工具结果");
        sum.appendChild(nm);
        if (l2.length > 1) sum.appendChild(el("span", "", " · " + l2.length + " 行"));
        d.appendChild(sum);
        var body = el("div", "tb-body");
        body.textContent = l2.join("\\n");
        d.appendChild(body);
        wrap.appendChild(d);
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
    w.appendChild(el("div", "wave", "〰"));
    w.appendChild(el("div", "prompt", "deepdive@remote:~$"));
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
    var isFirst = !firstSnapshot;
    if (isFirst) {
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
        // 非首快照的新增消息：轻微上浮淡入（首快照整屏渲染不动画，streaming 重建不加）。
        if (!isFirst) node.classList.add("anim-in");
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
    sendBtn.classList.add("loading");
    // 失败不清空输入：错误只弹 toast，用户文字保留可重试。
    fetch("api/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token, text: text })
    }).then(function (r) { return r.json(); }).then(function (j) {
      sendBtn.disabled = false;
      sendBtn.classList.remove("loading");
      if (j.ok) { input.value = ""; grow(); input.focus(); }
      else showToast(j.error || "发送失败");
    }).catch(function () {
      sendBtn.disabled = false;
      sendBtn.classList.remove("loading");
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
