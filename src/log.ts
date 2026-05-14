import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// Ink owns stdout/stderr — console.* would corrupt the TUI. Diagnostic logs
// go to a file at ~/.deepdive/deepdive.log so they survive across runs and
// can be tailed in a separate terminal.

const LOG_FILE = join(homedir(), ".deepdive", "deepdive.log");
let ensured = false;

function ensureDir() {
  if (ensured) return;
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    ensured = true;
  } catch {
    // ignore — logging must never throw into the caller
  }
}

function write(level: string, category: string, msg: string) {
  ensureDir();
  const line = `${new Date().toISOString()} ${level} [${category}] ${msg}\n`;
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    // swallow
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
