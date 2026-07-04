/**
 * Background memory extraction. Port of Claude Code's
 * `services/extractMemories/extractMemories.ts` (+ its prompts.ts), collapsed to
 * the individual-only path and DeepDive's headless-agent loop.
 *
 * Runs once at the end of a query loop (final assistant message, no tool calls).
 * A forked agent re-reads the recent conversation and writes durable memories to
 * topic files. It is a best-effort catch net: when the MAIN agent already wrote
 * to memory this turn (`hasMemoryWritesSince`), extraction is skipped — the two
 * are mutually exclusive per turn.
 *
 * The fork's tools are scoped to read/search + writes INSIDE the memory dir only
 * (`gateExtractionTool`); everything else is denied.
 */

import { basename } from "node:path";
import type { Config } from "../config.js";
import type { Message } from "../types.js";
import { streamTurn } from "../turn.js";
import { execute, executeBash } from "../tools/executor.js";
import { isReadOnlyCommand } from "../tools/permissions.js";
import { ALL_TOOLS } from "../tools/schema.js";
import { info } from "../log.js";
import { getOriginalCwd } from "../workspace.js";
import { getMemoryDir, isAutoMemoryEnabled, isAutoMemPath, ENTRYPOINT_NAME } from "./paths.js";
import { formatMemoryManifest, scanMemoryFiles } from "./scan.js";
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  TYPES_SECTION,
  WHAT_NOT_TO_SAVE_SECTION,
} from "./types.js";

/** Well-behaved extractions finish in 2-4 turns (read → write); cap the rest. */
const MAX_EXTRACTION_TURNS = 5;

/** The scoped tool set the fork sees — read/search + memory-dir writes. */
const EXTRACTION_TOOL_NAMES = new Set([
  "read_file",
  "grep",
  "glob",
  "bash",
  "write_file",
  "edit_file",
]);

export interface ExtractionResult {
  /** Topic files written this run (excludes MEMORY.md index touches). */
  writtenPaths: string[];
  turns: number;
  /** Skipped because the main agent already wrote memory this turn. */
  skipped: boolean;
}

/**
 * Did any assistant message write to a memory-dir path? If so, the main agent
 * already saved this turn and the fork is redundant.
 */
export function hasMemoryWritesSince(messages: Message[]): boolean {
  for (const m of messages) {
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      if (tc.function.name !== "write_file" && tc.function.name !== "edit_file") continue;
      try {
        const args = JSON.parse(tc.function.arguments || "{}") as { file_path?: unknown };
        if (typeof args.file_path === "string" && isAutoMemPath(args.file_path)) return true;
      } catch {
        // unparseable args — ignore
      }
    }
  }
  return false;
}

/** Build the extraction user prompt (individual mode). */
function buildExtractPrompt(newMessageCount: number, existingManifest: string): string {
  const manifest =
    existingManifest.length > 0
      ? `\n\n## Existing memory files\n\n${existingManifest}\n\nCheck this list before writing — update an existing file rather than creating a duplicate.`
      : "";

  const opener = [
    `You are now acting as the memory extraction subagent. Analyze the most recent ~${newMessageCount} messages above and use them to update your persistent memory system.`,
    "",
    "Available tools: read_file, grep, glob, read-only bash (ls/find/cat/stat/wc/head/tail and similar), and write_file/edit_file for paths inside the memory directory only. All other tools are denied.",
    "",
    "You have a limited turn budget. The efficient strategy is: read every file you might update in parallel first, then issue all write_file/edit_file calls. Do not interleave reads and writes across many turns.",
    `You MUST only use content from the last ~${newMessageCount} messages to update your memories. Do not investigate or verify further — no grepping source files, no reading code to confirm a pattern, no git commands.`,
    "",
    "⚠ Be conservative. Only save information that is clearly about the user, their preferences, project context, or external resource pointers. Do NOT save technical discoveries, API behavior findings, debugging conclusions, or anything you learned about how the tools/frameworks work — those belong in project docs or code comments, not in memory. If in doubt, skip it." +
      manifest,
  ].join("\n");

  const howToSave = [
    "## How to save memories",
    "",
    "Saving a memory is a two-step process:",
    "",
    "**Step 1** — write the memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:",
    "",
    ...MEMORY_FRONTMATTER_EXAMPLE,
    "",
    `**Step 2** — add a pointer to that file in \`${ENTRYPOINT_NAME}\`. It is an index, not a memory — one line per entry, under ~150 characters: \`- [Title](file.md) — one-line hook\`. No frontmatter. Never write memory content directly into \`${ENTRYPOINT_NAME}\`.`,
    "",
    "- Organize memory semantically by topic, not chronologically",
    "- Update or remove memories that turn out to be wrong or outdated",
    "- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.",
  ];

  return [
    opener,
    "",
    "If the user explicitly asked you to remember something, save it immediately as whichever type fits best. If they asked you to forget something, find and remove the relevant entry.",
    "",
    ...TYPES_SECTION,
    ...WHAT_NOT_TO_SAVE_SECTION,
    "",
    ...howToSave,
  ].join("\n");
}

/** The fork's per-tool gate: read/search unrestricted, writes memory-dir-only. */
function gateExtractionTool(name: string, args: Record<string, unknown>): boolean {
  if (name === "read_file" || name === "grep" || name === "glob") return true;
  if (name === "bash") return isReadOnlyCommand(String(args.command ?? ""));
  if (name === "write_file" || name === "edit_file") {
    return typeof args.file_path === "string" && isAutoMemPath(args.file_path);
  }
  return false;
}

async function execExtractionTool(
  name: string,
  args: Record<string, unknown>,
  config: Config,
  workspace: string,
  signal: AbortSignal,
): Promise<string> {
  if (name === "bash") {
    const exec = executeBash(args, workspace);
    const onAbort = () => exec.abort();
    signal.addEventListener("abort", onAbort);
    try {
      return (await exec.promise).content;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
  return (await execute(name, args, workspace)).content;
}

/**
 * Run one memory-extraction pass over `conversation` (the model-visible history
 * of the turn that just finished). Best-effort — errors are swallowed. Returns
 * the topic files written (excluding the MEMORY.md index).
 */
export async function runMemoryExtraction(
  config: Config,
  conversation: Message[],
  newMessageCount: number,
  signal: AbortSignal,
): Promise<ExtractionResult> {
  if (!isAutoMemoryEnabled()) return { writtenPaths: [], turns: 0, skipped: true };

  // Mutual exclusion: the main agent already wrote memory this turn.
  if (hasMemoryWritesSince(conversation)) {
    info("memory", "extraction skipped — conversation already wrote to memory");
    return { writtenPaths: [], turns: 0, skipped: true };
  }

  const memoryDir = getMemoryDir();
  const manifest = formatMemoryManifest(scanMemoryFiles(memoryDir));
  const prompt = buildExtractPrompt(newMessageCount, manifest);
  const tools = ALL_TOOLS.filter((t) => EXTRACTION_TOOL_NAMES.has(t.function.name));

  // Fork: the recent conversation + the extraction instruction as the last turn.
  let history: Message[] = [...conversation, { role: "user", content: prompt }];
  const written = new Set<string>();
  let turn = 0;

  try {
    while (turn < MAX_EXTRACTION_TURNS) {
      if (signal.aborted) break;
      turn++;
      const res = await streamTurn(config, history, signal, { tools });
      history = [...history, res.assistant];
      if (res.interrupted) break;

      const calls = res.assistant.tool_calls;
      if (!calls || calls.length === 0 || res.finish_reason !== "tool_calls") break;

      const results: Message[] = [];
      for (const tc of calls) {
        if (signal.aborted) {
          results.push({ role: "tool", tool_call_id: tc.id, content: "Aborted." });
          continue;
        }
        const name = tc.function.name;
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          args = {};
        }
        let content: string;
        if (!gateExtractionTool(name, args)) {
          content = `Error: tool "${name}" is not permitted during memory extraction.`;
        } else {
          try {
            content = await execExtractionTool(name, args, config, getOriginalCwd(), signal);
            if ((name === "write_file" || name === "edit_file") && typeof args.file_path === "string") {
              written.add(args.file_path);
            }
          } catch (err) {
            content = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
        results.push({ role: "tool", tool_call_id: tc.id, content });
      }
      history = [...history, ...results];
    }
  } catch (err) {
    info("memory", `extraction error: ${err instanceof Error ? err.message : String(err)}`);
  }

  const writtenPaths = [...written].filter((p) => basename(p) !== ENTRYPOINT_NAME);
  info("memory", `extraction done turns=${turn} files=${writtenPaths.length}`);
  return { writtenPaths, turns: turn, skipped: false };
}
