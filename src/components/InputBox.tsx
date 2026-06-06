import { useState, useRef, useEffect } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import { readdir, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import stringWidth from "string-width";
import { theme } from "../theme.js";
import { slashCommands } from "../commands/index.js";
import { getOriginalCwd } from "../workspace.js";

interface Props {
  onSubmit: (input: string) => void;
  streaming: boolean;
  error: string;
  history: string[];
  slashCommands?: SlashCommandSuggestion[];
  /** Current working directories (original cwd + session dirs + persisted). */
  workingDirs?: string[];
  /** Seed value at mount — used to restore text after a recalled send.
   *  Only read on mount (the box is remounted via a key bump). */
  initialValue?: string;
}

export interface SlashCommandSuggestion {
  name: string;
  description: string;
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

/** Max directory candidates shown at once. */
const MAX_DIR_CANDIDATES = 10;

/**
 * Parse the /add-dir argument into:
 * - dirBase: absolute directory to list (starts at CWD, moves on each /)
 * - dirFilter: prefix to filter subdirectory names ("" = show all)
 * - dirRelPrefix: relative path prefix for Tab completion display
 */
export function parseAddDirArg(arg: string): {
  dirBase: string;
  dirFilter: string;
  dirRelPrefix: string;
} {
  const cwd = getOriginalCwd();
  const trimmed = arg.trim();
  if (!trimmed) return { dirBase: cwd, dirFilter: "", dirRelPrefix: "" };

  // Find the last path separator position.
  let lastSep = -1;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const ch = trimmed[i]!;
    if (ch === "/" || ch === "\\") { lastSep = i; break; }
  }

  if (lastSep === -1) {
    // Bare drive letter with no trailing slash, e.g. "C:" — treat as root.
    if (/^[A-Za-z]:$/.test(trimmed)) {
      return { dirBase: trimmed[0]! + ":\\", dirFilter: "", dirRelPrefix: trimmed.toLowerCase() + "/" };
    }
    // No separator — filter against CWD entries.
    return { dirBase: cwd, dirFilter: trimmed, dirRelPrefix: "" };
  }

  const pathPart = trimmed.slice(0, lastSep);
  const filterPart = trimmed.slice(lastSep + 1);

  // Resolve the base directory.
  let dirBase: string;
  if (/^[A-Za-z]:$/.test(pathPart)) {
    // Drive letter like "d:" → root of that drive (resolve() would give
    // the CWD on that drive, e.g. D:\code\DeepDive, not D:\).
    dirBase = pathPart + "\\";
  } else if (pathPart === "" && lastSep === 0) {
    // Leading / → filesystem root
    dirBase = process.platform === "win32"
      ? resolve(cwd, "/").slice(0, 3) // e.g. "C:\\"
      : "/";
  } else {
    dirBase = resolve(cwd, pathPart);
  }

  // Relative prefix for completions: the path part + trailing separator.
  const sep = trimmed[lastSep]!;
  let dirRelPrefix: string;
  if (dirBase === cwd) {
    dirRelPrefix = "";
  } else if (pathPart === "") {
    // Root path
    dirRelPrefix = sep === "\\" ? trimmed.slice(0, 3) : "/";
  } else if (pathPart === "/") {
    // pathPart is already root — don't double up the separator.
    dirRelPrefix = "/";
  } else {
    dirRelPrefix = pathPart + sep;
  }
  // Normalize to forward slashes for consistent display.
  dirRelPrefix = dirRelPrefix.replace(/\\/g, "/");

  return { dirBase, dirFilter: filterPart, dirRelPrefix };
}

/**
 * List subdirectory names under `dirBase`, filtered case-insensitively
 * by `filter` prefix. Returns all matching names sorted alphabetically.
 */
async function listDirCandidates(
  dirBase: string,
  filter: string,
): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    const raw = await readdir(dirBase, { withFileTypes: true });
    entries = raw.map((d) => ({
      name: String(d.name),
      isDirectory: () => d.isDirectory(),
    }));
  } catch {
    return [];
  }
  const lower = filter.toLowerCase();
  return entries
    .filter((d) => d.isDirectory() && d.name.toLowerCase().startsWith(lower))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => d.name);
}

const prompt = "> ";
const indent = "  ";

const BUILTIN_SLASH_COMMANDS: SlashCommandSuggestion[] = slashCommands.map(
  (cmd) => ({ name: `/${cmd.name}`, description: cmd.description ?? "" }),
);

function mergeSlashCommands(
  extraCommands: SlashCommandSuggestion[],
): SlashCommandSuggestion[] {
  const seen = new Set<string>();
  const merged: SlashCommandSuggestion[] = [];
  for (const command of [...BUILTIN_SLASH_COMMANDS, ...extraCommands]) {
    if (seen.has(command.name)) continue;
    seen.add(command.name);
    merged.push(command);
  }
  merged.sort((a, b) => a.name.localeCompare(b.name));
  return merged;
}

function colWidth(s: string): number {
  return stringWidth(s);
}

/**
 * Word-wrap text so each line fits within `maxCols` terminal columns (CJK-aware).
 * Returns an array of wrapped lines.
 */
function wrapText(text: string, maxCols: number): string[] {
  if (maxCols <= 0) return [text];
  const words = text.split(/\s+/);
  if (words.length === 0) return [text];
  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;
  for (const word of words) {
    const wordWidth = colWidth(word);
    const space = line ? 1 : 0;
    if (line && lineWidth + space + wordWidth > maxCols) {
      lines.push(line);
      line = word;
      lineWidth = wordWidth;
    } else {
      line = line ? line + " " + word : word;
      lineWidth += space + wordWidth;
    }
  }
  if (line) lines.push(line);
  return lines;
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

export function InputBox({
  onSubmit,
  streaming,
  error,
  history = [],
  slashCommands = [],
  workingDirs = [],
  initialValue = "",
}: Props) {
  const [value, setValue] = useState(initialValue);
  const [cursor, setCursor] = useState(initialValue.length);
  const historyIdx = useRef(-1);
  const draft = useRef<{ value: string; cursor: number; blocks: PasteBlock[] }>({
    value: "",
    cursor: 0,
    blocks: [],
  });
  const col = process.stdout.columns || 80;
  const availableSlashCommands = mergeSlashCommands(slashCommands);

  // Each paste is tracked independently. #N increments across the whole
  // session (never reset) so repeated pastes always count upward.
  const [pasteBlocks, setPasteBlocks] = useState<PasteBlock[]>([]);
  const pasteCounter = useRef(1);

  // Slash suggestion selection
  const [slashIdx, setSlashIdx] = useState(0);

  // Directory completion for /add-dir <path>
  const [dirCandidates, setDirCandidates] = useState<string[]>([]);
  const [dirIdx, setDirIdx] = useState(0);
  const dirScrollRef = useRef(0);
  // dirRelPrefix: the path prefix to prepend to a candidate name when
  // Tab-completing (e.g. "src/" or ""), set by the useEffect below.
  const dirRelPrefixRef = useRef("");
  // Track the current argument text so Tab knows how many chars to replace.
  const dirArgRef = useRef("");
  // Validation error shown below candidates (Enter without existing submit).
  const [dirError, setDirError] = useState("");

  // Reset slash index when filter changes
  const rawTrimmed = value.trimStart();
  const prevRawRef = useRef("");
  if (rawTrimmed !== prevRawRef.current) {
    prevRawRef.current = rawTrimmed;
    if (slashIdx !== 0) setSlashIdx(0);
  }

  // ── Directory completion for /add-dir ──────────────────────────
  useEffect(() => {
    setDirError(""); // clear stale validation error on every input change
    const m = value.match(/^\s*\/add-dir\s+(.*)/);
    if (!m) {
      setDirCandidates([]);
      setDirIdx(0);
      dirScrollRef.current = 0;
      dirArgRef.current = "";
      dirRelPrefixRef.current = "";
      return;
    }

    const arg = m[1]!;
    const { dirBase, dirFilter, dirRelPrefix } = parseAddDirArg(arg);
    dirArgRef.current = arg;
    dirRelPrefixRef.current = dirRelPrefix;

    let cancelled = false;
    listDirCandidates(dirBase, dirFilter).then((names) => {
      if (cancelled) return;
      // If the argument changed while async was in flight, discard.
      if (dirArgRef.current !== arg) return;
      setDirCandidates(names);
      setDirIdx(0);
      dirScrollRef.current = 0;
    });

    return () => {
      cancelled = true;
    };
  }, [value]);

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
      // Navigate directory candidates when visible
      if (dirCandidates.length > 0) {
        const next = dirIdx > 0 ? dirIdx - 1 : dirCandidates.length - 1;
        setDirIdx(next);
        if (next === dirCandidates.length - 1) {
          // Wrapped to bottom — scroll to show it.
          dirScrollRef.current = Math.max(0, next - MAX_DIR_CANDIDATES + 1);
        } else if (next < dirScrollRef.current) {
          dirScrollRef.current = next;
        }
        return;
      }
      // Navigate slash suggestions when visible
      const raw = value.trimStart();
      if (raw.startsWith("/") && !raw.includes(" ")) {
        const matches = availableSlashCommands.filter((c) => c.name.startsWith(raw) && c.name !== raw);
        if (matches.length > 0) {
          setSlashIdx((prev) => (prev > 0 ? prev - 1 : matches.length - 1));
          return;
        }
      }
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
      // Navigate directory candidates when visible
      if (dirCandidates.length > 0) {
        const next = dirIdx < dirCandidates.length - 1 ? dirIdx + 1 : 0;
        setDirIdx(next);
        if (next === 0) {
          // Wrapped to top — reset scroll.
          dirScrollRef.current = 0;
        } else if (next >= dirScrollRef.current + MAX_DIR_CANDIDATES) {
          dirScrollRef.current = next - MAX_DIR_CANDIDATES + 1;
        }
        return;
      }
      // Navigate slash suggestions when visible
      const raw = value.trimStart();
      if (raw.startsWith("/") && !raw.includes(" ")) {
        const matches = availableSlashCommands.filter((c) => c.name.startsWith(raw) && c.name !== raw);
        if (matches.length > 0) {
          setSlashIdx((prev) => (prev < matches.length - 1 ? prev + 1 : 0));
          return;
        }
      }
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

    // Tab → autocomplete (dir candidates first, then slash command)
    if (key.tab) {
      // Handle directory completion
      if (dirCandidates.length > 0) {
        const name = dirCandidates[dirIdx];
        if (name !== undefined) {
          const completion = dirRelPrefixRef.current + name + "/";
          const argLen = dirArgRef.current.length;
          // Find where the argument starts (after "/add-dir" + whitespace).
          const cmdIdx = value.search(/\/add-dir\b/);
          if (cmdIdx !== -1) {
            const afterCmd = value.slice(cmdIdx + 8);
            const spaceLen = afterCmd.match(/^\s+/)?.[0]?.length ?? 0;
            const argStart = cmdIdx + 8 + spaceLen;
            setValue(
              value.slice(0, argStart) +
                completion +
                value.slice(argStart + argLen),
            );
            setCursor(argStart + completion.length);
          }
          setDirCandidates([]);
          setDirIdx(0);
          dirScrollRef.current = 0;
          return;
        }
      }
      const raw = value; // use raw value, not display
      const prefix = raw.trimStart();
      if (prefix.startsWith("/") && !prefix.includes(" ")) {
        const matches = availableSlashCommands.filter((c) => c.name.startsWith(prefix) && c.name !== prefix);
        const idx = Math.min(slashIdx, matches.length - 1);
        const match = matches[idx];
        if (match) {
          const leading = raw.slice(0, raw.length - raw.trimStart().length);
          const trailing = raw.slice(raw.trimStart().length);
          const completed = leading + match.name + " ";
          setValue(completed + trailing);
          setCursor(completed.length);
          return;
        }
      }
      return;
    }

    // Submit — value already holds the full pasted content inline.
    if (key.return) {
      // ── /add-dir validation ──────────────────────────────────
      const addDirMatch = value.match(/^\s*\/add-dir\s+(.*)/);
      if (addDirMatch) {
        const arg = addDirMatch[1]!.trim();
        if (!arg) {
          setDirError("Usage: /add-dir <path>");
          return;
        }
        // Resolve the full path and validate in one async pass.
        const resolved = /^[A-Za-z]:$/.test(arg)
          ? arg + "\\"   // bare drive letter → root of that drive
          : resolve(getOriginalCwd(), arg);
        stat(resolved).then(
          (s) => {
            if (!s.isDirectory()) {
              setDirError(`${resolved} is not a directory.`);
              return;
            }
            // Check if already inside an existing working directory.
            for (const wd of workingDirs) {
              if (resolved === wd || resolved.startsWith(wd + sep)) {
                setDirError(`${resolved} is already accessible within ${wd}.`);
                return;
              }
            }
            // Valid path — clear error and submit.
            setDirError("");
            setDirCandidates([]);
            setDirIdx(0);
            dirScrollRef.current = 0;
            onSubmit(value.replace(/\s+$/, ""));
            setValue("");
            setCursor(0);
            setPasteBlocks([]);
            historyIdx.current = -1;
          },
          () => {
            setDirError(`${resolved} was not found.`);
          },
        );
        return;
      }
      // When slash suggestions are visible, Enter autocompletes (like Tab)
      const raw = value;
      const prefix = raw.trimStart();
      if (prefix.startsWith("/") && !prefix.includes(" ")) {
        const matches = availableSlashCommands.filter((c) => c.name.startsWith(prefix) && c.name !== prefix);
        if (matches.length > 0) {
          const idx = Math.min(slashIdx, matches.length - 1);
          const match = matches[idx];
          if (match) {
            const leading = raw.slice(0, raw.length - raw.trimStart().length);
            const trailing = raw.slice(raw.trimStart().length);
            const completed = leading + match.name + " ";
            setValue(completed + trailing);
            setCursor(completed.length);
            return;
          }
        }
      }
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

  // ── Bash mode: first char is ! → prompt becomes "! " instead of "> " ──
  const bashMode = value.startsWith("!");
  // In bash mode, the leading ! is "consumed" by the prompt. Build the display
  // from the command portion only, with paste block positions shifted by -1.
  const displayValue = bashMode ? value.slice(1) : value;
  const displayBlocks = bashMode
    ? pasteBlocks
        .filter((b) => b.end > 1)
        .map((b) => ({ ...b, start: Math.max(0, b.start - 1), end: b.end - 1 }))
    : pasteBlocks;
  const displayCursor = bashMode ? Math.max(0, cursor - 1) : cursor;

  // ── Render: collapse blocks, wrap to terminal width, embed cursor ──

  const { display, dBlock, segs } = buildDisplay(displayValue, displayBlocks);
  const dCur = rawToDisplay(segs, displayCursor);

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
    const pfx = visual.length === 0 ? (bashMode ? "! " : prompt) : indent;
    const maxCols = col - colWidth(pfx);
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

  // A fully-typed, known slash command followed by whitespace (e.g.
  // "/settings ") is colored blue. Suggestions already vanish once a space is
  // typed; this gives confirming feedback that the command was recognized.
  const cmdMatch = bashMode ? null : value.match(/^(\s*)(\/[a-zA-Z][\w-]*)(\s)/);
  const cmdRange =
    cmdMatch && availableSlashCommands.some((c) => c.name === cmdMatch[2])
      ? {
          dStart: rawToDisplay(segs, cmdMatch[1]!.length),
          dEnd: rawToDisplay(segs, cmdMatch[1]!.length + cmdMatch[2]!.length),
        }
      : null;

  type RunKind = "text" | "pill" | "cursor" | "command";
  const kindAt = (g: number): "pill" | "command" | "text" => {
    if (dBlock[g]! >= 0) return "pill";
    if (cmdRange && g >= cmdRange.dStart && g < cmdRange.dEnd) return "command";
    return "text";
  };

  function buildRuns(
    text: string,
    gStart: number,
    isCursorChunk: boolean,
    cur: number,
  ): { text: string; kind: RunKind }[] {
    const runs: { text: string; kind: RunKind }[] = [];
    let buf = "";
    let bufKind: "pill" | "command" | "text" = "text";
    const flush = () => {
      if (buf) {
        runs.push({ text: buf, kind: bufKind });
        buf = "";
      }
    };
    for (let i = 0; i < text.length; i++) {
      if (isCursorChunk && i === cur) {
        // Highlight the char at the cursor like ordinary text. The cursor can
        // only ever land on a pill's first char (its left edge) — never inside
        // it — so this never visually shifts the placeholder.
        flush();
        runs.push({ text: text[i]!, kind: "cursor" });
        continue;
      }
      const k = kindAt(gStart + i);
      if (buf && k !== bufKind) flush();
      if (!buf) bufKind = k;
      buf += text[i];
    }
    flush();
    if (isCursorChunk && cur === text.length) runs.push({ text: " ", kind: "cursor" });
    return runs;
  }

  // ── Slash command suggestions ──────────────────────────────────
  const showSlash =
    rawTrimmed.startsWith("/") &&
    !rawTrimmed.includes(" ") &&
    rawTrimmed.length >= 1;
  const slashSuggestions = showSlash
    ? availableSlashCommands.filter((c) => c.name.startsWith(rawTrimmed) && c.name !== rawTrimmed)
    : [];
  const safeIdx = Math.min(Math.max(0, slashIdx), slashSuggestions.length - 1);

  return (
    <Box flexDirection="column">
      <Text color={bashMode ? theme.bash : undefined} dimColor={!bashMode}>
        {"─".repeat(col)}
      </Text>
      {error && <Text color={theme.error}>{error}</Text>}
      <Box flexDirection="column">
        {visual.map((vl, i) => {
          const isFirst = i === 0;
          const pfx = isFirst ? (bashMode ? "! " : prompt) : indent;
          const runs = buildRuns(vl.text, vl.g0, i === curIdx, localCur);
          return (
            <Text key={i}>
              {isFirst && bashMode ? (
                <Text color={theme.bash}>! </Text>
              ) : (
                <Text>{pfx}</Text>
              )}
              {runs.map((r, j) =>
                r.kind === "cursor" ? (
                  <Text key={j} backgroundColor="white" color="black">
                    {r.text}
                  </Text>
                ) : r.kind === "pill" ? (
                  <Text key={j} dimColor>
                    {r.text}
                  </Text>
                ) : r.kind === "command" ? (
                  <Text key={j} color={theme.accent}>
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
      {dirCandidates.length > 0 ? (
        <>
          <Text dimColor>{"─".repeat(col)}</Text>
          {dirCandidates
            .slice(dirScrollRef.current, dirScrollRef.current + MAX_DIR_CANDIDATES)
            .map((name, i) => {
              const actualIdx = dirScrollRef.current + i;
              const isSelected = actualIdx === dirIdx;
              const label = `  ${name}/`;
              return (
                <Text key={name}>
                  {isSelected ? (
                    <Text color={theme.accent}>{label}</Text>
                  ) : (
                    <Text>{label}</Text>
                  )}
                </Text>
              );
            })}
          {dirError ? (
            <Text color={theme.error}>  {dirError}</Text>
          ) : null}
        </>
      ) : slashSuggestions.length > 0 ? (
        <>
          <Text dimColor>{"─".repeat(col)}</Text>
          {slashSuggestions.map((s, i) => {
            const nameColWidth = Math.max(20, ...slashSuggestions.map((c) => c.name.length + 2));
            const pad = " ".repeat(Math.max(2, nameColWidth - s.name.length));
            const isSelected = i === safeIdx;
            const prefix = `  ${s.name}${pad}  `;
            const descIndent = colWidth(prefix);
            const maxDescCols = Math.max(1, col - descIndent);
            const descLines = wrapText(s.description, maxDescCols);
            const labelLines = descLines.map((l, j) =>
              j === 0 ? prefix + l : " ".repeat(descIndent) + l,
            );
            const label = labelLines.join("\n");
            return (
              <Text key={s.name}>
                {isSelected ? (
                  <Text color={theme.accent}>{label}</Text>
                ) : (
                  <Text dimColor>{label}</Text>
                )}
              </Text>
            );
          })}
        </>
      ) : (
        <Text color={bashMode ? theme.bash : undefined} dimColor={!bashMode}>
          {"─".repeat(col)}
        </Text>
      )}
    </Box>
  );
}
