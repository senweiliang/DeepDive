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

/** Strip a leading `cd <dir> &&|;` so rules key off the real command. */
function stripCdPrefix(cmd: string): string {
  return cmd
    .trim()
    .replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, "")
    .trim();
}

/** Single source of truth: what permission rules are matched against. */
export function summarize(
  toolName: string,
  args: Record<string, unknown>,
): string {
  switch (toolName) {
    case "bash":
      return stripCdPrefix(String(args.command ?? ""));
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
  const cmd = stripCdPrefix(command);
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

/**
 * Auto-suggest a reusable permission pattern for the "Allow always" action.
 * Returns null when no safe, reusable pattern exists (compound/injected
 * commands, dangerous wrappers, unknown tools) — the UI then hides the option.
 */
export function suggestPermissionPattern(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  const ruleName = toolRuleName(toolName);

  if (toolName === "bash") {
    const cmd = stripCdPrefix(String(args.command ?? ""));
    if (!cmd || SHELL_OPS_RE.test(cmd)) return null; // compound / injectable

    const tokens = cmd.split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) {
      const name = tokens[i]!.split("=")[0]!;
      if (!SAFE_ENV_VARS.has(name)) return null; // unsafe env → exact only
      i++;
    }
    const rest = tokens.slice(i);
    const command = rest[0];
    if (!command || !TOKEN_RE.test(command)) return null; // path/flag/empty
    if (DANGEROUS_PREFIXES.has(command)) return null;

    const sub = rest[1];
    if (sub && TOKEN_RE.test(sub)) {
      return `${ruleName}(${command} ${sub}:*)`;
    }
    return `${ruleName}(${command}:*)`;
  }

  if (
    toolName === "read_file" ||
    toolName === "write_file" ||
    toolName === "edit_file"
  ) {
    const path = String(args.file_path ?? "");
    return path ? `${ruleName}(${path})` : null;
  }

  if (toolName === "glob" || toolName === "grep") {
    const pattern = String(args.pattern ?? "");
    return pattern ? `${ruleName}(${pattern})` : null;
  }

  return null;
}
