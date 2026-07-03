/**
 * Auto-memory directory layout. Faithful port of Claude Code's `memdir/paths.ts`
 * (individual-only mode — no team memory, no Cowork/KAIROS overrides).
 *
 * Memory lives under the SAME per-project key the session store uses:
 *   ~/.deepdive/projects/<sanitized-cwd>/memory/
 *     MEMORY.md            — the index (loaded into context every session)
 *     <topic>.md           — one fact per file (frontmatter + body)
 *
 * The directory is pre-created each session (`ensureMemoryDirExists`) so the
 * model can write topic files without first running an `ls`/`mkdir`.
 */

import { mkdirSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import { getOriginalCwd } from "../workspace.js";
import { getProjectDir } from "../session.js";

export const MEMORY_DIRNAME = "memory";
export const ENTRYPOINT_NAME = "MEMORY.md";

/**
 * Whether auto-memory features (system-prompt section, index injection, recall,
 * background extraction) are active this session. Enabled by default; set
 * `DEEPDIVE_DISABLE_AUTO_MEMORY=1` to turn the whole subsystem off.
 */
export function isAutoMemoryEnabled(): boolean {
  const v = process.env.DEEPDIVE_DISABLE_AUTO_MEMORY;
  return !(v === "1" || v === "true");
}

/** The auto-memory directory for the current project (no trailing separator). */
export function getMemoryDir(): string {
  return join(getProjectDir(getOriginalCwd()), MEMORY_DIRNAME);
}

/** `<memoryDir>/MEMORY.md` — the index entrypoint loaded into context. */
export function getMemoryEntrypoint(): string {
  return join(getMemoryDir(), ENTRYPOINT_NAME);
}

/**
 * Ensure the memory directory exists. Idempotent, best-effort — called once per
 * session at prompt-build time so the model can Write to it directly. A real
 * failure (EACCES/EROFS) surfaces later on the model's own Write.
 */
export function ensureMemoryDirExists(): void {
  try {
    mkdirSync(getMemoryDir(), { recursive: true });
  } catch {
    // best-effort; the model's write_file does its own parent mkdir
  }
}

/**
 * Is `absolutePath` inside the auto-memory directory? Used by the permission
 * carve-out (memory writes/reads never prompt) and by the extraction guard
 * (which restricts the forked agent's writes to this directory).
 *
 * Normalizes first so `..` traversal can't slip a non-memory path past the
 * prefix check.
 */
export function isAutoMemPath(absolutePath: string): boolean {
  if (!absolutePath || !isAbsolute(absolutePath)) return false;
  const norm = normalize(absolutePath);
  const dir = normalize(getMemoryDir());
  return norm === dir || norm.startsWith(dir + sep);
}
