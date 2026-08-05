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
      // NOT `prev.startsWith(stable)` as well: shrinking is exactly the bug —
      // <Static> has already printed those rows and cannot unprint them.
      expect(full.startsWith(stable)).toBe(true);
      expect(stable.startsWith(prev)).toBe(true);
      prev = stable;
    }
  });

  it("does not freeze a list that is still absorbing items", () => {
    // "1. 第一步\n\n" lexes as [paragraph, space, list, space] — the trailing
    // `space` used to make the unfinished list look settled. One keystroke later
    // ("2.") marked folds it straight back into the same list token, so the
    // prefix would SHRINK; the rows are already in scrollback, and ink resumes
    // from a stale index → the answer gets reprinted.
    const before = stableMarkdownPrefix("步骤：\n\n1. 第一步\n\n");
    const mid = stableMarkdownPrefix("步骤：\n\n1. 第一步\n\n2");
    const after = stableMarkdownPrefix("步骤：\n\n1. 第一步\n\n2.");
    expect(before.stable).toBe("步骤：\n\n");
    expect(mid.stable).toBe("步骤：\n\n");
    expect(after.stable).toBe("步骤：\n\n");
  });

  it("settles a list only once a non-list block follows it", () => {
    expect(stableMarkdownPrefix("1. 甲\n2. 乙\n\n结束。").stable).toBe("");
    // The list is done growing only when a later block proves it — and even then
    // it needs one more block after it, since the last token is always the tail.
    expect(stableMarkdownPrefix("1. 甲\n2. 乙\n\n结束。\n\n再见。").stable).toBe(
      "1. 甲\n2. 乙\n\n结束。\n\n",
    );
  });
});

// The rows handed to <Static> are append-only: once a row is printed it can
// never change or disappear. Any markdown re-lex that rewrites an already-frozen
// row shows up on screen as duplicated scrollback.
describe("streamed rows are append-only", () => {
  const textOf = (node: unknown): string => {
    if (node === null || node === undefined || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    const props = (node as { props?: { children?: unknown } }).props;
    return props ? textOf(props.children) : "";
  };

  const frozenRows = (response: string): string[] => {
    const { stable } = stableMarkdownPrefix(response);
    if (!stable) return [];
    return markdownRows(stable, 80, "  ", { keepTrailingBlank: true }).map(textOf);
  };

  const docs = [
    "好的，分三步：\n\n1. 第一步做这个\n2. 第二步做那个\n3. 第三步收尾\n\n完成后就可以了。\n",
    "步骤：\n\n1. 第一步\n\n2. 第二步\n\n3. 第三步\n\n结束。\n",
    "步骤：\n\n1. 先跑命令\n\n   ```bash\n   npm run build\n   ```\n\n2. 再检查输出\n\n完成。\n",
    "结构：\n\n1. 顶层\n   - 子项甲\n   - 子项乙\n2. 第二层\n\n结束。\n",
    "对比：\n\n| 名称 | 说明 |\n|---|---|\n| a | 甲 |\n\n结论在此。\n",
    "# 标题\n\n正文段落。\n\n- 要点甲\n- 要点乙\n\n```ts\nconst x = 1;\n```\n\n收尾。\n",
    "第一组：\n\n1. 甲\n2. 乙\n\n第二组：\n\n1. 丙\n2. 丁\n\n完。\n",
  ];

  it.each(docs)("never rewrites a printed row while streaming %#", (doc) => {
    let prev: string[] = [];
    for (let i = 1; i <= doc.length; i++) {
      const rows = frozenRows(doc.slice(0, i));
      for (let r = 0; r < prev.length; r++) {
        expect(rows[r], `char ${i}, row ${r} of ${JSON.stringify(doc.slice(0, i))}`).toBe(
          prev[r],
        );
      }
      prev = rows;
    }
  });
});
