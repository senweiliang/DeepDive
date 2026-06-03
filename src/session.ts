import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Message, Usage } from "./types.js";
import { getOriginalCwd } from "./workspace.js";

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

// ── project directory layout ──────────────────────────────────────────────

const MAX_SANITIZED_LENGTH = 200;

/**
 * Sanitize an absolute path into a filesystem-safe directory name by
 * replacing every non-alphanumeric character with `-`.
 *
 * Example:
 *   D:\code\DeepDive   →  D--code-DeepDive
 *   /home/user/foo      →  -home-user-foo
 *
 * Windows drive letters (C:) produce an empty segment that's benign.
 *
 * For very long paths (>200 chars), the name is truncated and a 6‑hex
 * hash suffix is appended to avoid collisions.
 */
function sanitizePath(path: string): string {
  const sanitized = path.replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized;
  // Simple DJB2-style hash for the suffix
  let hash = 5381;
  for (let i = 0; i < path.length; i++) {
    hash = ((hash << 5) + hash + path.charCodeAt(i)) | 0;
  }
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function projectsDir(): string {
  return join(homedir(), ".deepdive", "projects");
}

function projectDir(cwd: string): string {
  return join(projectsDir(), sanitizePath(cwd));
}

// ── session paths ─────────────────────────────────────────────────────────

export function sessionPath(id: string): string {
  const dir = projectDir(getOriginalCwd());
  return join(dir, `${id}.jsonl`);
}

function ensureDir(): void {
  const dir = projectDir(getOriginalCwd());
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

export function isCompactSummaryMessage(msg: Message): boolean {
  return (
    msg.role === "user" && !!msg.content?.startsWith(COMPACT_SUMMARY_PREFIX)
  );
}

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
  let baseMeta: SessionMeta | null = null;
  let usage: Usage | null = null;
  const messages: Message[] = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as { type?: string } & Record<string, unknown>;
      if (obj.type === "meta") {
        const { type: _t, ...rest } = obj;
        if (!baseMeta) {
          baseMeta = rest as unknown as SessionMeta;
          meta = { ...baseMeta };
        } else {
          Object.assign(meta!, rest);
        }
      } else if (obj.type === "msg") {
        const { type: _t, ...rest } = obj;
        const msg = rest as unknown as Message;
        if (msg.usage) usage = msg.usage;
        messages.push(msg);
      } else if (obj.type === "compact") {
        const summary = String(obj.summary ?? "");
        messages.push(makeSummaryMessage(summary));
      }
    } catch {
      // skip malformed line
    }
  }
  return {
    meta,
    messages: trimDanglingTail(trimDanglingHead(messages)),
    usage,
  };
}

// ── session listing (single project directory, no filtering needed) ──────

const TAIL_BYTES = 8192;

function readFileTail(fullPath: string, size: number): string {
  const offset = Math.max(0, size - TAIL_BYTES);
  const len = Math.min(TAIL_BYTES, size);
  const buf = Buffer.alloc(len);
  let fd: number | null = null;
  try {
    fd = openSync(fullPath, "r");
    readSync(fd, buf, 0, len, offset);
  } finally {
    if (fd !== null) closeSync(fd);
  }
  return buf.toString("utf-8");
}

function readFileHead(fullPath: string, size: number): string {
  const len = Math.min(TAIL_BYTES, size);
  const buf = Buffer.alloc(len);
  let fd: number | null = null;
  try {
    fd = openSync(fullPath, "r");
    readSync(fd, buf, 0, len, 0);
  } finally {
    if (fd !== null) closeSync(fd);
  }
  return buf.toString("utf-8");
}

interface LiteSessionInfo {
  id: string;
  fullPath: string;
  mtimeMs: number;
  size: number;
}

function extractJsonField(text: string, field: string): string | undefined {
  const marker = `"${field}":"`;
  const idx = text.lastIndexOf(marker);
  if (idx === -1) return undefined;
  const start = idx + marker.length;
  const end = text.indexOf('"', start);
  if (end === -1) return undefined;
  return text.slice(start, end);
}

function extractTitleFromTail(tail: string): string | undefined {
  return extractJsonField(tail, "title");
}

function extractFirstPromptFromHead(head: string): string | undefined {
  const marker = '"type":"msg"';
  const roleMarker = '"role":"user"';
  const metaMarker = '"meta":true';
  const contentMarker = '"content":"';
  let searchFrom = 0;
  while (true) {
    const msgIdx = head.indexOf(marker, searchFrom);
    if (msgIdx === -1) return undefined;
    const lineEnd = head.indexOf("\n", msgIdx);
    const lineSlice =
      lineEnd === -1 ? head.slice(msgIdx) : head.slice(msgIdx, lineEnd);
    if (lineSlice.includes(roleMarker) && !lineSlice.includes(metaMarker)) {
      const cIdx = lineSlice.indexOf(contentMarker);
      if (cIdx !== -1) {
        const start = cIdx + contentMarker.length;
        const end = lineSlice.indexOf('"', start);
        if (end !== -1)
          return lineSlice.slice(start, Math.min(end, start + 80));
        return lineSlice.slice(start, start + 80);
      }
    }
    searchFrom = msgIdx + marker.length;
  }
}

function readSessionLite(info: LiteSessionInfo): SessionSummary | null {
  try {
    const tail = readFileTail(info.fullPath, info.size);
    const head =
      info.size <= TAIL_BYTES ? tail : readFileHead(info.fullPath, info.size);
    const title =
      extractTitleFromTail(tail) ||
      extractFirstPromptFromHead(head) ||
      "(empty)";
    const startedAt = extractJsonField(head, "startedAt") || "";
    return {
      id: info.id,
      startedAt,
      cwd: "",
      title: title.replace(/\s+/g, " ").trim() || "(empty)",
      mtimeMs: info.mtimeMs,
      messageCount: 0,
    };
  } catch {
    return null;
  }
}

export interface SessionListResult {
  sessions: SessionSummary[];
  allFiles: LiteSessionInfo[];
  nextIndex: number;
}

function getSessionFiles(): LiteSessionInfo[] {
  const dir = projectDir(getOriginalCwd());
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: LiteSessionInfo[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const id = name.slice(0, -".jsonl".length);
    const full = join(dir, name);
    try {
      const st = statSync(full);
      files.push({ id, fullPath: full, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      continue;
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;
}

export function listSessionsProgressive(
  count = 20,
): SessionListResult {
  const allFiles = getSessionFiles();
  const sessions: SessionSummary[] = [];
  let i = 0;
  while (i < allFiles.length && sessions.length < count) {
    const info = allFiles[i]!;
    i++;
    const summary = readSessionLite(info);
    if (summary) sessions.push(summary);
  }
  return { sessions, allFiles, nextIndex: i };
}

export function enrichMore(
  allFiles: LiteSessionInfo[],
  startIndex: number,
  count: number,
): { sessions: SessionSummary[]; nextIndex: number } {
  const sessions: SessionSummary[] = [];
  let i = startIndex;
  while (i < allFiles.length && sessions.length < count) {
    const info = allFiles[i]!;
    i++;
    const summary = readSessionLite(info);
    if (summary) sessions.push(summary);
  }
  return { sessions, nextIndex: i };
}

export function listSessions(limit = 50): SessionSummary[] {
  const { sessions, allFiles, nextIndex } = listSessionsProgressive(limit);
  if (sessions.length >= limit) return sessions.slice(0, limit);
  const more = enrichMore(allFiles, nextIndex, limit - sessions.length);
  return sessions.concat(more.sessions).slice(0, limit);
}

export function reAppendSessionMeta(id: string): void {
  const path = sessionPath(id);
  if (!existsSync(path)) return;
  try {
    const st = statSync(path);
    const tail = readFileTail(path, st.size);
    const title = extractTitleFromTail(tail);
    if (title) {
      appendFileSync(
        path,
        JSON.stringify({ type: "meta", title }) + "\n",
        "utf-8",
      );
    }
  } catch {
    // best-effort
  }
}

export function setPendingSessionTitle(id: string, title: string): boolean {
  if (pendingMeta && pendingMeta.id === id) {
    pendingMeta.title = title;
    return true;
  }
  return false;
}

export function updateSessionTitle(id: string, title: string): void {
  const path = sessionPath(id);
  if (!existsSync(path)) return;
  ensureDir();
  appendFileSync(
    path,
    JSON.stringify({ type: "meta", title }) + "\n",
    "utf-8",
  );
}

export function lastSessionId(): string | null {
  const list = listSessions(1);
  return list[0]?.id ?? null;
}
