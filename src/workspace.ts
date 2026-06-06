/**
 * Frozen original working directory captured at session start.
 *
 * Like Claude Code's `getOriginalCwd()`, this value is a snapshot of
 * `process.cwd()` taken once in `cli.tsx` and never changes for the
 * lifetime of the session. All file tools, bash, and permission checks
 * resolve paths against this directory — not against the live `process.cwd()`
 * which can drift if the user or a script `cd`s mid-session.
 */

import { homedir } from "node:os";
import { join } from "node:path";

let _originalCwd = "";

/** Freeze the working directory at session start. Idempotent after the first call. */
export function setOriginalCwd(cwd: string): void {
  if (!_originalCwd) _originalCwd = cwd;
}

/** The working directory frozen at session start. */
export function getOriginalCwd(): string {
  if (!_originalCwd) {
    // Fallback: if setOriginalCwd was never called (tests, etc.), use the
    // live cwd so existing test suites don't break.
    return process.cwd();
  }
  return _originalCwd;
}

/**
 * Expand a leading `~` to the user's home directory, the way a shell does.
 * Node's `path.resolve` does NOT do this — it would treat `~` as a literal
 * directory name. Only the current-user form is handled (`~` and `~/...`);
 * `~otheruser` is left untouched.
 */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}
