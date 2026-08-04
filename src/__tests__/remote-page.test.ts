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
    scrollHeight: 0,
    scrollTop: 0,
    clientHeight: 0,
    _text: "",
    _html: "",
    appendChild(c: any) {
      this.children.push(c);
      return c;
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
  const document = { createElement: (tag: string) => makeEl(tag) };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function("document", "logEl", chunk + "\nreturn { addMsg, render };") as (
    document: { createElement: (t: string) => unknown },
    logEl: unknown,
  ) => { addMsg: (m: unknown) => void; render: (s: unknown) => void };
  return { api: factory(document, logEl), logEl };
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

  it("truncates tool results to 3 lines + desktop-style '+N lines' marker", () => {
    const { api, logEl } = loadPage();
    api.render(snapshot());
    const tool = logEl.children.find((c: any) => c.className === "msg tool");
    const body = tool.children.find((c: any) => String(c.className).includes("tool body"));
    const text = body._text as string;
    expect(text).toBe("  ⎿ line1\n    line2\n    line3\n    … +47 lines");
    expect(text).not.toContain("line4");
  });

  it("shows tool call lines and collapses reasoning", () => {
    const { api, logEl } = loadPage();
    api.render(snapshot());
    const assistant = logEl.children[1];
    const toolcall = assistant.children.find((c: any) => String(c.className).includes("toolcall"));
    expect(toolcall._text).toContain("→ read_file(");
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
});

