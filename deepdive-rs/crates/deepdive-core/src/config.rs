//! Configuration. Faithful port of `src/config.ts`.
//!
//! Precedence per setting: environment variable (non-empty) → the flat key in
//! `~/.deepdive/settings.json` → built-in default. `env` holds genuine
//! environment variables (API key, base URL, Tavily key); top-level flat keys
//! hold app settings. Old per-env app settings migrate to flat keys on load.

use crate::contract::ApprovalMode;
use crate::tools::permissions::PermissionConfig;
use crate::types::TurnSummaryStrategy;
use crate::workspace::original_cwd;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SearchEngine {
    #[default]
    Tavily,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RequestAuditMode {
    #[default]
    Off,
    Summary,
    Full,
}

/// Context window per known model; fallback 128k.
pub fn model_context_window(model: &str) -> u64 {
    match model {
        "deepseek-v4-pro" | "deepseek-v4-flash" | "auto" => 1_000_000,
        _ => 128_000,
    }
}

/// Resolve `config.model` for callers that DON'T run the per-message auto
/// classifier (compaction / turn-summary requests, memory extraction, subagents
/// without their own model override, the `/btw` side question) — `"auto"` is
/// only a valid choice for the main interactive turn (the engine routes it
/// through [`crate::model_router::route_model`] before this ever matters); every
/// other caller must not send the literal string `"auto"` to the API, so it
/// resolves to Pro instead. Port of config.ts `resolveModel`.
pub fn resolve_model(model: &str) -> &str {
    if model == "auto" {
        "deepseek-v4-pro"
    } else {
        model
    }
}

pub struct ChatModel {
    pub value: &'static str,
    pub label: &'static str,
    pub description: &'static str,
}

pub const CHAT_MODELS: &[ChatModel] = &[
    ChatModel {
        value: "auto",
        label: "auto",
        description: "Auto (flash classifies → pro or flash)",
    },
    ChatModel {
        value: "deepseek-v4-pro",
        label: "pro",
        description: "DeepSeek V4 Pro",
    },
    ChatModel {
        value: "deepseek-v4-flash",
        label: "flash",
        description: "DeepSeek V4 Flash",
    },
];

pub const REASONING_EFFORTS: &[&str] = &["none", "low", "medium", "high", "max", "xhigh"];

/// Response-language codes accepted by `responseLanguage` (`auto` = no force).
pub const RESPONSE_LANGUAGES: &[&str] = &["auto", "zh", "zh-Hant", "en", "ja", "ko"];

/// Human-readable label for a response-language code (the `label` field of the
/// TS `RESPONSE_LANGUAGES` table). Used verbatim in the system-prompt language
/// section. Returns `None` for an unknown code.
pub fn language_label(value: &str) -> Option<&'static str> {
    match value {
        "auto" => Some("auto"),
        "zh" => Some("简体中文"),
        "zh-Hant" => Some("繁體中文"),
        "en" => Some("English"),
        "ja" => Some("日本語"),
        "ko" => Some("한국어"),
        _ => None,
    }
}

#[derive(Debug, Clone, Default)]
pub struct Config {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub summary_model: String,
    pub reasoning_effort: String,
    pub max_tokens: u32,
    pub approval_mode: ApprovalMode,
    pub context_window: u64,
    pub search_engine: SearchEngine,
    pub tavily_api_key: String,
    pub response_language: String,
    pub show_splash: bool,
    /// Tool-loop cap; `None` = unlimited.
    pub max_turns: Option<u64>,
    pub request_audit: RequestAuditMode,
    pub turn_summary_strategy: TurnSummaryStrategy,
    pub permissions: PermissionConfig,
    pub additional_directories: Vec<String>,
    /// Configured MCP servers (global `mcpServers` + project `.mcp.json`), parsed
    /// at load. Data only — live connections live in `Session.mcp`.
    pub mcp_servers: Vec<crate::mcp::McpServerConfig>,
    /// MCP tool schemas discovered at session start, appended to `ALL_TOOLS` in
    /// `build_body`. Frozen once connected → prefix-cache-stable. Empty until the
    /// frontend connects and populates it.
    pub mcp_tools: Vec<Value>,
    /// Resolved working directory (frozen). Not a TS Config field — convenience
    /// for the client's env section; mirrors `getOriginalCwd()`.
    pub cwd: PathBuf,
}

/// JS `parseInt(s, 10)`: optional sign + leading digits, ignore the rest.
fn parse_int_lenient(s: &str) -> Option<i64> {
    let t = s.trim();
    let bytes = t.as_bytes();
    let mut i = 0;
    let mut neg = false;
    if let Some(&b) = bytes.first() {
        if b == b'+' || b == b'-' {
            neg = b == b'-';
            i = 1;
        }
    }
    let start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == start {
        return None;
    }
    t[start..i]
        .parse::<i64>()
        .ok()
        .map(|n| if neg { -n } else { n })
}

/// JS `String(value)` for a JSON value, with `?? ""` for null/missing.
fn js_string(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(other) => other.to_string(),
    }
}

pub fn resolve_context_window(
    model: &str,
    env_value: Option<&str>,
    settings_value: Option<&str>,
) -> u64 {
    let from = |s: Option<&str>| {
        s.filter(|x| !x.is_empty())
            .and_then(parse_int_lenient)
            .map(|n| n.max(0) as u64)
    };
    from(env_value)
        .or_else(|| from(settings_value))
        .unwrap_or_else(|| model_context_window(model))
}

/// Tool-loop cap. Unset / invalid / non-positive ⇒ unlimited (`None`).
pub fn resolve_max_turns(env_value: Option<&str>, settings_value: Option<&str>) -> Option<u64> {
    let raw = env_value.or(settings_value)?;
    if raw.is_empty() {
        return None;
    }
    parse_int_lenient(raw).filter(|n| *n > 0).map(|n| n as u64)
}

fn get_search_engine(_value: &str) -> SearchEngine {
    SearchEngine::Tavily
}

fn get_response_language(value: &str) -> String {
    if RESPONSE_LANGUAGES.contains(&value) {
        value.to_string()
    } else {
        "auto".to_string()
    }
}

fn get_approval_mode(value: &str) -> ApprovalMode {
    match value {
        "plan" => ApprovalMode::Plan,
        "yolo" => ApprovalMode::Yolo,
        "auto" => ApprovalMode::Auto,
        "acceptEdits" => ApprovalMode::AcceptEdits,
        _ => ApprovalMode::Auto,
    }
}

fn get_request_audit_mode(value: &str) -> RequestAuditMode {
    match value {
        "full" => RequestAuditMode::Full,
        "summary" => RequestAuditMode::Summary,
        _ => RequestAuditMode::Off,
    }
}

fn get_turn_summary_strategy(value: &str) -> TurnSummaryStrategy {
    match value {
        "whole_turn" => TurnSummaryStrategy::WholeTurn,
        "tool_only" => TurnSummaryStrategy::ToolOnly,
        _ => TurnSummaryStrategy::Off,
    }
}

fn get_show_splash(value: &str) -> bool {
    value != "off"
}

// ── settings.json (flat structure) ───────────────────────────────────────────

const APP_SETTING_KEYS: &[&str] = &[
    "model",
    "summaryModel",
    "reasoningEffort",
    "responseLanguage",
    "showSplash",
    "turnSummaryStrategy",
    "requestAudit",
    "searchEngine",
    "approvalMode",
    "contextWindow",
    "maxTokens",
    "maxTurns",
    "tavilyApiKey",
    "additionalDirectories",
    "mcpServers",
];

/// old env name → new flat key (migration).
const OLD_ENV_TO_FLAT: &[(&str, &str)] = &[
    ("DEEPSEEK_MODEL", "model"),
    ("DEEPSEEK_SUMMARY_MODEL", "summaryModel"),
    ("DEEPSEEK_REASONING_EFFORT", "reasoningEffort"),
    ("DEEPSEEK_RESPONSE_LANGUAGE", "responseLanguage"),
    ("DEEPDIVE_SHOW_SPLASH", "showSplash"),
    ("DEEPDIVE_TURN_SUMMARY_STRATEGY", "turnSummaryStrategy"),
    ("DEEPDIVE_REQUEST_AUDIT", "requestAudit"),
    ("DEEPSEEK_SEARCH_ENGINE", "searchEngine"),
    ("DEEPSEEK_MODE", "approvalMode"),
    ("DEEPSEEK_CONTEXT_WINDOW", "contextWindow"),
    ("DEEPSEEK_MAX_TOKENS", "maxTokens"),
    ("DEEPSEEK_MAX_TURNS", "maxTurns"),
];

const ENV_KEEP_KEYS: &[&str] = &["DEEPSEEK_API_KEY", "TAVILY_API_KEY", "DEEPSEEK_BASE_URL"];

/// Loaded settings: genuine env vars, app-setting flat keys, and permissions.
#[derive(Debug, Default)]
pub struct Settings {
    pub env: HashMap<String, String>,
    pub flat: Map<String, Value>,
    pub permissions: PermissionConfig,
}

fn settings_path() -> PathBuf {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default();
    home.join(".deepdive").join("settings.json")
}

fn str_vec(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|x| x.as_str().map(String::from))
            .collect(),
        _ => Vec::new(),
    }
}

fn normalize_permissions(raw: Option<&Value>) -> PermissionConfig {
    match raw {
        Some(Value::Array(a)) => PermissionConfig {
            allow: a
                .iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect(),
            deny: Vec::new(),
            ask: Vec::new(),
        },
        Some(Value::Object(o)) => PermissionConfig {
            allow: str_vec(o.get("allow")),
            deny: str_vec(o.get("deny")),
            ask: str_vec(o.get("ask")),
        },
        _ => PermissionConfig::default(),
    }
}

fn load_settings_from(path: &Path) -> Settings {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Settings::default();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return Settings::default();
    };

    let parsed_env: Map<String, Value> = parsed
        .get("env")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let mut flat = Map::new();
    for key in APP_SETTING_KEYS {
        if let Some(v) = parsed.get(*key) {
            flat.insert((*key).to_string(), v.clone());
        }
    }

    // Migration: promote old per-env app settings to flat keys (once).
    let mut migrated = false;
    for (env_key, flat_key) in OLD_ENV_TO_FLAT {
        let has_env = parsed_env
            .get(*env_key)
            .map(|v| !v.is_null())
            .unwrap_or(false);
        if has_env && parsed.get(*flat_key).is_none() {
            flat.insert((*flat_key).to_string(), parsed_env[*env_key].clone());
            migrated = true;
        }
    }

    // Keep only genuine env vars.
    let mut env = HashMap::new();
    for key in ENV_KEEP_KEYS {
        if let Some(s) = parsed_env.get(*key).and_then(Value::as_str) {
            env.insert((*key).to_string(), s.to_string());
        }
    }

    let permissions = normalize_permissions(parsed.get("permissions"));
    let settings = Settings {
        env,
        flat,
        permissions,
    };

    if migrated {
        let _ = write_settings(path, &settings);
    }
    settings
}

fn load_settings() -> Settings {
    load_settings_from(&settings_path())
}

fn write_settings(path: &Path, data: &Settings) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        if !dir.as_os_str().is_empty() && !dir.exists() {
            std::fs::create_dir_all(dir)?;
        }
    }
    let mut obj = Map::new();
    let env: Map<String, Value> = data
        .env
        .iter()
        .map(|(k, v)| (k.clone(), Value::String(v.clone())))
        .collect();
    obj.insert("env".into(), Value::Object(env));
    for key in APP_SETTING_KEYS {
        if let Some(v) = data.flat.get(*key) {
            obj.insert((*key).to_string(), v.clone());
        }
    }
    obj.insert(
        "permissions".into(),
        serde_json::to_value(&data.permissions).unwrap(),
    );
    let text = serde_json::to_string_pretty(&Value::Object(obj))?;
    std::fs::write(path, text)
}

impl Config {
    pub fn load() -> Self {
        let s = load_settings();
        let env_var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let flat_str = |k: &str| js_string(s.flat.get(k));
        // env (non-empty) → flat (non-empty) → default
        let pick = |env_key: &str, flat_key: &str, default: &str| -> String {
            env_var(env_key)
                .or_else(|| {
                    let f = flat_str(flat_key);
                    (!f.is_empty()).then_some(f)
                })
                .unwrap_or_else(|| default.to_string())
        };

        let model = pick("DEEPSEEK_MODEL", "model", "deepseek-v4-pro");
        let max_tokens = parse_int_lenient(&pick("DEEPSEEK_MAX_TOKENS", "maxTokens", "32000"))
            .filter(|n| *n >= 0)
            .unwrap_or(32_000) as u32;

        let approval_mode = get_approval_mode(
            &env_var("DEEPSEEK_MODE").unwrap_or_else(|| flat_str("approvalMode")),
        );
        let cw_flat = flat_str("contextWindow");
        let context_window = resolve_context_window(
            &model,
            env_var("DEEPSEEK_CONTEXT_WINDOW").as_deref(),
            Some(cw_flat.as_str()),
        );
        let mt_flat = flat_str("maxTurns");
        let max_turns = resolve_max_turns(
            env_var("DEEPSEEK_MAX_TURNS").as_deref(),
            Some(mt_flat.as_str()),
        );

        let tavily_api_key = env_var("TAVILY_API_KEY")
            .or_else(|| {
                let f = flat_str("tavilyApiKey");
                (!f.is_empty()).then_some(f)
            })
            .or_else(|| {
                s.env
                    .get("TAVILY_API_KEY")
                    .cloned()
                    .filter(|v| !v.is_empty())
            })
            .unwrap_or_default();

        let response_language = get_response_language(
            &env_var("DEEPSEEK_RESPONSE_LANGUAGE").unwrap_or_else(|| flat_str("responseLanguage")),
        );
        let request_audit = get_request_audit_mode(
            &env_var("DEEPDIVE_REQUEST_AUDIT")
                .or_else(|| env_var("DEEPSEEK_REQUEST_AUDIT"))
                .unwrap_or_else(|| flat_str("requestAudit")),
        );
        let turn_summary_strategy = get_turn_summary_strategy(
            &env_var("DEEPDIVE_TURN_SUMMARY_STRATEGY")
                .unwrap_or_else(|| flat_str("turnSummaryStrategy")),
        );
        let show_splash = get_show_splash(
            &env_var("DEEPDIVE_SHOW_SPLASH").unwrap_or_else(|| flat_str("showSplash")),
        );
        let search_engine = get_search_engine(
            &env_var("DEEPSEEK_SEARCH_ENGINE").unwrap_or_else(|| flat_str("searchEngine")),
        );

        Config {
            api_key: env_var("DEEPSEEK_API_KEY")
                .or_else(|| {
                    s.env
                        .get("DEEPSEEK_API_KEY")
                        .cloned()
                        .filter(|v| !v.is_empty())
                })
                .unwrap_or_default(),
            base_url: env_var("DEEPSEEK_BASE_URL")
                .or_else(|| {
                    s.env
                        .get("DEEPSEEK_BASE_URL")
                        .cloned()
                        .filter(|v| !v.is_empty())
                })
                .unwrap_or_else(|| "https://api.deepseek.com".to_string()),
            model,
            summary_model: pick(
                "DEEPSEEK_SUMMARY_MODEL",
                "summaryModel",
                "deepseek-v4-flash",
            ),
            reasoning_effort: pick("DEEPSEEK_REASONING_EFFORT", "reasoningEffort", "high"),
            max_tokens,
            approval_mode,
            context_window,
            search_engine,
            tavily_api_key,
            response_language,
            show_splash,
            max_turns,
            request_audit,
            turn_summary_strategy,
            permissions: s.permissions,
            additional_directories: str_vec(s.flat.get("additionalDirectories")),
            mcp_servers: crate::mcp::load_mcp_servers(s.flat.get("mcpServers"), &original_cwd()),
            mcp_tools: Vec::new(),
            cwd: original_cwd(),
        }
    }
}

// ── persisted mutations ──────────────────────────────────────────────────────

fn save_flat(key: &str, value: Value) {
    let path = settings_path();
    let mut s = load_settings_from(&path);
    s.flat.insert(key.to_string(), value);
    let _ = write_settings(&path, &s);
}

/// Read a raw top-level app-setting value from the global `settings.json`
/// (`None` if the file or key is absent). Used by MCP config management to read
/// the `mcpServers` object without going through the typed `Config`.
pub fn read_flat_setting(key: &str) -> Option<Value> {
    load_settings().flat.get(key).cloned()
}

/// Write a raw top-level app-setting value into the global `settings.json`,
/// preserving every other field. Counterpart of [`read_flat_setting`].
pub fn write_flat_setting(key: &str, value: Value) {
    save_flat(key, value);
}

pub fn save_api_key(key: &str) {
    let path = settings_path();
    let mut s = load_settings_from(&path);
    s.env.insert("DEEPSEEK_API_KEY".into(), key.to_string());
    let _ = write_settings(&path, &s);
}

pub fn save_settings_env(env: HashMap<String, String>, permissions: Option<PermissionConfig>) {
    let path = settings_path();
    let mut s = load_settings_from(&path);
    s.env = env;
    if let Some(p) = permissions {
        s.permissions = p;
    }
    let _ = write_settings(&path, &s);
}

pub fn save_model(model: &str) {
    save_flat("model", Value::String(model.to_string()));
}
pub fn save_reasoning_effort(effort: &str) {
    save_flat("reasoningEffort", Value::String(effort.to_string()));
}
pub fn save_tavily_key(key: &str) {
    save_flat("tavilyApiKey", Value::String(key.to_string()));
}
pub fn save_response_language(lang: &str) {
    save_flat("responseLanguage", Value::String(lang.to_string()));
}
pub fn save_turn_summary_strategy(strategy: TurnSummaryStrategy) {
    let s = match strategy {
        TurnSummaryStrategy::Off => "off",
        TurnSummaryStrategy::WholeTurn => "whole_turn",
        TurnSummaryStrategy::ToolOnly => "tool_only",
    };
    save_flat("turnSummaryStrategy", Value::String(s.to_string()));
}
pub fn save_show_splash(enabled: bool) {
    save_flat(
        "showSplash",
        Value::String(if enabled { "on" } else { "off" }.to_string()),
    );
}

pub fn save_permission(pattern: &str, kind: PermissionKind) {
    let path = settings_path();
    let mut s = load_settings_from(&path);
    let list = match kind {
        PermissionKind::Allow => &mut s.permissions.allow,
        PermissionKind::Deny => &mut s.permissions.deny,
        PermissionKind::Ask => &mut s.permissions.ask,
    };
    if !list.iter().any(|p| p == pattern) {
        list.push(pattern.to_string());
        let _ = write_settings(&path, &s);
    }
}

#[derive(Debug, Clone, Copy)]
pub enum PermissionKind {
    Allow,
    Deny,
    Ask,
}

pub fn save_additional_directory(dir: &str) {
    let path = settings_path();
    let mut s = load_settings_from(&path);
    let mut dirs = str_vec(s.flat.get("additionalDirectories"));
    if !dirs.iter().any(|d| d == dir) {
        dirs.push(dir.to_string());
        s.flat.insert(
            "additionalDirectories".into(),
            Value::Array(dirs.into_iter().map(Value::String).collect()),
        );
        let _ = write_settings(&path, &s);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_int_matches_js_parseint() {
        assert_eq!(parse_int_lenient("3000"), Some(3000));
        assert_eq!(parse_int_lenient("  42 "), Some(42));
        assert_eq!(parse_int_lenient("3000abc"), Some(3000));
        assert_eq!(parse_int_lenient("-5"), Some(-5));
        assert_eq!(parse_int_lenient("abc"), None);
        assert_eq!(parse_int_lenient(""), None);
    }

    #[test]
    fn context_window_precedence() {
        assert_eq!(
            resolve_context_window("deepseek-v4-pro", None, None),
            1_000_000
        );
        assert_eq!(resolve_context_window("unknown-model", None, None), 128_000);
        assert_eq!(
            resolve_context_window("deepseek-v4-pro", Some("5000"), None),
            5_000
        );
        assert_eq!(
            resolve_context_window("deepseek-v4-pro", None, Some("7000")),
            7_000
        );
        assert_eq!(
            resolve_context_window("deepseek-v4-pro", Some(""), Some("7000")),
            7_000
        );
    }

    #[test]
    fn max_turns_resolution() {
        assert_eq!(resolve_max_turns(None, None), None);
        assert_eq!(resolve_max_turns(Some(""), None), None);
        assert_eq!(resolve_max_turns(Some("0"), None), None);
        assert_eq!(resolve_max_turns(Some("5"), None), Some(5));
        assert_eq!(resolve_max_turns(None, Some("12")), Some(12));
        assert_eq!(resolve_max_turns(Some("3"), Some("99")), Some(3));
    }

    #[test]
    fn getters_match_ts() {
        assert_eq!(get_approval_mode("plan"), ApprovalMode::Plan);
        assert_eq!(get_approval_mode("acceptEdits"), ApprovalMode::AcceptEdits);
        assert_eq!(get_approval_mode("default"), ApprovalMode::Auto); // not a valid input → auto
        assert_eq!(get_approval_mode(""), ApprovalMode::Auto);
        assert_eq!(get_request_audit_mode("full"), RequestAuditMode::Full);
        assert_eq!(get_request_audit_mode("summary"), RequestAuditMode::Summary);
        assert_eq!(get_request_audit_mode("nope"), RequestAuditMode::Off);
        assert_eq!(
            get_turn_summary_strategy("tool_only"),
            TurnSummaryStrategy::ToolOnly
        );
        assert_eq!(get_turn_summary_strategy("x"), TurnSummaryStrategy::Off);
        assert!(!get_show_splash("off"));
        assert!(get_show_splash(""));
        assert_eq!(get_response_language("zh"), "zh");
        assert_eq!(get_response_language("klingon"), "auto");
    }

    #[test]
    fn normalize_permissions_array_object_and_invalid() {
        let p = normalize_permissions(Some(&json!(["Bash(ls:*)"])));
        assert_eq!(p.allow, vec!["Bash(ls:*)"]);
        assert!(p.deny.is_empty());
        let p = normalize_permissions(Some(&json!({"allow":["A"],"deny":["D"],"ask":["K"]})));
        assert_eq!(p.allow, vec!["A"]);
        assert_eq!(p.deny, vec!["D"]);
        assert_eq!(p.ask, vec!["K"]);
        assert_eq!(
            normalize_permissions(Some(&json!(42))),
            PermissionConfig::default()
        );
    }

    #[test]
    fn load_settings_reads_flat_and_migrates_old_env() {
        let dir = std::env::temp_dir().join(format!("deepdive-cfg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        // old format: app setting living in env, plus a genuine env var.
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&json!({
                "env": { "DEEPSEEK_MODEL": "deepseek-v4-flash", "DEEPSEEK_API_KEY": "k123" },
                "permissions": { "allow": ["Bash(ls:*)"], "deny": [], "ask": [] }
            }))
            .unwrap(),
        )
        .unwrap();

        let s = load_settings_from(&path);
        // migrated DEEPSEEK_MODEL → flat "model"
        assert_eq!(
            s.flat.get("model").and_then(Value::as_str),
            Some("deepseek-v4-flash")
        );
        // genuine env kept
        assert_eq!(
            s.env.get("DEEPSEEK_API_KEY").map(String::as_str),
            Some("k123")
        );
        // model no longer in env
        assert!(!s.env.contains_key("DEEPSEEK_MODEL"));
        assert_eq!(s.permissions.allow, vec!["Bash(ls:*)"]);

        // file was rewritten with the migration persisted
        let rewritten: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(rewritten["model"], "deepseek-v4-flash");
        assert!(rewritten["env"].get("DEEPSEEK_MODEL").is_none());
    }
}
