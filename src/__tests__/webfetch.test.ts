import { describe, it, expect } from "vitest";
import { htmlToText, looksBlocked } from "../tools/webfetch.js";

describe("webfetch", () => {
  describe("htmlToText", () => {
    it("drops script/style/head and keeps body text", () => {
      const html = `
        <html><head><title>T</title><style>.a{color:red}</style></head>
        <body><script>var x=1;</script><p>Hello world</p></body></html>`;
      const out = htmlToText(html);
      expect(out).toBe("Hello world");
      expect(out).not.toContain("var x");
      expect(out).not.toContain("color:red");
    });

    it("renders links as 'text (url)' and decodes entities", () => {
      const html = `<p>See <a href="https://ex.com/a">the &amp; docs</a> now</p>`;
      expect(htmlToText(html)).toBe("See the & docs (https://ex.com/a) now");
    });

    it("keeps plain (relative/anchor) link text without a url", () => {
      expect(htmlToText(`<a href="#sec">Section</a>`)).toBe("Section");
    });

    it("turns block elements and <br> into newlines", () => {
      const html = `<h1>Title</h1><p>Para one</p><p>Line<br>break</p>`;
      expect(htmlToText(html)).toBe("Title\nPara one\nLine\nbreak");
    });

    it("renders list items as bullets", () => {
      expect(htmlToText(`<ul><li>one</li><li>two</li></ul>`)).toBe(
        "- one\n- two",
      );
    });

    it("collapses excess whitespace and blank lines", () => {
      const html = `<p>a   b</p>\n\n\n\n<p>c</p>`;
      expect(htmlToText(html)).toBe("a b\n\nc");
    });
  });

  describe("looksBlocked", () => {
    it("flags a thin HTML body (SPA shell / bot wall) — no site name needed", () => {
      // ~170 chars: the kind of placeholder a JS-rendered site returns.
      const shell =
        "Something went wrong, but don’t fret — let’s give it another " +
        "shot. Try again. Some browser extensions may cause issues here.";
      expect(looksBlocked(shell, true)).toBe(true);
    });

    it("does NOT flag a thin body when it is not HTML (valid short JSON)", () => {
      expect(looksBlocked(`{"ok":true,"count":3}`, false)).toBe(false);
    });

    it("flags generic Cloudflare / CAPTCHA / JS interstitials", () => {
      expect(looksBlocked("Checking your browser before accessing", false)).toBe(
        true,
      );
      expect(looksBlocked("Please enable JavaScript to continue", false)).toBe(
        true,
      );
      expect(looksBlocked("Verify you are human", false)).toBe(true);
    });

    it("does not flag a long article that merely mentions JavaScript", () => {
      const article =
        "How to enable JavaScript in your browser. " +
        "Lorem ipsum dolor sit amet. ".repeat(80);
      expect(looksBlocked(article, true)).toBe(false);
    });

    it("does not flag normal long content", () => {
      const content =
        "The quick brown fox jumps over the lazy dog. ".repeat(10);
      expect(looksBlocked(content, true)).toBe(false);
    });
  });
});
