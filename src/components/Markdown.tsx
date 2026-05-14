import type { ReactNode } from "react";
import { Fragment } from "react";
import { Box, Text } from "ink";
import { marked } from "marked";
import type { Tokens } from "marked";
import stringWidth from "string-width";
import { theme } from "../theme.js";

interface Props {
  content: string;
  firstPrefix: string;
  restPrefix: string;
  cols: number;
}

const CODE_BG = "#1e2127";

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
        color: s.color ?? theme.accent,
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
  const body = code.text.replace(/\n+$/, "").split("\n");
  const innerWidth = Math.max(4, width - 2); // " " + body + " "
  if (lang) {
    out.push(<Text dimColor>{lang}</Text>);
  }
  for (const raw of body) {
    const line = stringWidth(raw) > innerWidth ? raw.slice(0, innerWidth - 1) + "…" : raw;
    const pad = " ".repeat(Math.max(0, innerWidth - stringWidth(line)));
    out.push(<Text backgroundColor={CODE_BG}>{" " + line + pad + " "}</Text>);
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
    // codespan renders with " text " padding (see spansToNode) — account for it
    const w = stringWidth(u.text) + (u.style.code ? 2 : 0);
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
        const inner = s.code ? ` ${s.text} ` : s.text;
        // OSC 8 hyperlink: \e]8;;URL\e\\TEXT\e]8;;\e\\ — supported by iTerm2,
        // Kitty, VS Code, modern macOS Terminal, GNOME Terminal, WezTerm, etc.
        // Terminals that don't support it just see the visible text.
        const display = s.href
          ? `\x1b]8;;${s.href}\x07${inner}\x1b]8;;\x07`
          : inner;
        return (
          <Text
            key={i}
            bold={s.bold}
            italic={s.italic}
            underline={s.underline}
            strikethrough={s.strikethrough}
            color={s.color}
            backgroundColor={s.code ? CODE_BG : undefined}
          >
            {display}
          </Text>
        );
      })}
    </Fragment>
  );
}
