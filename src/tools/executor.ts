import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { spawn, execSync } from "node:child_process";
import { join, dirname, resolve, sep } from "node:path";
import { displayPath } from "./format.js";

export type ToolResult = {
  content: string;
  isError: boolean;
  /** Output was truncated because it exceeded the maxOutput cap. */
  truncated?: boolean;
};

/**
 * Maximum characters of bash output kept inline in the conversation.
 * Excess is truncated with a marker. Mirrors Claude Code's approach
 * (`BASH_MAX_OUTPUT_DEFAULT = 30_000`) to prevent a single runaway
 * command from consuming the entire context window.
 *
 * Environment variable DEEPDIVE_MAX_BASH_OUTPUT overrides this,
 * capped at MAX_BASH_OUTPUT_UPPER_LIMIT.
 */
const MAX_BASH_OUTPUT_UPPER_LIMIT = 150_000;
const MAX_BASH_OUTPUT_DEFAULT = 30_000;

export function getMaxBashOutput(): number {
  const env = process.env.DEEPDIVE_MAX_BASH_OUTPUT;
  if (env !== undefined) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) {
      return Math.min(n, MAX_BASH_OUTPUT_UPPER_LIMIT);
    }
  }
  return MAX_BASH_OUTPUT_DEFAULT;
}

/**
 * Bash timeout — mirrors Claude Code timeouts.ts approach.
 *
 * Default 120s (2 min) — same as Claude Code DEFAULT_TIMEOUT_MS.
 * Max 600s (10 min) — same as Claude Code MAX_TIMEOUT_MS.
 * Both can be overridden via environment variables.
 *
 * The model can pass a `timeout` parameter (in ms) with each bash call
 * to override the default for long-running commands.
 */
const BASH_DEFAULT_TIMEOUT_MS = 120_000;
const BASH_MAX_TIMEOUT_MS = 600_000;

function getDefaultBashTimeoutMs(): number {
  const env = process.env.DEEPDIVE_BASH_DEFAULT_TIMEOUT_MS;
  if (env !== undefined) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return BASH_DEFAULT_TIMEOUT_MS;
}

function getMaxBashTimeoutMs(): number {
  const env = process.env.DEEPDIVE_BASH_MAX_TIMEOUT_MS;
  if (env !== undefined) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) {
      return Math.max(n, getDefaultBashTimeoutMs());
    }
  }
  return Math.max(BASH_MAX_TIMEOUT_MS, getDefaultBashTimeoutMs());
}

/**
 * Resolve the effective timeout for a bash call.
 * Order: model-provided `timeout` arg → env default → built-in default (120s).
 * Clamped to [1, max] so the model can never exceed the configured max.
 */
function resolveBashTimeout(timeoutArg: unknown): number {
  if (typeof timeoutArg === "number" && Number.isFinite(timeoutArg) && timeoutArg > 0) {
    return Math.min(timeoutArg, getMaxBashTimeoutMs());
  }
  return getDefaultBashTimeoutMs();
}

/**
 * Truncate output to the limit, keeping the head and appending a
 * human-readable truncation marker.
 */
function capOutput(raw: string, limit: number): string {
  if (raw.length <= limit) return raw;
  const removed = raw.length - limit;
  const removedKB = Math.round(removed / 1024);
  return raw.slice(0, limit) + `\n... [output truncated — ${removedKB}KB removed]`;
}

/**
 * Kill a process and its entire tree. On Windows we must use `taskkill /T`
 * because `child.kill()` (TerminateProcess) only kills the direct child
 * (the shell) but not the grandchildren spawned by it. On Unix we use a
 * negative-PID process group kill so SIGKILL reaches every process in the
 * foreground group.
 */
function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" });
    } catch {
      // Process may have already exited — ignore.
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // fall through
    }
  }
}

export function execute(
  name: string,
  args: Record<string, unknown>,
  workspace: string,
): ToolResult {
  try {
    switch (name) {
      case "read_file":
        return readFile(args, workspace);
      case "write_file":
        return writeFile(args, workspace);
      case "edit_file":
        return editFile(args, workspace);
      case "glob":
        return runGlob(args, workspace);
      case "grep":
        return runGrep(args, workspace);
      default:
        return { content: `Unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    return {
      content: `Error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

function checkPath(workspace: string, filePath: string): string | null {
  if (!filePath) return null;
  // Relative paths resolve against the workspace; absolute paths pass through.
  // Access outside the workspace is NOT blocked here — it's gated by an
  // approval prompt upstream (App.tsx), so the user can allow it per-call.
  return resolve(workspace, filePath);
}

function pathError(): ToolResult {
  return {
    content: "Error: file_path is required.",
    isError: true,
  };
}

function readFile(
  args: Record<string, unknown>,
  workspace: string,
): ToolResult {
  const resolved = checkPath(workspace, String(args.file_path));
  if (!resolved) return pathError();
  const content = readFileSync(resolved, "utf-8");
  const lines = content.split("\n");
  const offset = Math.max(1, Number(args.offset) || 1);
  const limit = args.limit ? Number(args.limit) : undefined;
  const startIdx = offset - 1;
  const sliced = limit
    ? lines.slice(startIdx, startIdx + limit).join("\n")
    : lines.slice(startIdx).join("\n");
  return { content: sliced, isError: false };
}

function writeFile(
  args: Record<string, unknown>,
  workspace: string,
): ToolResult {
  const resolved = checkPath(workspace, String(args.file_path));
  if (!resolved) return pathError();
  const dir = dirname(resolved);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const existed = existsSync(resolved);
  const oldContent = existed ? readFileSync(resolved, "utf-8") : "";
  const newContent = String(args.content);
  writeFileSync(resolved, newContent, "utf-8");

  const oldLines = existed ? oldContent.split("\n") : [];
  const diff = computeDiff(oldLines, newContent.split("\n"));
  if (!diff) {
    // New/overwrite produced no textual change (identical content).
    return {
      content: `Wrote ${displayPath(String(args.file_path))}`,
      isError: false,
    };
  }
  const path = displayPath(String(args.file_path));
  return {
    content: `\`\`\`diff\n--- a/${path}\n+++ b/${path}\n${diff}\n\`\`\``,
    isError: false,
  };
}

function computeDiff(
  oldLines: string[],
  newLines: string[],
  contextLines: number = 3,
): string {
  // Find the first differing line from the top
  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    start++;
  }

  // Find the last differing line from the bottom (relative to start)
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldLines[oldEnd - 1] === newLines[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }

  // Expand context around the differing region
  const ctxStart = Math.max(0, start - contextLines);
  const ctxOldEnd = Math.min(oldLines.length, oldEnd + contextLines);
  const ctxNewEnd = Math.min(newLines.length, newEnd + contextLines);

  const oldHunkLines = oldLines.slice(ctxStart, ctxOldEnd);
  const newHunkLines = newLines.slice(ctxStart, ctxNewEnd);

  const oldHunkLen = ctxOldEnd - ctxStart;
  const newHunkLen = ctxNewEnd - ctxStart;

  if (oldHunkLen === 0 && newHunkLen === 0) return "";

  let diff = `@@ -${ctxStart + 1},${oldHunkLen} +${ctxStart + 1},${newHunkLen} @@`;

  // Build a simple side-by-side diff of the hunk
  interface HunkLine {
    kind: " " | "-" | "+";
    text: string;
  }
  const result: HunkLine[] = [];

  // LCS over the hunk lines to produce minimal +/- output
  const lcsLen: number[][] = Array.from(
    { length: oldHunkLines.length + 1 },
    () => new Array<number>(newHunkLines.length + 1).fill(0),
  );
  for (let i = 1; i <= oldHunkLines.length; i++) {
    for (let j = 1; j <= newHunkLines.length; j++) {
      if (oldHunkLines[i - 1] === newHunkLines[j - 1]) {
        lcsLen[i]![j] = lcsLen[i - 1]![j - 1]! + 1;
      } else {
        lcsLen[i]![j] = Math.max(lcsLen[i - 1]![j]!, lcsLen[i]![j - 1]!);
      }
    }
  }

  // Backtrack to produce diff
  function backtrack(i: number, j: number): void {
    if (i > 0 && j > 0 && oldHunkLines[i - 1] === newHunkLines[j - 1]) {
      backtrack(i - 1, j - 1);
      result.push({ kind: " ", text: oldHunkLines[i - 1]! });
    } else if (j > 0 && (i === 0 || lcsLen[i]![j - 1]! >= lcsLen[i - 1]![j]!)) {
      backtrack(i, j - 1);
      result.push({ kind: "+", text: newHunkLines[j - 1]! });
    } else if (i > 0 && (j === 0 || lcsLen[i]![j - 1]! < lcsLen[i - 1]![j]!)) {
      backtrack(i - 1, j);
      result.push({ kind: "-", text: oldHunkLines[i - 1]! });
    }
  }
  backtrack(oldHunkLines.length, newHunkLines.length);

  for (const line of result) {
    diff += `\n${line.kind}${line.text}`;
  }

  return diff;
}

function editFile(
  args: Record<string, unknown>,
  workspace: string,
): ToolResult {
  const resolved = checkPath(workspace, String(args.file_path));
  if (!resolved) return pathError();
  const content = readFileSync(resolved, "utf-8");
  const oldStr = String(args.old_string);
  const newStr = String(args.new_string);
  const replaceAll = Boolean(args.replace_all);

  if (oldStr === newStr) {
    return {
      content: "Error: new_string must differ from old_string.",
      isError: true,
    };
  }

  const count = content.split(oldStr).length - 1;
  if (count === 0) {
    return { content: "Error: old_string not found in file", isError: true };
  }
  if (!replaceAll && count > 1) {
    return {
      content: `Error: old_string appears ${count} times. Use replace_all=true or provide more context.`,
      isError: true,
    };
  }

  const updated = replaceAll
    ? content.split(oldStr).join(newStr)
    : content.replace(oldStr, newStr);
  writeFileSync(resolved, updated, "utf-8");

  const diff = computeDiff(content.split("\n"), updated.split("\n"));
  return {
    content: `\`\`\`diff\n--- a/${displayPath(String(args.file_path))}\n+++ b/${displayPath(String(args.file_path))}\n${diff}\n\`\`\``,
    isError: false,
  };
}

function runGlob(
  args: Record<string, unknown>,
  workspace: string,
): ToolResult {
  const pattern = String(args.pattern);
  const results: string[] = [];
  scanDir(workspace, pattern, workspace, results);
  return {
    content: results.length ? results.join("\n") : "(no matches)",
    isError: false,
  };
}

function scanDir(
  dir: string,
  pattern: string,
  workspace: string,
  results: string[],
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git" || entry.startsWith("."))
      continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      scanDir(full, pattern, workspace, results);
    } else {
      const rel = full.slice(workspace.length + 1).replaceAll("\\", "/");
      if (simpleMatch(rel, pattern)) {
        results.push(rel);
      }
    }
  }
}

function simpleMatch(str: string, pattern: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${regex}$`).test(str);
}

function runGrep(
  args: Record<string, unknown>,
  workspace: string,
): ToolResult {
  const pattern = String(args.pattern);
  const searchPath = args.path
    ? resolve(workspace, String(args.path))
    : workspace;

  // Access outside the workspace is NOT blocked here — it's gated by an
  // approval prompt upstream (App.tsx), consistent with file tools.

  const regex = new RegExp(pattern, "g");
  const results: string[] = [];
  const ws = resolve(workspace);

  const shortPath = (p: string): string =>
    p.startsWith(ws + sep) ? p.slice(ws.length + 1).replaceAll("\\", "/") : p.replaceAll("\\", "/");

  function search(obj: { path: string }): void {
    let entries: string[];
    try {
      entries = readdirSync(obj.path);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git") continue;
      const full = join(obj.path, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        search({ path: full });
      } else if (stat.isFile()) {
        try {
          const content = readFileSync(full, "utf-8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i]!)) {
              const rel = shortPath(full);
              results.push(`${rel}:${i + 1}: ${lines[i]!.trim()}`);
              if (results.length >= 50) return;
            }
          }
        } catch {
          // binary / unreadable — skip
        }
      }
    }
  }

  if (existsSync(searchPath)) {
    const stat = statSync(searchPath);
    if (stat.isDirectory()) {
      search({ path: searchPath });
    } else {
      const content = readFileSync(searchPath, "utf-8");
      const lines = content.split("\n");
      const rel = shortPath(searchPath);
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i]!)) {
          results.push(`${rel}:${i + 1}: ${lines[i]!.trim()}`);
        }
      }
    }
  }

  return {
    content: results.length ? results.join("\n") : "(no matches)",
    isError: false,
  };
}

export interface BashExecution {
  /** Register a callback for real-time stdout chunks. */
  onOutput(cb: (text: string) => void): void;
  /** Promise that resolves with the final result when the process exits. */
  promise: Promise<ToolResult>;
  /** Kill the running process. */
  abort(): void;
}

export function executeBash(
  args: Record<string, unknown>,
  workspace: string,
): BashExecution {
  const cmd = String(args.command);
  const maxOutput = getMaxBashOutput();
  const timeout = resolveBashTimeout(args.timeout);
  const child = spawn(cmd, [], {
    cwd: workspace,
    shell: process.env.COMSPEC || "bash",
    stdio: ["ignore", "pipe", "pipe"],
    // Unix: detach so the child is in its own process group —
    // killProcessTree sends SIGKILL to that group, not ours.
    // Windows: detached causes cmd.exe to open a new console window, so skip it.
    detached: process.platform !== "win32",
  });

  let stdout = "";
  let stderr = "";
  let killedByOutputLimit = false;
  let timedOut = false;
  let outputCb: ((text: string) => void) | null = null;
  let settled = false;

  // Our own timeout that kills the entire process tree, not just the shell.
  const timeoutId = setTimeout(() => {
    if (settled) return;
    timedOut = true;
    if (child.pid !== undefined) killProcessTree(child.pid);
  }, timeout);

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    if (stdout.length < maxOutput) {
      stdout += text;
      outputCb?.(text);
      // Kill the process once we've read enough — don't let it burn CPU
      // until timeout with output we'll never keep.
      if (stdout.length >= maxOutput) {
        killedByOutputLimit = true;
        if (child.pid !== undefined) killProcessTree(child.pid);
      }
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < maxOutput) {
      stderr += chunk.toString("utf-8");
    }
  });

  const promise = new Promise<ToolResult>((resolve) => {
    const settle = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(result);
    };

    child.on("close", (_code, _signal) => {
      // We killed the process because output exceeded the cap — return a
      // clean truncation message with the partial output we captured.
      if (killedByOutputLimit) {
        settle({
          content: capOutput(stdout, maxOutput),
          isError: false,
          truncated: true,
        });
        return;
      }
      if (timedOut) {
        const cappedOut = capOutput(stdout, maxOutput);
        settle({
          content: `Command timed out after ${timeout}ms. ` +
            `Try narrowing the search path, using a more specific pattern, ` +
            `or pass a longer timeout (max ${getMaxBashTimeoutMs()}ms).` +
            (cappedOut ? `\n\nPartial output:\n${cappedOut}` : ""),
          isError: true,
        });
        return;
      }
      const cappedOut = capOutput(stdout, maxOutput);
      const cappedErr = capOutput(stderr, maxOutput);
      const code = _code ?? 0;
      const content = code !== 0
        ? `Error: exit code ${code}${cappedOut ? `\n${cappedOut}` : ""}${cappedErr ? `\n${cappedErr}` : ""}`
        : (cappedOut || "(no output)");
      settle({ content, isError: code !== 0 });
    });
    child.on("error", (err) => {
      settle({ content: `Error: ${err.message}`, isError: true });
    });
  });

  return {
    onOutput: (cb: (text: string) => void) => {
      outputCb = cb;
    },
    promise,
    abort: () => {
      if (child.pid !== undefined) {
        killProcessTree(child.pid);
      }
    },
  };
}
