/**
 * Query-time memory recall. Port of Claude Code's `memdir/findRelevantMemories.ts`.
 *
 * Before a user turn, scan topic-file headers and ask a fast model to pick the
 * few that are clearly relevant to the query, then inject their contents as a
 * `<system-reminder>` so the main model has them without spending a turn on
 * grep. MEMORY.md (the index) is already in the system prompt, so it's excluded.
 */

import { readFileSync } from "node:fs";
import type { Config } from "../config.js";
import type { Message } from "../types.js";
import { info } from "../log.js";
import { getMemoryDir, isAutoMemoryEnabled } from "./paths.js";
import {
  formatMemoryManifest,
  scanMemoryFiles,
  type MemoryHeader,
} from "./scan.js";

const RECALL_MARKER = "<deepdive-memory-recall>";
/** Per-file content cap so a huge topic file can't blow up the turn. */
const MAX_RECALL_FILE_BYTES = 4_000;

export interface RelevantMemory {
  path: string;
  mtimeMs: number;
}

const SELECT_SYSTEM_PROMPT = `You are selecting memories that will be useful to a coding agent as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return the filenames of the memories that will clearly be useful (up to 5). Only include memories you are certain will help based on their name and description.
- If you are unsure whether a memory will be useful, do not include it. Be selective.
- If none would clearly help, return an empty list.
- If a list of recently-used tools is provided, do not select memories that are usage reference or API docs for those tools. DO still select memories with warnings, gotchas, or known issues about those tools.

Output ONLY a JSON object: {"selected_memories": ["file1.md", "file2.md"]}`;

/**
 * Find topic files relevant to `query` (up to 5). Best-effort — any error or an
 * empty memory dir yields `[]`. `alreadySurfaced` drops files injected in prior
 * turns so the selector spends its budget on fresh candidates.
 */
export async function findRelevantMemories(
  config: Config,
  query: string,
  recentTools: readonly string[] = [],
  alreadySurfaced: ReadonlySet<string> = new Set(),
): Promise<RelevantMemory[]> {
  if (!isAutoMemoryEnabled() || !query.trim()) return [];
  const memories = scanMemoryFiles(getMemoryDir()).filter(
    (m) => !alreadySurfaced.has(m.filePath),
  );
  if (memories.length === 0) return [];

  const selectedNames = await selectRelevantMemories(config, query, memories, recentTools);
  const byName = new Map(memories.map((m) => [m.filename, m]));
  return selectedNames
    .map((n) => byName.get(n))
    .filter((m): m is MemoryHeader => m !== undefined)
    .map((m) => ({ path: m.filePath, mtimeMs: m.mtimeMs }));
}

async function selectRelevantMemories(
  config: Config,
  query: string,
  memories: MemoryHeader[],
  recentTools: readonly string[],
): Promise<string[]> {
  const valid = new Set(memories.map((m) => m.filename));
  const manifest = formatMemoryManifest(memories);
  const toolsSection =
    recentTools.length > 0 ? `\n\nRecently used tools: ${recentTools.join(", ")}` : "";

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        messages: [
          { role: "system", content: SELECT_SYSTEM_PROMPT },
          {
            role: "user",
            content: `Query: ${query}\n\nAvailable memories:\n${manifest}${toolsSection}`,
          },
        ],
        max_tokens: 256,
        temperature: 0,
        stream: false,
        thinking: { type: "disabled" },
        response_format: { type: "json_object" },
      }),
    });
    if (!response.ok) return [];
    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    return parseSelected(text, valid);
  } catch (err) {
    info("memory", `recall selection failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** Parse `{"selected_memories":[...]}`; fall back to any known filename in the text. */
function parseSelected(text: string, valid: Set<string>): string[] {
  try {
    const parsed = JSON.parse(text) as { selected_memories?: unknown };
    if (Array.isArray(parsed.selected_memories)) {
      return parsed.selected_memories
        .filter((f): f is string => typeof f === "string" && valid.has(f));
    }
  } catch {
    // not clean JSON — fall through
  }
  return [...valid].filter((name) => text.includes(name));
}

/**
 * Build a `<system-reminder>` meta message injecting the recalled memories'
 * contents, or `null` if none. The message is marked `meta` so it's stripped
 * from persistence-only fields but still sent to the model.
 */
export function makeRecallMessage(memories: RelevantMemory[]): Message | null {
  if (memories.length === 0) return null;
  const blocks: string[] = [];
  for (const m of memories) {
    let content: string;
    try {
      content = readFileSync(m.path, "utf-8");
    } catch {
      continue;
    }
    if (Buffer.byteLength(content, "utf-8") > MAX_RECALL_FILE_BYTES) {
      content = content.slice(0, MAX_RECALL_FILE_BYTES) + "\n… (truncated)";
    }
    const name = m.path.split(/[/\\]/).pop() ?? m.path;
    blocks.push(`## ${name}\n${content.trim()}`);
  }
  if (blocks.length === 0) return null;

  return {
    role: "user",
    meta: true,
    content:
      `<system-reminder>\n${RECALL_MARKER}\n` +
      "The following memories from past sessions may be relevant to this request. " +
      "They reflect what was true when written — verify against current state before relying on them.\n\n" +
      blocks.join("\n\n") +
      `\n</deepdive-memory-recall>\n</system-reminder>`,
  };
}

export function isMemoryRecallMessage(message: Message): boolean {
  return message.role === "user" && !!message.meta && message.content.includes(RECALL_MARKER);
}

/**
 * How many memories a recall message injected — counts the `## <file>` block
 * headers. Used by the transcript to render "Recalled N memories".
 */
export function memoryRecallCount(content: string): number {
  return (content.match(/^## /gm) ?? []).length;
}
