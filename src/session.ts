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
import { randomBytes } from "node:crypto";
import type { Message } from "./types.js";

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

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function newSessionId(): string {
  const d = new Date();
  const ts = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  const rand = randomBytes(3).toString("hex");
  return `${ts}-${rand}`;
}

export function createSession(meta: SessionMeta): void {
  ensureDir();
  const line = JSON.stringify({ type: "meta", ...meta }) + "\n";
  writeFileSync(sessionPath(meta.id), line, "utf-8");
}

export function appendMessage(id: string, msg: Message): void {
  try {
    appendFileSync(
      sessionPath(id),
      JSON.stringify({ type: "msg", ...msg }) + "\n",
      "utf-8",
    );
  } catch {
    // disk write failures shouldn't crash the chat
  }
}

export function loadSession(
  id: string,
): { meta: SessionMeta | null; messages: Message[] } | null {
  const path = sessionPath(id);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  let meta: SessionMeta | null = null;
  const messages: Message[] = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as { type?: string } & Record<string, unknown>;
      if (obj.type === "meta") {
        const { type: _t, ...rest } = obj;
        meta = rest as unknown as SessionMeta;
      } else if (obj.type === "msg") {
        const { type: _t, ...rest } = obj;
        messages.push(rest as unknown as Message);
      }
    } catch {
      // skip malformed line
    }
  }
  return { meta, messages };
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
    const firstUser = loaded.messages.find((m) => m.role === "user");
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
