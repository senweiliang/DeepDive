import { describe, it, expect } from "vitest";
import { htmlToText } from "../tools/webfetch.js";

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
});
