import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Message, Usage } from "./types.js";

export interface SessionMeta {
  id: string;
  startedAt: string;
  cwd: string;
  model: string;
  title?: string;
}

export interface SessionSummary {
  id: string;
  startedAt: string;
  cwd: string;
  title: string;
  mtimeMs: number;
  messageCount: number;
}

function sessionsDir(): string {
  return join(homedir(), ".deepdive", "sessions");
}

export function sessionPath(id: string): string {
  return join(sessionsDir(), `${id}.jsonl`);
}

function ensureDir(): void {
  const dir = sessionsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function newSessionId(): string {
  return randomUUID();
}

// Defer the on-disk file until the first message is actually written, so a
// fresh session that's opened and abandoned without sending anything leaves
// no empty jsonl behind (and no stale entry in the session picker).
let pendingMeta: SessionMeta | null = null;

export function createSession(meta: SessionMeta): void {
  pendingMeta = meta;
}

function flushPendingMeta(id: string): void {
  if (!pendingMeta || pendingMeta.id !== id) return;
  ensureDir();
  const line = JSON.stringify({ type: "meta", ...pendingMeta }) + "\n";
  writeFileSync(sessionPath(id), line, "utf-8");
  pendingMeta = null;
}

export function appendMessage(id: string, msg: Message): void {
  try {
    flushPendingMeta(id);
    appendFileSync(
      sessionPath(id),
      JSON.stringify({ type: "msg", ...msg }) + "\n",
      "utf-8",
    );
  } catch {
    // disk write failures shouldn't crash the chat
  }
}

export function appendCompact(
  id: string,
  summary: string,
  recent: Message[],
): void {
  try {
    flushPendingMeta(id);
    appendFileSync(
      sessionPath(id),
      JSON.stringify({
        type: "compact",
        timestamp: new Date().toISOString(),
        summary,
        recent,
      }) + "\n",
      "utf-8",
    );
  } catch {
    // ignore
  }
}

export const COMPACT_SUMMARY_PREFIX = "<previous-conversation-summary>\n";
export const COMPACT_SUMMARY_SUFFIX = "\n</previous-conversation-summary>";

export function makeSummaryMessage(summary: string): Message {
  return {
    role: "user",
    content: COMPACT_SUMMARY_PREFIX + summary + COMPACT_SUMMARY_SUFFIX,
  };
}

// Strip the last message if it's an assistant with tool_calls that has no
// matching tool responses following it (crashed mid-turn). The API rejects
// tool_calls without corresponding tool messages.
function trimDanglingTail(messages: Message[]): Message[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1]!;
  if (last.role === "assistant" && last.tool_calls?.length) {
    return messages.slice(0, -1);
  }
  return messages;
}

// Trim leading messages that would be invalid without their counterpart:
// - bare tool result whose preceding assistant tool_calls is gone
// - assistant with tool_calls whose tool results are not all present in the kept slice
function trimDanglingHead(messages: Message[]): Message[] {
  let safe = messages;
  while (safe.length > 0) {
    const first = safe[0]!;
    if (first.role === "tool") {
      safe = safe.slice(1);
      continue;
    }
    if (first.role === "assistant" && first.tool_calls?.length) {
      const expected = new Set(first.tool_calls.map((t) => t.id));
      const found = new Set<string>();
      for (let i = 1; i < safe.length; i++) {
        const m = safe[i]!;
        if (m.role !== "tool") break;
        if (m.tool_call_id && expected.has(m.tool_call_id)) {
          found.add(m.tool_call_id);
        }
      }
      if (found.size === expected.size) break;
      safe = safe.slice(1);
      continue;
    }
    break;
  }
  return safe;
}

// The summary user message is the only marker — UI renders the boundary
// (divider + label) when it spots a message starting with this prefix;
// the API client slices from the last summary forward.
export function isCompactSummaryMessage(msg: Message): boolean {
  return (
    msg.role === "user" && !!msg.content?.startsWith(COMPACT_SUMMARY_PREFIX)
  );
}

// Kept for potential future use (part-compact mode where recent != []).
// Currently unused — compactHistory now appends the summary to the existing
// messages array rather than replacing it.
export function buildCompactedMessages(
  summary: string,
  recent: Message[],
): Message[] {
  return [makeSummaryMessage(summary), ...trimDanglingHead(recent)];
}

export function loadSession(
  id: string,
): {
  meta: SessionMeta | null;
  messages: Message[];
  usage: Usage | null;
} | null {
  const path = sessionPath(id);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  let meta: SessionMeta | null = null;
  let usage: Usage | null = null;
  const messages: Message[] = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as { type?: string } & Record<string, unknown>;
      if (obj.type === "meta") {
        const { type: _t, ...rest } = obj;
        meta = rest as unknown as SessionMeta;
      } else if (obj.type === "msg") {
        const { type: _t, ...rest } = obj;
        const msg = rest as unknown as Message;
        // Usage rides on the assistant message (no separate line). Track the
        // most recent one so the footer restores running totals on resume.
        if (msg.usage) usage = msg.usage;
        messages.push(msg);
      } else if (obj.type === "compact") {
        // Append the summary marker without dropping raw history; the raw
        // remains visible in the transcript, and the API client slices from
        // the last summary forward when constructing the request body.
        const summary = String(obj.summary ?? "");
        messages.push(makeSummaryMessage(summary));
      }
    } catch {
      // skip malformed line
    }
  }
  // Strip any dangling assistant tool_calls that were persisted before a
  // crash / Ctrl-C exit — without their tool-result responses the API will
  // reject the request with a 400.
  return {
    meta,
    messages: trimDanglingTail(trimDanglingHead(messages)),
    usage,
  };
}

export function listSessions(limit = 50): SessionSummary[] {
  ensureDir();
  const dir = sessionsDir();
  const entries: SessionSummary[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return entries;
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const id = name.slice(0, -".jsonl".length);
    const full = join(dir, name);
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(full).mtimeMs;
    } catch {
      continue;
    }
    const loaded = loadSession(id);
    if (!loaded) continue;
    const firstUser = loaded.messages.find(
      (m) => m.role === "user" && !m.meta,
    );
    const title =
      loaded.meta?.title || firstUser?.content?.slice(0, 80) || "(empty)";
    entries.push({
      id,
      startedAt: loaded.meta?.startedAt || "",
      cwd: loaded.meta?.cwd || "",
      title: title.replace(/\s+/g, " ").trim() || "(empty)",
      mtimeMs,
      messageCount: loaded.messages.length,
    });
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries.slice(0, limit);
}

export function lastSessionId(): string | null {
  const list = listSessions(1);
  return list[0]?.id ?? null;
}
