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
