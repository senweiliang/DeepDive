import { useState } from "react";
import { Box, Text, useInput } from "ink";
import stringWidth from "string-width";

interface Props {
  onSubmit: (input: string) => void;
  disabled: boolean;
  error: string;
}

const prompt = "> ";
const indent = "  ";

function colWidth(s: string): number {
  return stringWidth(s);
}

/**
 * Map a character offset into `value` to a { line, col } position.
 * `col` is measured in terminal columns (not characters).
 */
function posToLineCol(value: string, offset: number): { line: number; col: number } {
  let line = 0;
  let col = 0;
  for (let i = 0; i < offset && i < value.length; i++) {
    if (value[i] === "\n") {
      line++;
      col = 0;
    } else {
      col += colWidth(value[i]!);
    }
  }
  return { line, col };
}

/**
 * Convert a { line, col } back to character offset.
 * `col` is terminal columns, not characters.
 */
function lineColToOffset(value: string, targetLine: number, targetCol: number): number {
  let line = 0;
  let col = 0;
  for (let i = 0; i < value.length; i++) {
    if (line === targetLine) {
      if (col >= targetCol) return i;
      col += colWidth(value[i]!);
    } else if (value[i] === "\n") {
      line++;
      if (line > targetLine) return i;
    }
  }
  return value.length;
}

export function InputBox({ onSubmit, disabled, error }: Props) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const col = process.stdout.columns || 80;

  useInput((input, key) => {
    if (disabled) return;

    // Arrow keys
    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor((c) => Math.min(value.length, c + 1));
      return;
    }
    if (key.upArrow) {
      const { line, col: curCol } = posToLineCol(value, cursor);
      if (line === 0) return;
      setCursor(lineColToOffset(value, line - 1, curCol));
      return;
    }
    if (key.downArrow) {
      const lines = value.split("\n");
      const { line, col: curCol } = posToLineCol(value, cursor);
      if (line >= lines.length - 1) return;
      setCursor(lineColToOffset(value, line + 1, curCol));
      return;
    }

    // Home / End
    if (key.home) {
      // Move to start of current line
      let i = cursor - 1;
      while (i >= 0 && value[i] !== "\n") i--;
      setCursor(i + 1);
      return;
    }
    if (key.end) {
      // Move to end of current line
      let i = cursor;
      while (i < value.length && value[i] !== "\n") i++;
      setCursor(i);
      return;
    }

    // Paste — insert at cursor
    if (input && (input.includes("\n") || input.includes("\r"))) {
      const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      setValue((prev) => prev.slice(0, cursor) + normalized + prev.slice(cursor));
      setCursor((c) => c + normalized.length);
      return;
    }

    // Ctrl+Enter → newline at cursor
    if (key.ctrl && (input === "j" || input === "m")) {
      setValue((prev) => prev.slice(0, cursor) + "\n" + prev.slice(cursor));
      setCursor((c) => c + 1);
      return;
    }

    // Submit
    if (key.return) {
      if (value.trim()) {
        onSubmit(value.trim());
        setValue("");
        setCursor(0);
      }
      return;
    }

    // Backspace
    if (key.backspace) {
      if (cursor === 0) return;
      setValue((prev) => prev.slice(0, cursor - 1) + prev.slice(cursor));
      setCursor((c) => c - 1);
      return;
    }

    // Delete
    if (key.delete) {
      if (cursor >= value.length) return;
      setValue((prev) => prev.slice(0, cursor) + prev.slice(cursor + 1));
      return;
    }

    // Regular input
    if (input && !key.ctrl && !key.meta && !key.tab && !key.escape) {
      setValue((prev) => prev.slice(0, cursor) + input + prev.slice(cursor));
      setCursor((c) => c + input.length);
    }
  });

  // ── Render: split value into visual lines, embed cursor ──────────

  const logicalLines = value.split("\n");

  interface VisualLine {
    text: string;
    cursorIn: boolean; // this line contains the blinking cursor
    cursorAt: number; // cursor position within text (char index)
  }

  // Find cursor position in logical lines
  let cursorLine = 0;
  let cursorChar = 0;
  {
    let offset = 0;
    for (let i = 0; i < logicalLines.length; i++) {
      const len = logicalLines[i]!.length;
      if (cursor >= offset && cursor <= offset + len) {
        cursorLine = i;
        cursorChar = cursor - offset;
        break;
      }
      offset += len + 1; // +1 for the \n
    }
  }

  // First pass: chunk each logical line into visual lines.
  // Track start/end char indices within the logical line.
  interface Chunk {
    text: string;
    start: number; // char offset within the logical line
  }
  const allChunks: Chunk[][] = []; // per logical line

  for (let li = 0; li < logicalLines.length; li++) {
    const line = logicalLines[li]!;
    const prefix = li === 0 ? prompt : indent;
    const maxCols = col - prefix.length;
    const chunks: Chunk[] = [];

    if (line.length === 0) {
      chunks.push({ text: "", start: 0 });
    } else {
      let chunk = "";
      let chunkCols = 0;
      let chunkStart = 0;
      for (let ci = 0; ci < line.length; ci++) {
        const ch = line[ci]!;
        const chW = colWidth(ch);
        if (chunkCols + chW > maxCols) {
          chunks.push({ text: chunk, start: chunkStart });
          chunk = "";
          chunkCols = 0;
          chunkStart = ci;
        }
        chunk += ch;
        chunkCols += chW;
      }
      if (chunk) chunks.push({ text: chunk, start: chunkStart });
    }
    allChunks.push(chunks);
  }

  // Second pass: build visual lines, marking the one that holds the cursor.
  const visualLines: VisualLine[] = [];
  for (let li = 0; li < allChunks.length; li++) {
    for (const ck of allChunks[li]!) {
      const chunkEnd = ck.start + ck.text.length;
      const hasCursor = li === cursorLine && cursorChar >= ck.start && cursorChar <= chunkEnd;
      visualLines.push({
        text: ck.text,
        cursorIn: hasCursor,
        cursorAt: hasCursor ? cursorChar - ck.start : -1,
      });
    }
  }

  if (visualLines.length === 0) {
    visualLines.push({ text: "", cursorIn: true, cursorAt: 0 });
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>{"─".repeat(col)}</Text>
      {error && <Text color="red">{error}</Text>}
      {!disabled && (
        <Box flexDirection="column">
          {visualLines.map((vl, i) => {
            const isFirst = i === 0;
            const pfx = isFirst ? prompt : indent;

            if (!vl.cursorIn) {
              return (
                <Text key={i}>
                  {pfx}
                  {vl.text}
                </Text>
              );
            }

            // Cursor is in this line — highlight the character at cursor position
            const before = vl.text.slice(0, vl.cursorAt);
            const atCursor = vl.cursorAt < vl.text.length ? vl.text[vl.cursorAt] : " ";
            const after = vl.text.slice(vl.cursorAt + (vl.cursorAt < vl.text.length ? 1 : 0));
            return (
              <Text key={i}>
                {pfx}
                {before}
                <Text backgroundColor="white" color="black">{atCursor}</Text>
                {after}
              </Text>
            );
          })}
        </Box>
      )}
      {disabled && <Text dimColor>thinking...</Text>}
    </Box>
  );
}
