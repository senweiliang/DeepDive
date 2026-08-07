import { describe, it, expect } from "vitest";
import { pageHtml } from "../remote/page.js";

/**
 * Regression tests for the inline mobile page's mini-markdown renderer.
 *
 * The page is a TS template literal (`src/remote/page.ts`), so regex escape
 * sequences written as `\s` / `\S` silently lose their backslash when the
 * template is evaluated (invalid escapes collapse to the bare char) — the
 * fence regex once degraded from `[\s\S]` (any char) to `[sS]`. These tests
 * evaluate the ACTUAL shipped string, so any such trap surfaces here.
 */
function extractFmt(): (s: string) => string {
  const m = pageHtml.match(/function fmt\(s\) \{[\s\S]*?\n  \}/);
  if (!m) throw new Error("fmt function not found in pageHtml");
  // Evaluate fmt with `esc` in scope (both come from the page's IIFE).
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function("esc", `${m[0]};\nreturn fmt;`) as (
    esc: (s: string) => string,
  ) => (s: string) => string;
  const esc = (s: string) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return factory(esc);
}

describe("remote mobile page — markdown renderer", () => {
  it("renders multi-line fenced code blocks ([\s\S] trap)", () => {
    const fmt = extractFmt();
    const out = fmt("```js\nconsole.log(1);\n```");
    expect(out).toContain("<pre>console.log(1);</pre>");
  });

  it("strips the fence language tag", () => {
    const fmt = extractFmt();
    const out = fmt("```ts\nconst x = 1;\n```");
    expect(out).toContain("<pre>const x = 1;</pre>");
    expect(out).not.toContain("<pre>ts");
  });

  it("renders inline code, bold and headings", () => {
    const fmt = extractFmt();
    expect(fmt("use `git log`")).toContain("<code>git log</code>");
    expect(fmt("**bold**")).toContain("<strong>bold</strong>");
    expect(fmt("# hi")).toContain("<h1>hi</h1>");
    expect(fmt("## sub")).toContain("<h2>sub</h2>");
  });

  it("escapes HTML before adding tags (no XSS via content)", () => {
    const fmt = extractFmt();
    const out = fmt("<script>alert(1)</script> **b**");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("<strong>b</strong>");
  });

  it("escapes quotes and ampersands", () => {
    const fmt = extractFmt();
    const out = fmt('a & b "c"');
    expect(out).toContain("a &amp; b &quot;c&quot;");
  });
});

// ── DOM-shim simulation of the phone page rendering a live snapshot ──────
// The page is an IIFE bound to `document` + `logEl`; we evaluate its
// render/addMsg with a minimal fake DOM so the ACTUAL shipped page logic is
// exercised (structure sanity + desktop-aligned truncation).
function makeEl(tag: string): any {
  const node: any = {
    tagName: tag,
    className: "",
    children: [] as any[],
    style: {},
    hidden: false,
    scrollHeight: 0,
    scrollTop: 0,
    clientHeight: 0,
    parentNode: null,
    _text: "",
    _html: "",
    classList: {
      _s: {} as Record<string, boolean>,
      add(c: string) {
        this._s[c] = true;
      },
      remove(c: string) {
        delete this._s[c];
      },
      contains(c: string) {
        return !!this._s[c];
      },
    },
    appendChild(c: any) {
      c.parentNode = this;
      this.children.push(c);
      return c;
    },
    removeChild(c: any) {
      const idx = this.children.indexOf(c);
      if (idx >= 0) this.children.splice(idx, 1);
      c.parentNode = null;
      return c;
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    },
    replaceWith(fresh: any) {
      const p = this.parentNode;
      if (p) {
        const idx = p.children.indexOf(this);
        if (idx >= 0) p.children[idx] = fresh;
        fresh.parentNode = p;
      }
    },
    set textContent(v: string) {
      this._text = v;
      if (v === "") this.children = [];
    },
    get textContent() {
      return this._text;
    },
    set innerHTML(v: string) {
      this._html = v;
    },
    get innerHTML() {
      return this._html;
    },
  };
  return node;
}

function loadPage() {
  const head = pageHtml.split("var es = new EventSource")[0] ?? "";
  const chunk = head.slice(head.indexOf("function esc"));
  const logEl = makeEl("div");
  const jumpEl = makeEl("button");
  const toastEl = makeEl("div");
  const document = { createElement: (tag: string) => makeEl(tag) };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(
    "document",
    "logEl",
    "jumpEl",
    "toastEl",
    chunk + "\nreturn { render, buildMsgEl };",
  ) as (
    document: { createElement: (t: string) => unknown },
    logEl: unknown,
    jumpEl: unknown,
    toastEl: unknown,
  ) => { render: (s: unknown) => void; buildMsgEl: (m: unknown) => any };
  return { api: factory(document, logEl, jumpEl, toastEl), logEl, jumpEl };
}

describe("remote mobile page — snapshot render (DOM shim)", () => {
  function snapshot(): Record<string, unknown> {
    return {
      sessionId: "s1",
      isStreaming: false,
      pendingUser: null,
      messages: [
        { role: "user", content: "帮我搜索 read_file 相关代码" },
        {
          role: "assistant",
          content: "好的，我先搜索。",
          reasoning: "user wants a code search",
          toolCalls: [{ name: "read_file", args: '{"file_path": "src/a.ts"}' }],
        },
        { role: "tool", content: Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join("\n") },
        { role: "assistant", content: "找到了：`src/a.ts` 里有相关逻辑。\n\n```ts\nconst x = 1;\n```" },
      ],
      streaming: "",
      thinking: "",
    };
  }

  it("renders one .msg wrapper per message in order (no structural chaos)", () => {
    const { api, logEl } = loadPage();
    api.render(snapshot());
    const wraps = logEl.children.filter((c: any) => String(c.className).includes("msg"));
    expect(wraps).toHaveLength(4);
    expect(wraps[0].className).toBe("msg user");
    expect(wraps[1].className).toBe("msg assistant");
    expect(wraps[2].className).toBe("msg tool");
    expect(wraps[3].className).toBe("msg assistant");
  });

  // DOM shim 的 _text 只反映直接 textContent；details summary 由多个子 span 拼成，需递归聚合
  function collectText(n: any): string {
    if (!n) return "";
    if (n._text) return n._text;
    return (n.children || []).map(collectText).join("");
  }

  it("collapses tool results into a toolbox card (progressive disclosure, no inline text dump)", () => {
    const { api, logEl } = loadPage();
    api.render(snapshot());
    const tool = logEl.children.find((c: any) => c.className === "msg tool");
    // 工具结果折叠成 details.toolbox，默认收起：不把 50 行平铺进流里
    const box = tool.children.find((c: any) => c.tagName === "details" && String(c.className).includes("toolbox"));
    expect(box).toBeTruthy();
    expect(box.open).toBeFalsy(); // 默认收起
    // summary 显示「工具结果 · N 行」，正文在展开后才可见
    const sumText = collectText(box.children[0]);
    expect(sumText).toContain("工具结果");
    expect(sumText).toContain("50");
    // 折叠态下正文在 details 内部（未展开时不占消息流视线）；内容完整保留待展开
    const bodyText = box.children[1]?._text as string;
    expect(bodyText).toBe(Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join("\n"));
  });

  it("shows tool call capsules (name only) and collapses reasoning", () => {
    const { api, logEl } = loadPage();
    api.render(snapshot());
    const assistant = logEl.children[1];
    const toolcall = assistant.children.find((c: any) => String(c.className).includes("toolcall"));
    expect(toolcall.tagName).toBe("details");
    // 胶囊默认只显示工具名（参数点开才看，不再平铺 "→ name(args)" 长文本）
    const sumText = toolcall.children[0]._text as string;
    expect(sumText).toBe("read_file");
    const argsBody = toolcall.children[1]?._text as string;
    expect(argsBody).toContain("src/a.ts");
    const details = assistant.children.find((c: any) => c.tagName === "details");
    expect(details).toBeTruthy();
  });

  it("escapes model content (no raw HTML injection) but renders markdown tags", () => {
    const { api, logEl } = loadPage();
    const snap = snapshot();
    (snap.messages as any[])[3].content = "<script>alert(1)</script> **ok** `x`";
    api.render(snap);
    const assistant = logEl.children[3];
    const body = assistant.children.find((c: any) => String(c.className) === "body");
    expect(body.innerHTML).toContain("&lt;script&gt;");
    expect(body.innerHTML).not.toContain("<script>");
    expect(body.innerHTML).toContain("<strong>ok</strong>");
    expect(body.innerHTML).toContain("<code>x</code>");
  });

  it("renders the in-flight stream tail while streaming", () => {
    const { api, logEl } = loadPage();
    const snap = snapshot();
    (snap as any).isStreaming = true;
    (snap as any).streaming = "正在输出…";
    api.render(snap);
    const last = logEl.children[logEl.children.length - 1];
    expect(String(last.className)).toContain("assistant");
    const stream = last.children.find((c: any) => String(c.className).includes("stream"));
    expect(stream).toBeTruthy();
    expect(stream.innerHTML).toContain("正在输出…");
  });

  it("preserves scroll position when the user scrolled up", () => {
    const { api, logEl } = loadPage();
    logEl.scrollHeight = 2000;
    logEl.clientHeight = 500;
    logEl.scrollTop = 800; // user is reading history, not following the bottom
    api.render(snapshot());
    expect(logEl.scrollTop).toBe(800);
  });

  it("auto-follows the bottom when the user is already at the bottom", () => {
    const { api, logEl } = loadPage();
    logEl.scrollHeight = 2000;
    logEl.clientHeight = 500;
    logEl.scrollTop = 1950;
    api.render(snapshot());
    expect(logEl.scrollTop).toBe(logEl.scrollHeight);
  });

  // ── incremental render (no full rebuild on every snapshot) ────────────
  it("reuses unchanged message nodes across snapshots (no full rebuild)", () => {
    const { api, logEl } = loadPage();
    api.render(snapshot());
    const first = logEl.children[0];
    const third = logEl.children[2];
    api.render(snapshot());
    expect(logEl.children[0]).toBe(first);
    expect(logEl.children[2]).toBe(third);
    expect(logEl.children).toHaveLength(4);
  });

  it("replaces only the changed message node, leaving the rest untouched", () => {
    const { api, logEl } = loadPage();
    api.render(snapshot());
    const first = logEl.children[0];
    const oldSecond = logEl.children[1];
    const snap = snapshot();
    (snap.messages as any[])[1].content = "好的，我换一种说法。";
    api.render(snap);
    expect(logEl.children[0]).toBe(first); // untouched node keeps its identity
    expect(logEl.children[1]).not.toBe(oldSecond);
    const body = logEl.children[1].children.find((c: any) => String(c.className) === "body");
    expect(body.innerHTML).toContain("我换一种说法");
  });

  it("updates the streaming tail in place without rebuilding its wrapper", () => {
    const { api, logEl } = loadPage();
    const snap = snapshot();
    (snap as any).isStreaming = true;
    (snap as any).streaming = "正在输出…";
    api.render(snap);
    const wrapper = logEl.children[logEl.children.length - 1];
    (snap as any).streaming = "正在输出…更长";
    api.render(snap);
    expect(logEl.children[logEl.children.length - 1]).toBe(wrapper);
    const stream = wrapper.children.find((c: any) => String(c.className).includes("stream"));
    expect(stream.innerHTML).toContain("正在输出…更长");
  });

  it("shows an empty-state guide when the session has no messages", () => {
    const { api, logEl } = loadPage();
    api.render({
      sessionId: "s1",
      isStreaming: false,
      pendingUser: null,
      messages: [],
      streaming: "",
      thinking: "",
    });
    expect(logEl.children.some((c: any) => String(c.className).includes("empty"))).toBe(true);
  });

  it("renders the queued user message as a dashed pending bubble, then removes it once committed", () => {
    const { api, logEl } = loadPage();
    const snap = snapshot();
    (snap as any).pendingUser = "排队中的消息";
    api.render(snap);
    const last = logEl.children[logEl.children.length - 1];
    const bubble = last.children.find((c: any) => String(c.className).includes("pending"));
    expect(bubble).toBeTruthy();
    expect(bubble.textContent).toBe("排队中的消息");
    (snap as any).pendingUser = null;
    api.render(snap);
    expect(logEl.children.some((c: any) => String(c.className).includes("pending"))).toBe(false);
  });

  it("floats a jump-to-bottom button when the user scrolled up and new content arrives", () => {
    const { api, logEl, jumpEl } = loadPage();
    logEl.scrollHeight = 2000;
    logEl.clientHeight = 500;
    logEl.scrollTop = 800; // reading history, not following the bottom
    api.render(snapshot());
    expect(jumpEl.hidden).toBe(false);
    expect(String(jumpEl.textContent)).toContain("新消息");
  });

  it("switches from the in-flight stream tail to the committed full message at stream end (no tail loss)", () => {
    const { api, logEl } = loadPage();
    const full = "第一段内容。第二段内容。第三段内容。【结尾标记】";
    const snap = snapshot();
    (snap as any).isStreaming = true;
    (snap as any).streaming = "第一段内容。";
    api.render(snap);
    // 流式尾部逐帧增长（原地更新，不重建 wrapper）。
    (snap as any).streaming = "第一段内容。第二段内容。";
    api.render(snap);
    (snap as any).streaming = "第一段内容。第二段内容。第三段内容。";
    api.render(snap);
    // 流结束：streaming 清空 + isStreaming=false + 完整消息提交进 messages。
    const done = snapshot();
    (done.messages as any[]).push({ role: "assistant", content: full });
    (done as any).isStreaming = false;
    (done as any).streaming = "";
    api.render(done);
    // streaming 节点被移除，完整消息（含结尾标记）落在 transcript 里。
    expect(logEl.children.some((c: any) => String(c.className).includes("stream"))).toBe(false);
    const last = logEl.children[logEl.children.length - 1];
    const body = last.children.find((c: any) => String(c.className) === "body");
    expect(body.innerHTML).toContain("【结尾标记】");
    expect(body.innerHTML).toContain("第三段内容");
  });
});

