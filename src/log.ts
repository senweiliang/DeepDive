import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// Ink owns stdout/stderr — console.* would corrupt the TUI. Diagnostic logs
// go to ~/.deepdive/logs/<sessionId>.log. Before a session ID is set, logs
// go to ~/.deepdive/deepdive.log (startup phase).

const LOG_DIR = join(homedir(), ".deepdive", "logs");
const FALLBACK_LOG = join(homedir(), ".deepdive", "deepdive.log");

let sessionId: string | null = null;
let ensuredDir = false;
let ensuredFallback = false;

function ensure() {
  if (sessionId && !ensuredDir) {
    try { mkdirSync(LOG_DIR, { recursive: true }); ensuredDir = true; } catch { /* */ }
  }
  if (!sessionId && !ensuredFallback) {
    try { mkdirSync(dirname(FALLBACK_LOG), { recursive: true }); ensuredFallback = true; } catch { /* */ }
  }
}

function logPath(): string {
  if (sessionId) return join(LOG_DIR, `${sessionId}.log`);
  return FALLBACK_LOG;
}

export function setSessionId(id: string) {
  sessionId = id;
}

function write(level: string, category: string, msg: string) {
  ensure();
  const ts = new Date().toISOString();
  const sid = sessionId ? ` [${sessionId.slice(0, 8)}]` : "";
  const line = `${ts} ${level}${sid} [${category}] ${msg}\n`;
  try {
    appendFileSync(logPath(), line);
  } catch {
    // swallow — logging must never throw into the caller
  }
}

export function info(category: string, msg: string) {
  write("INFO", category, msg);
}

export function warn(category: string, msg: string) {
  write("WARN", category, msg);
}

export function error(category: string, msg: string) {
  write("ERROR", category, msg);
}
