/**
 * Command permission management.
 *
 * Rule format: `Tool(body)`
 *   - Prefix rule:  body ends with `:*`  → matches when the summarized command
 *                   equals the prefix or starts with `prefix + " "`
 *                   (token boundary — `Bash(git push:*)` does NOT match `git pushx`).
 *   - Exact rule:   no `:*` suffix → glob match (`*` / `**` → `.*`), anchored.
 *                   Used for file paths and exact commands.
 *
 * Decision pipeline (most-specific & most-restrictive first, short-circuit):
 *   exact deny → exact ask → prefix deny → prefix ask
 *   → exact allow → prefix allow → read-only allowlist → passthrough
 */

import { dirname } from "node:path";

export interface PermissionConfig {
  allow: string[];
  deny: string[];
  ask: string[];
}

export type PermissionDecision = "deny" | "ask" | "allow" | "passthrough";

export interface PermissionRule {
  tool: string; // e.g. "Bash"
  body: string; // e.g. "git push:*" or "/etc/hosts"
  prefix: string | null; // non-null for `:*` prefix rules (body without `:*`)
  raw: string;
}

const EMPTY_PERMISSIONS: PermissionConfig = { allow: [], deny: [], ask: [] };

// Token shape for a command / subcommand: lowercase word, optional internal
// hyphens. Rejects flags (-x), paths (/usr/bin), filenames (a.txt), numbers.
const TOKEN_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

// Env assignments that are safe to skip when deriving a command prefix.
const SAFE_ENV_VARS = new Set([
  "NODE_ENV",
  "CI",
  "DEBUG",
  "LOG_LEVEL",
  "FORCE_COLOR",
  "NO_COLOR",
  "TZ",
  "LANG",
  "LC_ALL",
]);

// Bare-prefix suggestions for these would be ≈ `Bash(*)`: they exec arbitrary
// args (`sh -c`, `env CMD`, `sudo CMD`, `xargs CMD`, wrappers stripped by
// security checks). Never auto-suggest a reusable rule for them.
const DANGEROUS_PREFIXES = new Set([
  "sh", "bash", "zsh", "fish", "csh", "tcsh", "ksh", "dash",
  "cmd", "powershell", "pwsh",
  "env", "xargs", "eval", "exec", "source",
  "nice", "stdbuf", "nohup", "timeout", "time",
  "sudo", "doas", "pkexec",
]);

// Shell metacharacters that make a command compound / injectable. A command
// containing any of these is never auto-suggested and never read-only.
const SHELL_OPS_RE = /[;&|`]|\$\(|\|\||&&|[<>]/;

// Conservative read-only command allowlist (first token, or first two for git).
// A command is auto-allowed only if it has no shell operators and its leading
// token(s) are in this set.
const READ_ONLY_COMMANDS = new Set([
  "ls", "pwd", "cat", "head", "tail", "wc", "echo", "printf",
  "which", "type", "whoami", "hostname", "date", "uname", "tree",
  "file", "stat", "du", "df", "basename", "dirname", "realpath",
  "readlink", "sort", "uniq", "cut", "column", "id", "groups",
  "rg", "grep", "find", "fd", "fdfind", "ag",
]);
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "branch", "remote",
  "rev-parse", "describe", "tag",
]);

// Harmless redirections: fd-merges (2>&1, 1>&2) and /dev/null sinks. These
// write no real file and run no other command, so they're stripped before
// deriving the command identity — `:*` would cover them anyway. A redirect to
// a real file (`> out.txt`) is intentionally NOT stripped: it stays and trips
// the compound/injection guard (conservative — we have no path constraints).
const SAFE_REDIRECT_RE =
  /\s*(?:\d*>&\d+|&?>>?\s*\/dev\/null|\d+>\s*\/dev\/null)/g;

/** Strip a leading `cd <dir> &&|;` so rules key off the real command. */
function stripCdPrefix(cmd: string): string {
  return cmd
    .trim()
    .replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, "")
    .trim();
}

/** Normalize a bash command for matching/suggesting: drop cd + safe redirects. */
function normalizeCommand(cmd: string): string {
  return stripCdPrefix(cmd).replace(SAFE_REDIRECT_RE, "").trim();
}

/** Single source of truth: what permission rules are matched against. */
export function summarize(
  toolName: string,
  args: Record<string, unknown>,
): string {
  switch (toolName) {
    case "bash":
      return normalizeCommand(String(args.command ?? ""));
    case "read_file":
    case "write_file":
    case "edit_file":
      return String(args.file_path ?? "");
    case "glob":
    case "grep":
      return String(args.pattern ?? "");
    default:
      return JSON.stringify(args);
  }
}

/** Map internal tool name → the name used inside permission rules. */
export function toolRuleName(name: string): string {
  switch (name) {
    case "bash": return "Bash";
    case "read_file": return "Read";
    case "write_file": return "Write";
    case "edit_file": return "Edit";
    case "glob": return "Glob";
    case "grep": return "Grep";
    default: return name;
  }
}

/** Parse `Bash(git push:*)` → structured rule (null if malformed). */
export function parsePermissionRule(raw: string): PermissionRule | null {
  const m = raw.match(/^(\w+)\((.+)\)$/);
  if (!m) return null;
  const body = m[2]!;
  const prefix = body.endsWith(":*") ? body.slice(0, -2) : null;
  return { tool: m[1]!, body, prefix, raw };
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

type MatchKind = "exact" | "prefix" | null;

function matchRule(
  rule: PermissionRule,
  ruleName: string,
  summary: string,
): MatchKind {
  if (rule.tool !== ruleName) return null;
  if (rule.prefix !== null) {
    // token-boundary prefix match
    if (summary === rule.prefix) return "prefix";
    if (summary.startsWith(rule.prefix + " ")) return "prefix";
    return null;
  }
  return globToRegex(rule.body).test(summary) ? "exact" : null;
}

/** Does any rule in `list` match, and how (exact takes priority over prefix)? */
function listMatch(
  list: string[],
  ruleName: string,
  summary: string,
): MatchKind {
  let prefixHit = false;
  for (const raw of list) {
    const rule = parsePermissionRule(raw);
    if (!rule) continue;
    const kind = matchRule(rule, ruleName, summary);
    if (kind === "exact") return "exact";
    if (kind === "prefix") prefixHit = true;
  }
  return prefixHit ? "prefix" : null;
}

/** Is this bash command a safe, side-effect-free read-only invocation? */
export function isReadOnlyCommand(command: string): boolean {
  const cmd = normalizeCommand(command);
  if (!cmd || SHELL_OPS_RE.test(cmd)) return false;
  const tokens = cmd.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const first = tokens[0]!;
  if (first === "git") {
    return tokens.length >= 2 && READ_ONLY_GIT_SUBCOMMANDS.has(tokens[1]!);
  }
  return READ_ONLY_COMMANDS.has(first);
}

/**
 * Ordered permission decision for a tool call.
 * Read-only auto-allow applies to bash only (read/glob/grep don't reach here).
 */
export function checkPermission(
  perm: PermissionConfig | undefined,
  toolName: string,
  args: Record<string, unknown>,
): PermissionDecision {
  const p = perm ?? EMPTY_PERMISSIONS;
  const ruleName = toolRuleName(toolName);
  const summary = summarize(toolName, args);

  const deny = listMatch(p.deny, ruleName, summary);
  const ask = listMatch(p.ask, ruleName, summary);
  const allow = listMatch(p.allow, ruleName, summary);

  // exact (most specific) deny/ask before any prefix rule
  if (deny === "exact") return "deny";
  if (ask === "exact") return "ask";
  if (deny === "prefix") return "deny";
  if (ask === "prefix") return "ask";

  if (allow === "exact") return "allow";
  if (allow === "prefix") return "allow";

  if (toolName === "bash" && isReadOnlyCommand(String(args.command ?? ""))) {
    return "allow";
  }
  return "passthrough";
}

// Command separators we can safely split a compound command on: each side is
// an independent invocation, so a bundled suggestion (one rule per segment) is
// sound iff EVERY segment is independently safe. Genuinely un-constrainable
// constructs (`` ` ``, `$()`, single `&` backgrounding, real-file redirects,
// process substitution) are NOT separators — a segment still containing any of
// them trips SHELL_OPS_RE below and vetoes the whole suggestion.
const CMD_SEPARATORS_RE = /\s*(?:&&|\|\||;|\|)\s*/;

/** Derive a reusable prefix rule for one already-split command segment.
 *  Returns the rule, "" to skip the segment (harmless, e.g. `cd`), or null to
 *  veto the whole suggestion (unsafe / un-constrainable). */
function bashSegmentRule(ruleName: string, seg: string): string | null {
  if (SHELL_OPS_RE.test(seg)) return null; // leftover ` $() & <> → un-constrainable

  const tokens = seg.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) {
    const name = tokens[i]!.split("=")[0]!;
    if (!SAFE_ENV_VARS.has(name)) return null; // unsafe env → exact only
    i++;
  }
  const rest = tokens.slice(i);
  const command = rest[0];
  if (!command) return "";
  if (command === "cd") return ""; // dir change is side-effect-free; skip, don't veto
  if (!TOKEN_RE.test(command)) return null; // path/flag
  if (DANGEROUS_PREFIXES.has(command)) return null;

  const sub = rest[1];
  if (sub && TOKEN_RE.test(sub)) return `${ruleName}(${command} ${sub}:*)`;
  return `${ruleName}(${command}:*)`;
}

/**
 * Auto-suggest reusable permission patterns for the "Allow always" action.
 * Returns null when no safe, reusable pattern exists (un-constrainable
 * injection, dangerous wrappers, unknown tools) — the UI then hides the
 * option. For a compound command, returns one rule per segment (deduped),
 * only when EVERY segment is independently safe.
 */
export function suggestPermissionPattern(
  toolName: string,
  args: Record<string, unknown>,
): string[] | null {
  const ruleName = toolRuleName(toolName);

  if (toolName === "bash") {
    const cmd = normalizeCommand(String(args.command ?? ""));
    if (!cmd) return null;

    const rules: string[] = [];
    for (const raw of cmd.split(CMD_SEPARATORS_RE)) {
      const seg = raw.trim();
      if (!seg) continue;
      const rule = bashSegmentRule(ruleName, seg);
      if (rule === null) return null; // any unsafe segment → veto the bundle
      if (rule && !rules.includes(rule)) rules.push(rule);
    }
    return rules.length ? rules : null;
  }

  if (toolName === "read_file") {
    // Reads suggest the containing directory (`Read(<dir>/**)`) — a single-file
    // rule is rarely reusable. Reject root (`/**` ≈ read-anything) and fall
    // back to the exact path so the option stays useful but not dangerous.
    const path = String(args.file_path ?? "");
    if (!path) return null;
    const dir = dirname(path);
    if (!dir || dir === "/" || dir === ".") return [`${ruleName}(${path})`];
    return [`${ruleName}(${dir}/**)`];
  }

  if (toolName === "write_file" || toolName === "edit_file") {
    // No persisted single-file allow rule for writes. The reusable grant for
    // out-of-workspace writes is a session-scoped directory grant (mirrors
    // official `addDirectories`, session destination) plus the optional
    // acceptEdits upgrade — both handled in the approval UI, not as settings.
    return null;
  }

  if (toolName === "glob" || toolName === "grep") {
    const pattern = String(args.pattern ?? "");
    return pattern ? [`${ruleName}(${pattern})`] : null;
  }

  return null;
}
