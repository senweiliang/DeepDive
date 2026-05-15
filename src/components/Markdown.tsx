import type { ReactNode } from "react";
import { Fragment } from "react";
import { Box, Text } from "ink";
import { marked } from "marked";
import type { Tokens } from "marked";
import stringWidth from "string-width";
import { common, createLowlight } from "lowlight";
import { theme } from "../theme.js";

const lowlight = createLowlight(common);

interface Props {
  content: string;
  firstPrefix: string;
  restPrefix: string;
  cols: number;
}

// highlight.js scope → One Dark 颜色。命中越靠后越具体，取第一个匹配即可。
const HL_COLORS: Array<[RegExp, string]> = [
  [/comment|quote/, theme.thinking],
  [/keyword|literal/, theme.cost],
  [/string|regexp|char|addition/, theme.success],
  [/number/, theme.approval],
  [/built_in|class|type|title\.class/, theme.thinking],
  [/title|function/, theme.accent],
  [/tag|name|selector|deletion/, theme.error],
  [/meta|symbol|bullet|link/, theme.action],
];

function scopeColor(className: unknown): string | undefined {
  if (!Array.isArray(className)) return undefined;
  const scope = className
    .filter((c): c is string => typeof c === "string")
    .map((c) => c.replace(/^hljs-/, ""))
    .join(" ");
  for (const [re, color] of HL_COLORS) if (re.test(scope)) return color;
  return undefined;
}

// 把 lowlight 的 hast 树拍平成带颜色的 Span 数组（含换行符，后续再切行）。
function flattenHast(node: any, color: string | undefined, out: Span[]): void {
  if (node.type === "text") {
    if (node.value) out.push({ text: String(node.value), color });
    return;
  }
  const next = scopeColor(node.properties?.className) ?? color;
  for (const child of node.children ?? []) flattenHast(child, next, out);
}

function highlightLines(codeText: string, lang: string): Span[][] {
  let spans: Span[];
  try {
    const tree = lang && lowlight.registered(lang)
      ? lowlight.highlight(lang, codeText)
      : { type: "root", children: [{ type: "text", value: codeText }] };
    spans = [];
    flattenHast(tree, undefined, spans);
  } catch {
    spans = [{ text: codeText }];
  }
  // 按换行符切成多行，样式跟随。
  const lines: Span[][] = [[]];
  for (const s of spans) {
    const parts = s.text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1]!.push({ ...s, text: part });
    });
  }
  return lines;
}

// 按可见宽度截断一行 span（替代旧的 slice，ANSI 安全）。
function truncateLine(spans: Span[], maxWidth: number): Span[] {
  let used = 0;
  const out: Span[] = [];
  for (const s of spans) {
    const w = stringWidth(s.text);
    if (used + w <= maxWidth) {
      out.push(s);
      used += w;
      continue;
    }
    let cut = "";
    for (const ch of s.text) {
      if (used + stringWidth(cut + ch) > maxWidth - 1) break;
      cut += ch;
    }
    out.push({ ...s, text: cut });
    out.push({ text: "…", color: theme.thinking });
    return out;
  }
  return out;
}

export function Markdown({ content, firstPrefix, restPrefix, cols }: Props) {
  const innerWidth = Math.max(20, cols - stringWidth(restPrefix));
  let rows: ReactNode[];
  try {
    const tokens = marked.lexer(content) as unknown as Tokens.Generic[];
    rows = [];
    for (const tok of tokens) renderBlock(rows, tok, innerWidth);
    while (rows.length && isBlank(rows[0])) rows.shift();
    while (rows.length && isBlank(rows[rows.length - 1])) rows.pop();
  } catch {
    rows = content.split("\n");
  }
  if (rows.length === 0) rows = [content || ""];

  return (
    <Box flexDirection="column">
      {rows.map((row, i) => (
        <Text key={i}>
          {i === 0 ? firstPrefix : restPrefix}
          {row}
        </Text>
      ))}
    </Box>
  );
}

function isBlank(node: ReactNode): boolean {
  return node === "" || node === null || node === undefined;
}

// ─── block rendering ────────────────────────────────────────────────────

function renderBlock(out: ReactNode[], tok: Tokens.Generic, width: number) {
  switch (tok.type) {
    case "space":
      if (out.length && !isBlank(out[out.length - 1])) out.push("");
      return;
    case "paragraph": {
      const spans = inlineSpans((tok.tokens ?? []) as Tokens.Generic[]);
      for (const line of wrapSpans(spans, width)) out.push(spansToNode(line));
      return;
    }
    case "heading": {
      const spans = inlineSpans((tok.tokens ?? []) as Tokens.Generic[]).map((s) => ({
        ...s,
        bold: true,
      }));
      for (const line of wrapSpans(spans, width)) out.push(spansToNode(line));
      return;
    }
    case "hr":
      out.push(<Text>{"─".repeat(width)}</Text>);
      return;
    case "blockquote": {
      const inner: ReactNode[] = [];
      for (const child of (tok.tokens ?? []) as Tokens.Generic[]) {
        renderBlock(inner, child, Math.max(10, width - 2));
      }
      for (const line of inner) {
        if (isBlank(line)) {
          out.push("");
          continue;
        }
        out.push(
          <Fragment>
            <Text color={theme.thinking}>▏ </Text>
            <Text dimColor>{line}</Text>
          </Fragment>,
        );
      }
      return;
    }
    case "list": {
      const list = tok as unknown as Tokens.List;
      const start = typeof list.start === "number" ? list.start : 1;
      list.items.forEach((item, idx) => {
        const marker = list.ordered ? `${start + idx}. ` : "• ";
        const indent = " ".repeat(stringWidth(marker));
        const inner: ReactNode[] = [];
        for (const child of (item.tokens ?? []) as Tokens.Generic[]) {
          if (child.type === "text" && Array.isArray(child.tokens)) {
            const spans = inlineSpans(child.tokens as Tokens.Generic[]);
            for (const line of wrapSpans(spans, Math.max(5, width - stringWidth(marker)))) {
              inner.push(spansToNode(line));
            }
          } else {
            renderBlock(inner, child, Math.max(5, width - stringWidth(marker)));
          }
        }
        inner.forEach((line, j) => {
          if (isBlank(line)) {
            out.push("");
            return;
          }
          out.push(
            <Fragment>
              <Text>{j === 0 ? marker : indent}</Text>
              <Text>{line}</Text>
            </Fragment>,
          );
        });
      });
      return;
    }
    case "code":
      pushCodeBlock(out, tok as unknown as Tokens.Code, width);
      return;
    case "table":
      pushTable(out, tok as unknown as Tokens.Table);
      return;
    default: {
      const raw = String(tok.raw ?? tok.text ?? "");
      if (raw.trim()) out.push(raw);
      return;
    }
  }
}

function pushCodeBlock(out: ReactNode[], code: Tokens.Code, width: number) {
  const lang = code.lang ?? "";
  const innerWidth = Math.max(4, width);
  if (lang) {
    out.push(<Text dimColor>{lang}</Text>);
  }
  const lines = highlightLines(code.text.replace(/\n+$/, ""), lang);
  for (const line of lines) {
    out.push(spansToNode(truncateLine(line, innerWidth)));
  }
}

function pushTable(out: ReactNode[], table: Tokens.Table) {
  const header = table.header.map((c) => c.text);
  const rows = table.rows.map((row) => row.map((c) => c.text));
  const align = (table.align ?? []) as ("left" | "right" | "center" | null)[];
  const colWidth = header.map((h, i) => {
    let m = stringWidth(h);
    for (const r of rows) m = Math.max(m, stringWidth(r[i] ?? ""));
    return m;
  });

  const pad = (text: string, w: number, a: "left" | "right" | "center" | null) => {
    const space = w - stringWidth(text);
    if (space <= 0) return text;
    if (a === "right") return " ".repeat(space) + text;
    if (a === "center") {
      const left = Math.floor(space / 2);
      return " ".repeat(left) + text + " ".repeat(space - left);
    }
    return text + " ".repeat(space);
  };
  const sep = (l: string, m: string, r: string) =>
    l + colWidth.map((w) => "─".repeat(w + 2)).join(m) + r;
  const renderRow = (cells: (string | undefined)[]) => (
    <Text>
      {"│ " +
        cells
          .map((c, i) => pad(c ?? "", colWidth[i] ?? 0, align[i] ?? null))
          .join(" │ ") +
        " │"}
    </Text>
  );

  out.push(<Text>{sep("┌", "┬", "┐")}</Text>);
  out.push(renderRow(header));
  out.push(<Text>{sep("├", "┼", "┤")}</Text>);
  for (const r of rows) out.push(renderRow(r));
  out.push(<Text>{sep("└", "┴", "┘")}</Text>);
}

// ─── inline rendering ───────────────────────────────────────────────────

type Span = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  color?: string;
  href?: string;
};

function inlineSpans(tokens: Tokens.Generic[], style: Omit<Span, "text"> = {}): Span[] {
  const out: Span[] = [];
  for (const tok of tokens) {
    switch (tok.type) {
      case "text":
        if (Array.isArray(tok.tokens)) {
          out.push(...inlineSpans(tok.tokens as Tokens.Generic[], style));
        } else {
          out.push({ ...style, text: String(tok.text ?? tok.raw ?? "") });
        }
        break;
      case "strong":
        out.push(
          ...inlineSpans((tok.tokens ?? []) as Tokens.Generic[], { ...style, bold: true }),
        );
        break;
      case "em":
        out.push(
          ...inlineSpans((tok.tokens ?? []) as Tokens.Generic[], { ...style, italic: true }),
        );
        break;
      case "del":
        out.push(
          ...inlineSpans((tok.tokens ?? []) as Tokens.Generic[], {
            ...style,
            strikethrough: true,
          }),
        );
        break;
      case "codespan":
        out.push({ ...style, code: true, text: String(tok.text ?? "") });
        break;
      case "link": {
        const href = String(tok.href ?? "");
        out.push(
          ...inlineSpans((tok.tokens ?? []) as Tokens.Generic[], {
            ...style,
            underline: true,
            color: theme.action,
            href: href || undefined,
          }),
        );
        break;
      }
      case "br":
        out.push({ ...style, text: "\n" });
        break;
      default:
        out.push({ ...style, text: String(tok.text ?? tok.raw ?? "") });
    }
  }
  return out;
}

function wrapSpans(spans: Span[], width: number): Span[][] {
  if (width <= 0) return [spans];
  type Unit = { text: string; isSpace: boolean; isBreak: boolean; style: Omit<Span, "text"> };
  const units: Unit[] = [];
  for (const s of spans) {
    if (!s.text) continue;
    const { text: _ignore, ...style } = s;
    void _ignore;
    // codespan stays as one atomic unit — internal spaces must not be wrap points
    if (s.code) {
      units.push({ text: s.text, isSpace: false, isBreak: false, style });
      continue;
    }
    const segs = s.text.split("\n");
    segs.forEach((seg, i) => {
      if (i > 0) units.push({ text: "", isSpace: false, isBreak: true, style: {} });
      if (!seg) return;
      for (const part of seg.split(/(\s+)/)) {
        if (!part) continue;
        units.push({ text: part, isSpace: /^\s+$/.test(part), isBreak: false, style });
      }
    });
  }

  const lines: Span[][] = [[]];
  let curWidth = 0;
  let atLineStart = true;
  for (const u of units) {
    if (u.isBreak) {
      lines.push([]);
      curWidth = 0;
      atLineStart = true;
      continue;
    }
    if (u.isSpace && atLineStart) continue;
    const w = stringWidth(u.text);
    if (curWidth + w > width && !atLineStart) {
      lines.push([]);
      curWidth = 0;
      atLineStart = true;
      if (u.isSpace) continue;
    }
    const line = lines[lines.length - 1]!;
    line.push({ ...u.style, text: u.text });
    curWidth += w;
    atLineStart = false;
  }
  if (lines.length > 1 && lines[lines.length - 1]!.length === 0) lines.pop();
  return lines;
}

function spansToNode(spans: Span[]): ReactNode {
  if (spans.length === 0) return "";
  return (
    <Fragment>
      {spans.map((s, i) => {
        // OSC 8 hyperlink: \e]8;;URL\e\\TEXT\e]8;;\e\\ — supported by iTerm2,
        // Kitty, VS Code, modern macOS Terminal, GNOME Terminal, WezTerm, etc.
        // Terminals that don't support it just see the visible text.
        const display = s.href
          ? `\x1b]8;;${s.href}\x07${s.text}\x1b]8;;\x07`
          : s.text;
        // Inline code: DeepDive accent (One Dark blue), no background — keeps
        // existing explicit colors (e.g. inside a link) intact via the ?? fallback.
        const color = s.code ? s.color ?? theme.accent : s.color;
        return (
          <Text
            key={i}
            bold={s.bold}
            italic={s.italic}
            underline={s.underline}
            strikethrough={s.strikethrough}
            color={color}
          >
            {display}
          </Text>
        );
      })}
    </Fragment>
  );
}
