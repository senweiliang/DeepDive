/**
 * The `# Memory` system-prompt section. Port of Claude Code's
 * `memdir/memdir.ts` builders (`buildMemoryLines` + `truncateEntrypointContent`),
 * collapsed to the individual-only path.
 *
 * DeepDive appends the WHOLE section (behavioral instructions + the current
 * MEMORY.md index content) to the system message, frozen at session start like
 * the project-instructions block — so the index rides the stable prefix-cache
 * region. New memories written mid-session appear in the next session's prompt.
 */

import { readFileSync } from "node:fs";
import {
  ensureMemoryDirExists,
  getMemoryDir,
  getMemoryEntrypoint,
  isAutoMemoryEnabled,
  ENTRYPOINT_NAME,
} from "./paths.js";
import { getProjectDir } from "../session.js";
import { getOriginalCwd } from "../workspace.js";
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  TRUSTING_RECALL_SECTION,
  TYPES_SECTION,
  WHAT_NOT_TO_SAVE_SECTION,
  WHEN_TO_ACCESS_SECTION,
} from "./types.js";

export const MAX_ENTRYPOINT_LINES = 200;
export const MAX_ENTRYPOINT_BYTES = 25_000;

export interface EntrypointTruncation {
  content: string;
  lineCount: number;
  byteCount: number;
  wasLineTruncated: boolean;
  wasByteTruncated: boolean;
}

/**
 * Truncate MEMORY.md content to the line AND byte caps, appending a warning that
 * names which cap fired. Line-truncates first (natural boundary), then
 * byte-truncates at the last newline before the cap so we never cut mid-line.
 */
export function truncateEntrypointContent(raw: string): EntrypointTruncation {
  const trimmed = raw.trim();
  const lines = trimmed.split("\n");
  const lineCount = lines.length;
  const byteCount = Buffer.byteLength(trimmed, "utf-8");

  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES;
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES;

  if (!wasLineTruncated && !wasByteTruncated) {
    return { content: trimmed, lineCount, byteCount, wasLineTruncated, wasByteTruncated };
  }

  let truncated = wasLineTruncated
    ? lines.slice(0, MAX_ENTRYPOINT_LINES).join("\n")
    : trimmed;
  if (Buffer.byteLength(truncated, "utf-8") > MAX_ENTRYPOINT_BYTES) {
    const cutAt = truncated.lastIndexOf("\n", MAX_ENTRYPOINT_BYTES);
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES);
  }

  const reason =
    wasByteTruncated && !wasLineTruncated
      ? `${byteCount} bytes (limit: ${MAX_ENTRYPOINT_BYTES}) — index entries are too long`
      : wasLineTruncated && !wasByteTruncated
        ? `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
        : `${lineCount} lines and ${byteCount} bytes`;

  return {
    content:
      truncated +
      `\n\n> WARNING: ${ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded. ` +
      `Keep index entries to one line under ~150 chars; move detail into topic files.`,
    lineCount,
    byteCount,
    wasLineTruncated,
    wasByteTruncated,
  };
}

const DIR_EXISTS_GUIDANCE =
  "This directory already exists — write to it directly with the write_file tool (do not run mkdir or check for its existence).";

/** The behavioral instructions (taxonomy, how/when to save & access). */
function buildMemoryLines(memoryDir: string): string[] {
  const howToSave = [
    "## How to save memories",
    "",
    "Saving a memory is a two-step process:",
    "",
    "**Step 1** — write the memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:",
    "",
    ...MEMORY_FRONTMATTER_EXAMPLE,
    "",
    `**Step 2** — add a pointer to that file in \`${ENTRYPOINT_NAME}\`. \`${ENTRYPOINT_NAME}\` is an index, not a memory — each entry should be one line, under ~150 characters: \`- [Title](file.md) — one-line hook\`. It has no frontmatter. Never write memory content directly into \`${ENTRYPOINT_NAME}\`.`,
    "",
    `- \`${ENTRYPOINT_NAME}\` is always loaded into your context — lines after ${MAX_ENTRYPOINT_LINES} are truncated, so keep the index concise`,
    "- Keep the name, description, and type fields in memory files up-to-date with the content",
    "- Organize memory semantically by topic, not chronologically",
    "- Update or remove memories that turn out to be wrong or outdated",
    "- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.",
  ];

  return [
    "# Memory",
    "",
    `You have a persistent, file-based memory system at \`${memoryDir}\`. ${DIR_EXISTS_GUIDANCE}`,
    "",
    "You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.",
    "",
    "If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.",
    "",
    ...TYPES_SECTION,
    ...WHAT_NOT_TO_SAVE_SECTION,
    "",
    ...howToSave,
    "",
    ...WHEN_TO_ACCESS_SECTION,
    "",
    ...TRUSTING_RECALL_SECTION,
    "",
    "## Memory and other forms of persistence",
    "Memory persists across conversations. Do not use it for information that is only useful within the current conversation — reserve that for the current task, plans, or scratch files. Memory is for what future sessions need to know.",
    "",
    ...buildSearchingPastContextSection(memoryDir),
  ];
}

/** `## Searching past context` — how to grep topic files and past transcripts. */
function buildSearchingPastContextSection(memoryDir: string): string[] {
  const projectDir = getProjectDir(getOriginalCwd());
  return [
    "## Searching past context",
    "",
    "When looking for past context:",
    `1. Search topic files in your memory directory: grep with pattern="<search term>" path="${memoryDir}"`,
    `2. Session transcript logs (last resort — large files): grep with pattern="<search term>" path="${projectDir}"`,
    "Use narrow search terms (error messages, file paths, function names) rather than broad keywords.",
    "",
  ];
}

/**
 * Build the full memory system-prompt section: behavioral instructions plus the
 * current MEMORY.md index content. Returns `""` when auto-memory is disabled.
 * Pre-creates the memory directory so the model can Write without an `ls`/`mkdir`.
 *
 * FROZEN at first call (like `sessionLanguage`): a memory written mid-session
 * must NOT mutate the system prompt, or the DeepSeek prefix cache would
 * invalidate every request after a save. New memories surface in the next
 * session's prompt; within a session, recall handles per-turn relevance.
 */
let _memorySection: string | undefined;

export function buildMemorySection(): string {
  if (_memorySection === undefined) _memorySection = buildMemorySectionUncached();
  return _memorySection;
}

function buildMemorySectionUncached(): string {
  if (!isAutoMemoryEnabled()) return "";

  ensureMemoryDirExists();
  const memoryDir = getMemoryDir();
  const lines = buildMemoryLines(memoryDir);

  let entrypoint = "";
  try {
    entrypoint = readFileSync(getMemoryEntrypoint(), "utf-8");
  } catch {
    // no MEMORY.md yet
  }

  if (entrypoint.trim()) {
    const t = truncateEntrypointContent(entrypoint);
    lines.push(`## ${ENTRYPOINT_NAME}`, "", t.content);
  } else {
    lines.push(
      `## ${ENTRYPOINT_NAME}`,
      "",
      `Your ${ENTRYPOINT_NAME} is currently empty. When you save new memories, they will appear here.`,
    );
  }

  return "\n" + lines.join("\n") + "\n";
}
