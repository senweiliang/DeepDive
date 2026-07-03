/**
 * Memory-directory scanning. Port of Claude Code's `memdir/memoryScan.ts`.
 *
 * Walks the memory directory for topic `.md` files (excluding MEMORY.md), reads
 * each one's frontmatter `description`/`type`, and returns a header list sorted
 * newest-first (capped). Shared by recall (`findRelevantMemories`) and the
 * background extraction agent (which pre-injects the manifest so it doesn't
 * burn a turn on `ls`).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseFrontmatter } from "../skills.js";
import { getMemoryDir, ENTRYPOINT_NAME } from "./paths.js";
import { parseMemoryType, type MemoryType } from "./types.js";

export interface MemoryHeader {
  /** Path relative to the memory directory (e.g. `feedback_testing.md`). */
  filename: string;
  /** Absolute path. */
  filePath: string;
  mtimeMs: number;
  description: string | null;
  type: MemoryType | undefined;
}

const MAX_MEMORY_FILES = 200;

/**
 * Scan `memoryDir` for topic `.md` files and return their headers sorted
 * newest-first (capped at MAX_MEMORY_FILES). Never throws — a missing or
 * unreadable directory yields an empty list.
 */
export function scanMemoryFiles(memoryDir: string = getMemoryDir()): MemoryHeader[] {
  let entries: string[];
  try {
    entries = readdirSync(memoryDir, { recursive: true }) as string[];
  } catch {
    return [];
  }

  const headers: MemoryHeader[] = [];
  for (const rel of entries) {
    const relPath = String(rel).replace(/\\/g, "/");
    if (!relPath.endsWith(".md") || basename(relPath) === ENTRYPOINT_NAME) continue;
    const filePath = join(memoryDir, relPath);
    try {
      const st = statSync(filePath);
      if (!st.isFile()) continue;
      const content = readFileSync(filePath, "utf-8");
      const { frontmatter } = parseFrontmatter(content);
      headers.push({
        filename: relPath,
        filePath,
        mtimeMs: st.mtimeMs,
        description: frontmatter.description || null,
        type: parseMemoryType(frontmatter.type),
      });
    } catch {
      // unreadable file — skip
    }
  }

  return headers
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_MEMORY_FILES);
}

/**
 * Format headers as a text manifest, one line per file:
 *   `- [type] filename (ISO-timestamp): description`
 * Used by both the recall selector prompt and the extraction-agent prompt.
 */
export function formatMemoryManifest(memories: MemoryHeader[]): string {
  return memories
    .map((m) => {
      const tag = m.type ? `[${m.type}] ` : "";
      const ts = new Date(m.mtimeMs).toISOString();
      return m.description
        ? `- ${tag}${m.filename} (${ts}): ${m.description}`
        : `- ${tag}${m.filename} (${ts})`;
    })
    .join("\n");
}
