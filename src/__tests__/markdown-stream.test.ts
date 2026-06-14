import { describe, it, expect } from "vitest";
import { stableMarkdownPrefix, markdownRows } from "../components/Markdown.js";

const isBlankRow = (r: unknown) => r === "" || r === null || r === undefined;

// stableMarkdownPrefix is the crux of streaming markdown into <Static>: the
// `stable` portion is frozen into scrollback as it streams, so it MUST grow
// monotonically (a prefix of the eventual full text) and split only at real
// top-level block boundaries — never inside a code fence.
describe("stableMarkdownPrefix", () => {
  it("stable + tail always reconstructs the input exactly", () => {
    const samples = [
      "",
      "hello",
      "para one\n\npara two",
      "# Heading\n\nbody text here\n\n- a\n- b\n",
      "```js\nconst x = 1;\n\nconst y = 2;\n```\n\nafter fence",
      "text\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\ntrailing",
    ];
    for (const s of samples) {
      const { stable, tail } = stableMarkdownPrefix(s);
      expect(stable + tail).toBe(s);
    }
  });

  it("holds the last (still-streaming) block back in the tail", () => {
    // Two complete blocks + a third growing one: only the first two are stable.
    const { stable, tail } = stableMarkdownPrefix("alpha\n\nbeta\n\ngamm");
    expect(stable).toBe("alpha\n\nbeta\n\n");
    expect(tail).toBe("gamm");
  });

  it("never splits inside an unclosed code fence", () => {
    // A blank line *inside* a code fence is not a block boundary — the whole
    // unclosed fence is the still-growing tail.
    const { stable, tail } = stableMarkdownPrefix("intro\n\n```js\na\n\nb");
    expect(stable).toBe("intro\n\n");
    expect(tail).toBe("```js\na\n\nb");
  });

  it("keepTrailingBlank preserves the inter-block separator (streaming) but is a prefix of the trimmed whole render", () => {
    // While block "B" streams, the stable prefix is "A\n\n". Frozen with the
    // trailing blank, its rows ["A", ""] carry the separator immediately —
    // and stay an exact prefix of the final trimmed render of "A\n\nB".
    const frozen = markdownRows("A\n\n", 80, "  ", { keepTrailingBlank: true });
    const trimmed = markdownRows("A\n\n", 80, "  ");
    expect(frozen.length).toBe(2);
    expect(isBlankRow(frozen[1])).toBe(true);
    expect(trimmed.length).toBe(1); // default render drops the trailing blank
    const final = markdownRows("A\n\nB", 80, "  ");
    expect(final.length).toBe(3);
    // frozen rows are a positional prefix of the final whole-message render.
    expect(isBlankRow(final[0])).toBe(false);
    expect(isBlankRow(final[1])).toBe(true);
    expect(isBlankRow(final[2])).toBe(false);
  });

  it("grows monotonically as the response streams (prefix stability)", () => {
    const full = "one\n\ntwo\n\nthree\n\nfour";
    let prev = "";
    for (let i = 1; i <= full.length; i++) {
      const { stable } = stableMarkdownPrefix(full.slice(0, i));
      // stable must only ever be the previous stable or an extension of it.
      expect(full.startsWith(stable)).toBe(true);
      expect(stable.startsWith(prev) || prev.startsWith(stable)).toBe(true);
      if (stable.length >= prev.length) prev = stable;
    }
  });
});
