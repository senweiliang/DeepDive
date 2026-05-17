import { describe, it, expect } from "vitest";
import { parseResults, realUrl } from "../tools/websearch.js";

// Fixture mirrors the real lite.duckduckgo.com/lite/ structure (verified
// against a live response): SINGLE-quoted class attrs, href as a
// //duckduckgo.com/l/?uddg=<encoded>&amp;rut=… redirect, entities in text.
const FIXTURE = `
<html><body><form>
<table>
<tr><td>
  <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdeepseek-v4&amp;rut=abc" class='result-link'>DeepSeek&#x27;s V4 &amp; You</a>
</td></tr>
<tr><td class='result-snippet'>An overview of DeepSeek   V4   with &quot;quoted&quot; bits.</td></tr>
<tr><td>
  <a rel="nofollow" href="https://direct.example.org/page" class='result-link'>Direct Link Result</a>
</td></tr>
<tr><td class='result-snippet'>No redirect here.</td></tr>
</table>
</form></body></html>`;

describe("websearch", () => {
  describe("realUrl", () => {
    it("decodes the uddg redirect param", () => {
      expect(
        realUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Ffoo.com%2Fa%20b&rut=x"),
      ).toBe("https://foo.com/a b");
    });

    it("passes through a direct https href", () => {
      expect(realUrl("https://direct.example.org/page")).toBe(
        "https://direct.example.org/page",
      );
    });

    it("upgrades a protocol-relative non-redirect href", () => {
      expect(realUrl("//example.com/x")).toBe("https://example.com/x");
    });
  });

  describe("parseResults", () => {
    it("extracts title, decoded url, and snippet, paired positionally", () => {
      const r = parseResults(FIXTURE);
      expect(r).toHaveLength(2);

      expect(r[0]).toEqual({
        title: "DeepSeek's V4 & You",
        url: "https://example.com/deepseek-v4",
        snippet: 'An overview of DeepSeek V4 with "quoted" bits.',
      });

      expect(r[1]).toEqual({
        title: "Direct Link Result",
        url: "https://direct.example.org/page",
        snippet: "No redirect here.",
      });
    });

    it("returns [] for a rate-limited / empty page", () => {
      expect(parseResults("<html><body>no results</body></html>")).toEqual([]);
    });
  });
});
