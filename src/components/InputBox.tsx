import { useState, useRef } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import stringWidth from "string-width";
import { theme } from "../theme.js";

interface Props {
  onSubmit: (input: string) => void;
  streaming: boolean;
  error: string;
  history: string[];
}

// A pasted block lives inline inside `value` as raw content; it is only
// *rendered* as a collapsed placeholder. The cursor treats it atomically.
interface PasteBlock {
  id: number;
  start: number; // raw offset in value (inclusive)
  end: number; // raw offset in value (exclusive)
  lines: number; // newline count, captured at paste time (avoids re-slicing)
}

// Aligned with Claude Code: collapse a paste into a placeholder when it is
// longer than this many characters OR spans more than 2 line breaks.
const PASTE_THRESHOLD = 800;
const PASTE_MAX_NEWLINES = 2;

const prompt = "> ";
const indent = "  ";

function colWidth(s: string): number {
  return stringWidth(s);
}

function formatPasteLabel(id: number, lines: number): string {
  if (lines === 0) return `[Pasted text #${id}]`;
  return `[Pasted text #${id} +${lines} lines]`;
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

type Seg =
  | { kind: "text"; raw0: number; raw1: number; dStart: number }
  | { kind: "paste"; id: number; raw0: number; raw1: number; dStart: number; label: string };

/**
 * Build the *displayed* string: each paste block's raw content is replaced by
 * its collapsed placeholder label. `dBlock[i]` is the block id owning display
 * char `i`, or -1 for ordinary text.
 */
function buildDisplay(value: string, blocks: PasteBlock[]): {
  display: string;
  segs: Seg[];
  dBlock: number[];
} {
  const sorted = [...blocks].sort((a, b) => a.start - b.start);
  const segs: Seg[] = [];
  const dBlock: number[] = [];
  let display = "";
  let pos = 0;

  for (const b of sorted) {
    if (b.start > pos) {
      const content = value.slice(pos, b.start);
      segs.push({ kind: "text", raw0: pos, raw1: b.start, dStart: display.length });
      for (let i = 0; i < content.length; i++) dBlock.push(-1);
      display += content;
    }
    const label = formatPasteLabel(b.id, b.lines);
    segs.push({ kind: "paste", id: b.id, raw0: b.start, raw1: b.end, dStart: display.length, label });
    for (let i = 0; i < label.length; i++) dBlock.push(b.id);
    display += label;
    pos = b.end;
  }
  if (pos < value.length || segs.length === 0) {
    const content = value.slice(pos);
    segs.push({ kind: "text", raw0: pos, raw1: value.length, dStart: display.length });
    for (let i = 0; i < content.length; i++) dBlock.push(-1);
    display += content;
  }
  return { display, segs, dBlock };
}

/** Raw offset (never inside a block) → display offset. */
function rawToDisplay(segs: Seg[], raw: number): number {
  for (const seg of segs) {
    if (seg.kind === "text") {
      if (raw >= seg.raw0 && raw <= seg.raw1) return seg.dStart + (raw - seg.raw0);
    } else {
      if (raw === seg.raw0) return seg.dStart;
      if (raw === seg.raw1) return seg.dStart + seg.label.length;
    }
  }
  return 0;
}

/** Display offset → raw offset, snapping out of any placeholder label. */
function displayToRaw(segs: Seg[], d: number, valueLen: number): number {
  for (const seg of segs) {
    const dEnd =
      seg.kind === "text"
        ? seg.dStart + (seg.raw1 - seg.raw0)
        : seg.dStart + seg.label.length;
    if (d >= seg.dStart && d <= dEnd) {
      if (seg.kind === "text") return seg.raw0 + (d - seg.dStart);
      // Inside a placeholder: snap to nearest edge so the cursor never
      // lands *within* the pill.
      return d < seg.dStart + seg.label.length / 2 ? seg.raw0 : seg.raw1;
    }
  }
  return valueLen;
}

export function InputBox({ onSubmit, streaming, error, history = [] }: Props) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const historyIdx = useRef(-1);
  const draft = useRef<{ value: string; cursor: number; blocks: PasteBlock[] }>({
    value: "",
    cursor: 0,
    blocks: [],
  });
  const col = process.stdout.columns || 80;

  // Each paste is tracked independently. #N increments across the whole
  // session (never reset) so repeated pastes always count upward.
  const [pasteBlocks, setPasteBlocks] = useState<PasteBlock[]>([]);
  const pasteCounter = useRef(1);

  usePaste((text) => {
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const newlines = (normalized.match(/\n/g) || []).length;

    // Short pastes are inserted as ordinary text — no placeholder.
    if (normalized.length <= PASTE_THRESHOLD && newlines <= PASTE_MAX_NEWLINES) {
      const len = normalized.length;
      setValue(value.slice(0, cursor) + normalized + value.slice(cursor));
      setPasteBlocks(
        pasteBlocks.map((b) =>
          b.start >= cursor ? { ...b, start: b.start + len, end: b.end + len } : b,
        ),
      );
      setCursor(cursor + len);
      return;
    }

    // Long paste → collapse into an atomic placeholder. A trailing space is
    // added after the pill so typing can continue naturally.
    const id = pasteCounter.current++;
    const ins = normalized + " ";
    const blockStart = cursor;
    const blockEnd = cursor + normalized.length;

    setValue(value.slice(0, cursor) + ins + value.slice(cursor));
    setPasteBlocks(
      [
        ...pasteBlocks.map((b) =>
          b.start >= cursor
            ? { ...b, start: b.start + ins.length, end: b.end + ins.length }
            : b,
        ),
        { id, start: blockStart, end: blockEnd, lines: newlines },
      ].sort((a, b) => a.start - b.start),
    );
    setCursor(cursor + ins.length); // land just after the trailing space
  });

  useInput((input, key) => {
    const { display, segs } = buildDisplay(value, pasteBlocks);
    const dCur = rawToDisplay(segs, cursor);

    // ── Arrow navigation ──────────────────────────────────────────
    if (key.leftArrow) {
      if (cursor === 0) return;
      const blk = pasteBlocks.find((b) => b.end === cursor);
      setCursor(blk ? blk.start : cursor - 1);
      return;
    }
    if (key.rightArrow) {
      if (cursor >= value.length) return;
      const blk = pasteBlocks.find((b) => b.start === cursor);
      setCursor(blk ? blk.end : cursor + 1);
      return;
    }
    if (key.upArrow) {
      const { line, col: curCol } = posToLineCol(display, dCur);
      if (line > 0) {
        setCursor(displayToRaw(segs, lineColToOffset(display, line - 1, curCol), value.length));
        return;
      }
      if (curCol > 0) {
        setCursor(displayToRaw(segs, lineColToOffset(display, 0, 0), value.length));
        return;
      }
      if (history.length > 0) {
        if (historyIdx.current === -1) {
          draft.current = { value, cursor, blocks: pasteBlocks };
        }
        const newIdx = Math.min(historyIdx.current + 1, history.length - 1);
        historyIdx.current = newIdx;
        setValue(history[newIdx]!);
        setPasteBlocks([]);
        setCursor(0);
      }
      return;
    }
    if (key.downArrow) {
      const displayLines = display.split("\n");
      const lastLineIdx = displayLines.length - 1;
      const { line, col: curCol } = posToLineCol(display, dCur);
      if (line < lastLineIdx) {
        setCursor(displayToRaw(segs, lineColToOffset(display, line + 1, curCol), value.length));
        return;
      }
      const atEnd = dCur >= display.length || display[dCur] === "\n";
      if (!atEnd) {
        let i = dCur;
        while (i < display.length && display[i] !== "\n") i++;
        setCursor(displayToRaw(segs, i, value.length));
        return;
      }
      if (history.length > 0 && historyIdx.current >= 0) {
        if (historyIdx.current > 0) {
          historyIdx.current--;
          setValue(history[historyIdx.current]!);
          setPasteBlocks([]);
          setCursor(history[historyIdx.current]!.length);
        } else {
          historyIdx.current = -1;
          setValue(draft.current.value);
          setPasteBlocks(draft.current.blocks);
          setCursor(draft.current.cursor);
        }
      }
      return;
    }

    // ── Home / End (display-space) ────────────────────────────────
    if (key.home) {
      let i = dCur - 1;
      while (i >= 0 && display[i] !== "\n") i--;
      setCursor(displayToRaw(segs, i + 1, value.length));
      return;
    }
    if (key.end) {
      let i = dCur;
      while (i < display.length && display[i] !== "\n") i++;
      setCursor(displayToRaw(segs, i, value.length));
      return;
    }

    // Ctrl+Enter → newline at cursor
    if (key.ctrl && (input === "j" || input === "m")) {
      setValue(value.slice(0, cursor) + "\n" + value.slice(cursor));
      setPasteBlocks(
        pasteBlocks.map((b) =>
          b.start >= cursor ? { ...b, start: b.start + 1, end: b.end + 1 } : b,
        ),
      );
      setCursor(cursor + 1);
      return;
    }

    // Submit — value already holds the full pasted content inline.
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

    // ── Backspace ─────────────────────────────────────────────────
    if (key.backspace) {
      if (cursor === 0) return;
      const blk = pasteBlocks.find((b) => b.end === cursor);
      if (blk) {
        // Deleting the pill removes the entire pasted content.
        const dLen = blk.end - blk.start;
        setValue(value.slice(0, blk.start) + value.slice(blk.end));
        setPasteBlocks(
          pasteBlocks
            .filter((x) => x.id !== blk.id)
            .map((x) =>
              x.start >= blk.end ? { ...x, start: x.start - dLen, end: x.end - dLen } : x,
            ),
        );
        setCursor(blk.start);
        return;
      }
      const i = cursor - 1;
      setValue(value.slice(0, i) + value.slice(i + 1));
      setPasteBlocks(
        pasteBlocks.map((x) =>
          x.start > i ? { ...x, start: x.start - 1, end: x.end - 1 } : x,
        ),
      );
      setCursor(i);
      return;
    }

    // ── Delete (forward) ──────────────────────────────────────────
    if (key.delete) {
      if (cursor >= value.length) return;
      const blk = pasteBlocks.find((b) => b.start === cursor);
      if (blk) {
        const dLen = blk.end - blk.start;
        setValue(value.slice(0, blk.start) + value.slice(blk.end));
        setPasteBlocks(
          pasteBlocks
            .filter((x) => x.id !== blk.id)
            .map((x) =>
              x.start >= blk.end ? { ...x, start: x.start - dLen, end: x.end - dLen } : x,
            ),
        );
        setCursor(blk.start);
        return;
      }
      setValue(value.slice(0, cursor) + value.slice(cursor + 1));
      setPasteBlocks(
        pasteBlocks.map((x) =>
          x.start > cursor ? { ...x, start: x.start - 1, end: x.end - 1 } : x,
        ),
      );
      return;
    }

    // ── Regular input ─────────────────────────────────────────────
    if (input && !key.ctrl && !key.meta && !key.tab && !key.escape) {
      setValue(value.slice(0, cursor) + input + value.slice(cursor));
      setPasteBlocks(
        pasteBlocks.map((b) =>
          b.start >= cursor
            ? { ...b, start: b.start + input.length, end: b.end + input.length }
            : b,
        ),
      );
      setCursor(cursor + input.length);
    }
  });

  // ── Render: collapse blocks, wrap to terminal width, embed cursor ──

  const { display, dBlock, segs } = buildDisplay(value, pasteBlocks);
  const dCur = rawToDisplay(segs, cursor);

  // Logical lines (split on \n), each carrying its global display offset.
  const logical: { text: string; g0: number }[] = [];
  {
    let start = 0;
    for (let i = 0; i <= display.length; i++) {
      if (i === display.length || display[i] === "\n") {
        logical.push({ text: display.slice(start, i), g0: start });
        start = i + 1;
      }
    }
  }

  // Wrap each logical line into visual chunks, tracking global offsets.
  const visual: { text: string; g0: number }[] = [];
  for (let li = 0; li < logical.length; li++) {
    const { text: line, g0 } = logical[li]!;
    const prefix = visual.length === 0 ? prompt : indent;
    const maxCols = col - prefix.length;
    if (line.length === 0) {
      visual.push({ text: "", g0 });
      continue;
    }
    let chunk = "";
    let chunkCols = 0;
    let chunkStart = 0;
    for (let ci = 0; ci < line.length; ci++) {
      const ch = line[ci]!;
      const w = colWidth(ch);
      if (chunkCols + w > maxCols) {
        visual.push({ text: chunk, g0: g0 + chunkStart });
        chunk = "";
        chunkCols = 0;
        chunkStart = ci;
      }
      chunk += ch;
      chunkCols += w;
    }
    if (chunk) visual.push({ text: chunk, g0: g0 + chunkStart });
  }
  if (visual.length === 0) visual.push({ text: "", g0: 0 });

  // Which visual line owns the cursor?
  let curIdx = -1;
  let localCur = 0;
  for (let i = 0; i < visual.length; i++) {
    const { g0, text } = visual[i]!;
    if (dCur >= g0 && dCur < g0 + text.length) {
      curIdx = i;
      localCur = dCur - g0;
      break;
    }
  }
  if (curIdx === -1) {
    curIdx = visual.length - 1;
    localCur = visual[curIdx]!.text.length;
  }

  function buildRuns(
    text: string,
    gStart: number,
    isCursorChunk: boolean,
    cur: number,
  ): { text: string; kind: "text" | "pill" | "cursor" }[] {
    const runs: { text: string; kind: "text" | "pill" | "cursor" }[] = [];
    let buf = "";
    let bufBlock = false;
    const flush = () => {
      if (buf) {
        runs.push({ text: buf, kind: bufBlock ? "pill" : "text" });
        buf = "";
      }
    };
    for (let i = 0; i < text.length; i++) {
      const isBlock = dBlock[gStart + i]! >= 0;
      if (isCursorChunk && i === cur) {
        // Highlight the char at the cursor like ordinary text. The cursor can
        // only ever land on a pill's first char (its left edge) — never inside
        // it — so this never visually shifts the placeholder.
        flush();
        runs.push({ text: text[i]!, kind: "cursor" });
        bufBlock = i + 1 < text.length ? dBlock[gStart + i + 1]! >= 0 : false;
        continue;
      }
      if (buf && isBlock !== bufBlock) flush();
      if (!buf) bufBlock = isBlock;
      buf += text[i];
    }
    flush();
    if (isCursorChunk && cur === text.length) runs.push({ text: " ", kind: "cursor" });
    return runs;
  }

  return (
    <Box flexDirection="column">
      <Text dimColor>{"─".repeat(col)}</Text>
      {error && <Text color={theme.error}>{error}</Text>}
      <Box flexDirection="column">
        {visual.map((vl, i) => {
          const pfx = i === 0 ? prompt : indent;
          const runs = buildRuns(vl.text, vl.g0, i === curIdx, localCur);
          return (
            <Text key={i}>
              {pfx}
              {runs.map((r, j) =>
                r.kind === "cursor" ? (
                  <Text key={j} backgroundColor="white" color="black">
                    {r.text}
                  </Text>
                ) : r.kind === "pill" ? (
                  <Text key={j} dimColor>
                    {r.text}
                  </Text>
                ) : (
                  <Text key={j}>{r.text}</Text>
                ),
              )}
            </Text>
          );
        })}
      </Box>
      <Text dimColor>{"─".repeat(col)}</Text>
    </Box>
  );
}
