import type { Message, StreamChunk, ToolCallDelta, Usage } from "./types.js";
import type { Config } from "./config.js";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { ALL_TOOLS } from "./tools/schema.js";
import { RESPONSE_LANGUAGES } from "./config.js";
import { isCompactSummaryMessage } from "./session.js";
import { info } from "./log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = readFileSync(join(__dirname, "prompts", "base.md"), "utf-8");
const COMPACT_INSTRUCTION = readFileSync(
  join(__dirname, "prompts", "compact.md"),
  "utf-8",
);
export { COMPACT_INSTRUCTION };

/**
 * Local-calendar date as YYYY-MM-DD, built from local-time components instead
 * of `toISOString()` (which is UTC — a UTC+8 user before 08:00 would see
 * yesterday). `DEEPDIVE_OVERRIDE_DATE` forces a value for tests / repro runs.
 */
function localDate(): string {
  const override = process.env.DEEPDIVE_OVERRIDE_DATE;
  if (override) return override;
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Date context as a transient trailing user message — deliberately kept OUT of
 * the system prompt. The system prompt is the head of DeepSeek's prefix-cache
 * key.
 *
 * Faithful port of Claude Code's `getUserContext` memoize + `date_change`
 * attachment split:
 *
 *  - The system prompt carries the date FROZEN at session start
 *    (`sessionDate()` — computed once, never refreshed). Because it never
 *    changes mid-session the systemMessage stays byte-identical, so the
 *    DeepSeek prefix cache (system + every history turn) never invalidates.
 *  - When the wall clock crosses midnight the prefix is deliberately left
 *    stale; instead `dateChangeMessage()` emits a one-off correction that the
 *    caller splices into (and persists in) history. Later turns then read the
 *    new date from the now-stable cached prefix — no per-turn re-emission, no
 *    cache miss (Claude Code's exact tradeoff).
 */
let _sessionDate: string | undefined;
let _lastEmittedDate: string | undefined;

/** Date frozen at first call (≈ session start); used in the cached prefix. */
function sessionDate(): string {
  if (_sessionDate === undefined) {
    _sessionDate = localDate();
    _lastEmittedDate = _sessionDate;
  }
  return _sessionDate;
}

/**
 * One-off "the date changed" reminder for the caller to append to history
 * (which persists it via the session). Returns null while the local date
 * still matches the last emitted one — so it fires at most once per rollover.
 */
export function dateChangeMessage(): Message | null {
  sessionDate(); // ensure _lastEmittedDate is initialised
  const now = localDate();
  if (now === _lastEmittedDate) return null;
  _lastEmittedDate = now;
  return {
    role: "user",
    meta: true,
    content:
      `<system-reminder>\nThe date has changed. Today's date is now ${now}. ` +
      `Do not mention this to the user explicitly — they already know.\n</system-reminder>`,
  };
}

function envInfo(): string {
  return [
    "",
    "## Environment",
    "",
    `- Today's date: ${sessionDate()}`,
    `- Working directory: ${process.cwd()}`,
    `- Platform: ${process.platform}`,
    `- DeepDive home directory: ${join(homedir(), ".deepdive")}`,
    "",
    "File tools (`read_file`, `write_file`, `edit_file`) accept absolute paths, or paths relative to the working directory above. Paths outside the working directory are allowed but the user is asked to confirm each one, so prefer in-workspace paths unless the task clearly needs an outside file.",
    "",
    "DeepDive stores its own data (settings, sessions, etc.) under the DeepDive home directory above.",
    "",
  ].join("\n");
}

/**
 * Response-language constraint as a system-prompt section — the exact
 * mechanism Claude Code uses (`getLanguageSection`): a fixed template with the
 * configured language interpolated in, emitted only when a language is set
 * (`auto` ⇒ nothing, mirrors the user). Wording is taken verbatim from the
 * source.
 *
 * The value is FROZEN at session start (`sessionLanguage()` memoize, same as
 * `sessionDate()`): changing the language in /settings is persisted but does
 * NOT mutate a running session's system prompt, so the DeepSeek prefix cache
 * never invalidates mid-conversation. Like Claude Code, the new language only
 * takes effect in a fresh session.
 */
let _sessionLang: string | undefined;

function sessionLanguage(config: Config): string {
  if (_sessionLang === undefined) _sessionLang = config.responseLanguage;
  return _sessionLang;
}

function languageInstruction(config: Config): string {
  const lang = RESPONSE_LANGUAGES.find(
    (l) => l.value === sessionLanguage(config),
  );
  if (!lang || lang.value === "auto") return "";
  return [
    "",
    "# Language",
    `Always respond in ${lang.label}. Use ${lang.label} for all explanations, comments, and communications with the user. Technical terms and code identifiers should remain in their original form.`,
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

// Slice from the LAST compact summary forward, so raw history before the most
// recent compaction never gets resent to the API. The summary itself is the
// first message of the resulting slice.
function sliceFromLastSummary(messages: Message[]): Message[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isCompactSummaryMessage(messages[i]!)) return messages.slice(i);
  }
  return messages;
}

function stripNonApiFields(messages: Message[]): Message[] {
  // DeepSeek V4 reasoning rule:
  //   Only the assistant message that performed tool_calls needs its
  //   reasoning_content passed back in all subsequent requests —
  //   the model needs the chain-of-thought behind the tool choice.
  //   Messages without tool_calls can have reasoning_content stripped.
  // `usage`, `interrupted` and `meta` are UI/persistence-only metadata that
  // ride on the message; always drop them before sending to the model (the
  // meta message's role+content still goes through — only the flag is cut).
  return messages.map((m) => {
    const { usage: _u, interrupted: _i, meta: _m, ...m2 } = m;
    if (m2.reasoning_content === undefined) return m2;
    const keep =
      m2.role === "assistant" && m2.tool_calls && m2.tool_calls.length > 0;
    if (keep) return m2;
    const { reasoning_content: _r, ...rest } = m2;
    return rest;
  });
}

function buildBody(config: Config, messages: Message[]): string {
  const systemMessage = {
    role: "system",
    content:
      SYSTEM_PROMPT +
      envInfo() +
      languageInstruction(config) +
      projectInstructions(),
  };
  // DeepSeek: thinking on/off is the `thinking` param, NOT a reasoning_effort
  // value. reasoning_effort only accepts the gradable tiers (high/max). Our
  // "none" tier means non-thinking mode → send thinking.disabled and omit
  // reasoning_effort (sending "none" there is a 400 unknown variant).
  const thinkingOff = config.reasoningEffort === "none";
  return JSON.stringify({
    model: config.model,
    messages: [
      systemMessage,
      ...stripNonApiFields(sliceFromLastSummary(messages)),
    ],
    max_tokens: config.maxTokens,
    ...(thinkingOff
      ? { thinking: { type: "disabled" } }
      : { reasoning_effort: config.reasoningEffort }),
    tools: ALL_TOOLS,
    stream: true,
  });
}

export async function summarize(
  config: Config,
  messages: Message[],
  signal?: AbortSignal,
): Promise<string> {
  const body = JSON.stringify({
    model: config.model,
    messages: stripNonApiFields(sliceFromLastSummary(messages)),
    max_tokens: 4000,
    reasoning_effort: "low",
    stream: false,
  });
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body,
    ...(signal ? { signal } : {}),
  } as RequestInit);
  if (!response.ok) {
    throw new Error(`Summarize API error ${response.status}: ${await response.text()}`);
  }
  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return json.choices?.[0]?.message?.content || "";
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
