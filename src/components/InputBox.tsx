import { useState, useRef } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import stringWidth from "string-width";

interface Props {
  onSubmit: (input: string) => void;
  streaming: boolean;
  error: string;
  history: string[];
}

interface PasteBlock {
  id: number;
  start: number;
  end: number;
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

export function InputBox({ onSubmit, streaming, error, history = [] }: Props) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const historyIdx = useRef(-1);
  const draft = useRef({ value: "", cursor: 0 });
  const col = process.stdout.columns || 80;

  // Each paste is tracked independently so repeated pastes show as separate placeholders.
  const [pasteBlocks, setPasteBlocks] = useState<PasteBlock[]>([]);
  const pasteCounter = useRef(1);

  function formatPasteLabel(text: string, id: number): string {
    const lines = text.split("\n");
    if (lines.length > 1) return `[Pasted text #${id} +${lines.length} lines]`;
    return `[Pasted text #${id}]`;
  }

  usePaste((text) => {
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const pasteId = pasteCounter.current++;
    const insLen = normalized.length;

    setValue((prev) => prev.slice(0, cursor) + normalized + prev.slice(cursor));

    setPasteBlocks((prev) => {
      // Remove any block that this paste is inserted into the middle of
      const filtered = prev.filter((b) => !(b.start < cursor && cursor < b.end));
      // Shift blocks after the cursor
      const shifted = filtered.map((b) => {
        if (b.start >= cursor) {
          return { ...b, start: b.start + insLen, end: b.end + insLen };
        }
        return b;
      });
      return [...shifted, { id: pasteId, start: cursor, end: cursor + insLen }].sort(
        (a, b) => a.start - b.start,
      );
    });

    setCursor((c) => c + insLen);
  });

  useInput((input, key) => {

    // Any modification or navigation clears paste collapse
    if (input || key.backspace || key.delete || key.return || key.leftArrow || key.rightArrow || key.upArrow || key.downArrow || key.home || key.end) {
      setPasteBlocks([]);
    }

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
      // Stage 1: not on first line → move cursor up one line
      const { line, col: curCol } = posToLineCol(value, cursor);
      if (line > 0) {
        setCursor(lineColToOffset(value, line - 1, curCol));
        return;
      }
      // Stage 2: on first line, not at column 0 → move to start of line
      if (curCol > 0) {
        setCursor(lineColToOffset(value, 0, 0));
        return;
      }
      // Stage 3: at start of first line → history navigation
      if (history.length > 0) {
        if (historyIdx.current === -1) {
          draft.current = { value, cursor };
        }
        const newIdx = Math.min(historyIdx.current + 1, history.length - 1);
        historyIdx.current = newIdx;
        setValue(history[newIdx]!);
        setCursor(0);
      }
      return;
    }
    if (key.downArrow) {
      const lines = value.split("\n");
      const lastLineIdx = lines.length - 1;
      // Stage 1: not on last line → move cursor down one line
      const { line, col: curCol } = posToLineCol(value, cursor);
      if (line < lastLineIdx) {
        setCursor(lineColToOffset(value, line + 1, curCol));
        return;
      }
      // Stage 2: on last line, not at end → move to end of line
      const atEnd = cursor >= value.length || value[cursor] === "\n";
      if (!atEnd) {
        // move to end of last line
        let i = cursor;
        while (i < value.length && value[i] !== "\n") i++;
        setCursor(i);
        return;
      }
      // Stage 3: at end of last line → history navigation
      if (history.length > 0 && historyIdx.current >= 0) {
        if (historyIdx.current > 0) {
          historyIdx.current--;
          setValue(history[historyIdx.current]!);
          setCursor(history[historyIdx.current]!.length);
        } else {
          // historyIdx === 0 → back to draft
          historyIdx.current = -1;
          setValue(draft.current.value);
          setCursor(draft.current.cursor);
        }
      }
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

    // Ctrl+Enter → newline at cursor
    if (key.ctrl && (input === "j" || input === "m")) {
      setValue((prev) => prev.slice(0, cursor) + "\n" + prev.slice(cursor));
      setCursor((c) => c + 1);
      return;
    }

    // Submit
    if (key.return) {
      if (streaming) return;
      if (value.trim()) {
        onSubmit(value.replace(/\s+$/, ""));
        setValue("");
        setCursor(0);
        setPasteBlocks([]);
        historyIdx.current = -1;
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

  // ── Render: segmented paste blocks or full value ─────────────────

  if (pasteBlocks.length > 0) {
    // Build display segments from value + pasteBlocks
    const sorted = [...pasteBlocks].sort((a, b) => a.start - b.start);
    const segs: { kind: "text" | "paste"; id?: number; content: string }[] = [];
    let pos = 0;
    for (const b of sorted) {
      if (b.start > pos) {
        segs.push({ kind: "text", content: value.slice(pos, b.start) });
      }
      segs.push({ kind: "paste", id: b.id, content: value.slice(b.start, b.end) });
      pos = b.end;
    }
    if (pos < value.length) {
      segs.push({ kind: "text", content: value.slice(pos) });
    }

    return (
      <Box flexDirection="column">
        <Text dimColor>{"─".repeat(col)}</Text>
        {error && <Text color="red">{error}</Text>}
        {segs.map((seg, i) => {
          if (seg.kind === "paste") {
            return (
              <Box key={i}>
                <Text>{"  "}</Text>
                <Text backgroundColor="white" color="black">
                  {formatPasteLabel(seg.content, seg.id!)}
                </Text>
              </Box>
            );
          }
          // Text segment — show compact preview
          const textLines = seg.content.split("\n");
          if (textLines.length <= 2 && seg.content.length <= 120) {
            return textLines.map((line, j) => (
              <Text key={`${i}-${j}`} dimColor>
                {j === 0 ? "  " : "  "}
                {line || " "}
              </Text>
            ));
          }
          const preview = textLines.slice(0, 2);
          const more = textLines.length - preview.length;
          return (
            <Box key={i} flexDirection="column">
              {preview.map((line, j) => (
                <Text key={j} dimColor>
                  {j === 0 ? "  " : "  "}
                  {line.slice(0, col - 4) || " "}
                </Text>
              ))}
              {more > 0 && (
                <Text dimColor>{"  "}… +{more} lines</Text>
              )}
            </Box>
          );
        })}
        <Text dimColor> (type to expand or Enter to send)</Text>
        <Text dimColor>{"─".repeat(col)}</Text>
      </Box>
    );
  }

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
    <Box flexDirection="column">
      <Text dimColor>{"─".repeat(col)}</Text>
      {error && <Text color="red">{error}</Text>}
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
      <Text dimColor>{"─".repeat(col)}</Text>
    </Box>
  );
}
