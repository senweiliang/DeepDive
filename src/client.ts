import type { Message, StreamChunk, ToolCallDelta, Usage } from "./types.js";
import type { Config } from "./config.js";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_TOOLS } from "./tools/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = readFileSync(join(__dirname, "prompts", "base.md"), "utf-8");

function envInfo(): string {
  return [
    "",
    "## Environment",
    "",
    `- Working directory: ${process.cwd()}`,
    `- Platform: ${process.platform}`,
    "",
    "File tools (`read_file`, `write_file`, `edit_file`) require `file_path` to be an absolute path inside the working directory above. Prepend the working directory to any relative path the user mentions.",
    "",
  ].join("\n");
}

function projectInstructions(): string {
  for (const name of ["AGENTS.md", "DEEPDIVE.md", "CLAUDE.md"]) {
    const p = join(process.cwd(), name);
    if (!existsSync(p)) continue;
    try {
      const content = readFileSync(p, "utf-8").trim();
      if (!content) continue;
      return `\n## Project Instructions (${name})\n\n${content}\n`;
    } catch {
      // unreadable, try the next candidate
    }
  }
  return "";
}

function stripReasoning(messages: Message[]): Message[] {
  // DeepSeek's multi-turn guidance: do not echo reasoning_content back —
  // it's a per-turn artifact, not part of the dialogue history.
  return messages.map((m) => {
    if (m.reasoning_content === undefined) return m;
    const { reasoning_content: _r, ...rest } = m;
    return rest;
  });
}

function buildBody(config: Config, messages: Message[]): string {
  const systemMessage = {
    role: "system",
    content: SYSTEM_PROMPT + envInfo() + projectInstructions(),
  };
  return JSON.stringify({
    model: config.model,
    messages: [systemMessage, ...stripReasoning(messages)],
    max_tokens: config.maxTokens,
    reasoning_effort: config.reasoningEffort,
    tools: ALL_TOOLS,
    stream: true,
  });
}

export async function* chat(
  config: Config,
  messages: Message[],
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const body = buildBody(config, messages);
  const url = `${config.baseUrl}/chat/completions`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body,
    ...(signal ? { signal } : {}),
  } as RequestInit);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;

        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;

          const chunk: StreamChunk = {
            content: delta.content || "",
            reasoning_content: delta.reasoning_content || "",
            tool_calls: parseToolCallDeltas(delta.tool_calls),
            finish_reason: parsed.choices?.[0]?.finish_reason || null,
            usage: parseUsage(parsed.usage),
          };
          yield chunk;
        } catch {
          // malformed SSE line, ignore
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseToolCallDeltas(raw: unknown): ToolCallDelta[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((tc: Record<string, unknown>) => ({
    index: (tc.index as number) || 0,
    id: tc.id as string | undefined,
    function: tc.function as
      | { name?: string; arguments?: string }
      | undefined,
  }));
}

function parseUsage(raw: unknown): Usage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  return {
    input_tokens:
      (u.prompt_tokens as number) || (u.input_tokens as number) || 0,
    output_tokens:
      (u.completion_tokens as number) || (u.output_tokens as number) || 0,
    prompt_cache_hit_tokens: u.prompt_cache_hit_tokens as number | undefined,
    prompt_cache_miss_tokens: u.prompt_cache_miss_tokens as number | undefined,
    reasoning_tokens: (
      u.completion_tokens_details as Record<string, unknown>
    )?.reasoning_tokens as number | undefined,
  };
}
