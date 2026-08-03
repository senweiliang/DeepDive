//! DeepSeek client — the streaming `chat()` round-trip. P0 vertical slice of
//! `src/client.ts`: build the request body, POST it, and turn the SSE response
//! into a `Stream<StreamChunk>` via [`crate::sse::SseDecoder`], with
//! cancellation by dropping the byte stream.
//!
//! P1 will add: the full env/language/project system-prompt sections, the
//! `ALL_TOOLS` verbatim-JSON tool schema (prefix-cache-stable), turn-summary /
//! compaction slicing, listings, and `summarize()`.

use crate::agents::listing::is_agent_listing_message;
use crate::config::{language_label, Config};
use crate::session::is_compact_summary_message;
use crate::skills::is_skill_listing_message;
use crate::sse::SseDecoder;
use crate::turn_summary::apply_turn_summaries;
use crate::types::{strip_non_api_fields, ApiMessage, Message, Role, StreamChunk};
use anyhow::{anyhow, Result};
use futures_util::{Stream, StreamExt};
use serde_json::Value;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio_util::sync::CancellationToken;

const SYSTEM_PROMPT: &str = include_str!("../assets/base.md");

/// Compaction instruction appended to history before summarizing (the user turn
/// that asks the model to summarize the whole conversation). Port of the TS
/// `COMPACT_INSTRUCTION` (prompts/compact.md).
pub const COMPACT_INSTRUCTION: &str = include_str!("../assets/compact.md");

// ── date context (client.ts localDate/sessionDate) ───────────────────────────

static SESSION_DATE: OnceLock<String> = OnceLock::new();

/// Local calendar date as `YYYY-MM-DD`. `DEEPDIVE_OVERRIDE_DATE` wins (used by
/// tests and `--date`), else the OS local date. Port of client.ts `localDate`.
fn local_date() -> String {
    if let Ok(o) = std::env::var("DEEPDIVE_OVERRIDE_DATE") {
        if !o.is_empty() {
            return o;
        }
    }
    let (y, m, d) = today_ymd();
    format!("{y:04}-{m:02}-{d:02}")
}

/// Date frozen at first call (≈ session start), kept byte-identical across turns
/// so the cached system-prompt prefix never invalidates. Port of `sessionDate`.
fn session_date() -> String {
    SESSION_DATE.get_or_init(local_date).clone()
}

/// One-off "the date changed" reminder for the loop to splice into history at a
/// midnight rollover (the prefix stays frozen; the new date rides a trailing
/// meta message). Returns `None` until the local date moves past the frozen one.
/// Port of client.ts `dateChangeMessage`.
pub fn date_change_message() -> Option<Message> {
    let frozen = session_date();
    let now = local_date();
    if now == frozen {
        return None;
    }
    // Advance the frozen anchor so the reminder fires at most once per rollover.
    // (Best-effort: OnceLock can't be reset, so we track the last emitted date
    // in a second cell.)
    static LAST_EMITTED: OnceLock<std::sync::Mutex<String>> = OnceLock::new();
    let cell = LAST_EMITTED.get_or_init(|| std::sync::Mutex::new(frozen.clone()));
    {
        let mut last = cell.lock().unwrap();
        if *last == now {
            return None;
        }
        *last = now.clone();
    }
    let mut m = Message::user(format!(
        "<system-reminder>\nThe date has changed. Today's date is now {now}. \
         Do not mention this to the user explicitly — they already know.\n</system-reminder>"
    ));
    m.meta = true;
    Some(m)
}

#[cfg(unix)]
fn today_ymd() -> (i64, u32, u32) {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as libc::time_t)
        .unwrap_or(0);
    // localtime_r gives the OS-local broken-down time (matches node `new Date()`).
    unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&secs, &mut tm);
        ((tm.tm_year as i64) + 1900, (tm.tm_mon as u32) + 1, tm.tm_mday as u32)
    }
}

#[cfg(not(unix))]
fn today_ymd() -> (i64, u32, u32) {
    // UTC civil date (Howard Hinnant's algorithm). Windows fallback only.
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

// ── system-prompt sections (client.ts envInfo/languageInstruction/projectInstructions) ──

/// Map a Rust target OS to the node `process.platform` string the TS env block
/// uses, so the rendered system prompt matches the original wording.
fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

fn deepdive_home() -> String {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    let mut p = std::path::PathBuf::from(home);
    p.push(".deepdive");
    p.to_string_lossy().into_owned()
}

/// The `## Environment` section. Faithful port of client.ts `envInfo`.
fn env_info(config: &Config) -> String {
    let mut lines: Vec<String> = vec![
        String::new(),
        "## Environment".into(),
        String::new(),
        format!("- Today's date: {}", session_date()),
        format!("- Working directory: {}", config.cwd.display()),
    ];
    if !config.additional_directories.is_empty() {
        lines.push(format!(
            "- Additional working directories: {}",
            config.additional_directories.join(", ")
        ));
    }
    lines.push(format!("- Platform: {}", node_platform()));
    lines.push(format!(
        "- Shell: {}",
        std::env::var("COMSPEC").unwrap_or_else(|_| "bash".into())
    ));
    lines.push(format!("- DeepDive home directory: {}", deepdive_home()));
    lines.push(String::new());
    lines.push("File tools (`read_file`, `write_file`, `edit_file`) accept absolute paths, or paths relative to the working directory above. Paths outside the working directory are allowed but the user is asked to confirm each one, so prefer in-workspace paths unless the task clearly needs an outside file.".into());
    lines.push(String::new());
    lines.push("DeepDive stores its own data (settings, procedures, etc.) under the DeepDive home directory above.".into());
    lines.push(String::new());
    lines.join("\n")
}

/// The `# Language` section (verbatim Claude Code wording), emitted only when a
/// non-`auto` language is configured. Port of client.ts `languageInstruction`.
fn language_instruction(config: &Config) -> String {
    let label = match language_label(&config.response_language) {
        Some(l) if l != "auto" => l,
        _ => return String::new(),
    };
    [
        "".to_string(),
        "# Language".to_string(),
        format!(
            "Always respond in {label}. Use {label} for all explanations, comments, and \
             communications with the user. Technical terms and code identifiers should remain \
             in their original form."
        ),
        "".to_string(),
    ]
    .join("\n")
}

/// Inline the first present project-instructions file from the working
/// directory. Port of client.ts `projectInstructions`.
fn project_instructions(config: &Config) -> String {
    for name in ["AGENTS.md", "DEEPDIVE.md", "CLAUDE.md"] {
        let path = config.cwd.join(name);
        if let Ok(raw) = std::fs::read_to_string(&path) {
            let content = raw.trim();
            if !content.is_empty() {
                return format!("\n## Project Instructions ({name})\n\n{content}\n");
            }
        }
    }
    String::new()
}

// ── request assembly (client.ts sliceFromLastSummary/extractListings/buildBody) ──

/// Slice from the LAST compact summary forward, so raw history before the most
/// recent compaction never gets resent. The summary itself heads the slice.
/// Public so the engine's compaction preflight can size the request the same way.
pub fn slice_from_last_summary(messages: &[Message]) -> Vec<Message> {
    for i in (0..messages.len()).rev() {
        if is_compact_summary_message(&messages[i]) {
            return messages[i..].to_vec();
        }
    }
    messages.to_vec()
}

/// Pull the (first) skill- and agent-listing messages out of history; both sit
/// in the stable cache region right after the system message, so custom
/// agents/skills never invalidate the conversation prefix. All listing messages
/// are removed from `rest` (only the first of each kind is kept).
fn extract_listings(messages: &[Message]) -> (Option<Message>, Option<Message>, Vec<Message>) {
    let mut skill_listing: Option<Message> = None;
    let mut agent_listing: Option<Message> = None;
    let mut rest: Vec<Message> = Vec::new();
    for m in messages {
        if is_skill_listing_message(m) {
            if skill_listing.is_none() {
                skill_listing = Some(m.clone());
            }
            continue;
        }
        if is_agent_listing_message(m) {
            if agent_listing.is_none() {
                agent_listing = Some(m.clone());
            }
            continue;
        }
        rest.push(m.clone());
    }
    (skill_listing, agent_listing, rest)
}

/// Per-call overrides. Subagents run the SAME request pipeline with a scoped
/// tool set and their own persona prompt (mirrors client.ts `ChatOverrides`).
#[derive(Debug, Clone, Default)]
pub struct ChatOverrides {
    /// Replaces the base persona head (SYSTEM_PROMPT); env section still appended.
    pub system_prompt: Option<String>,
    /// Replaces ALL_TOOLS — e.g. a subagent's filtered subset (never sees `agent`).
    pub tools: Option<Vec<Value>>,
    /// Override the model for this turn (used by auto-model routing to send the
    /// per-message flash/pro pick). When `None`, `build_body` falls back to
    /// [`crate::config::resolve_model`]`(config.model)` — so the literal
    /// `"auto"` is never sent to the API. Port of the TS `ChatOverrides.model`.
    pub model: Option<String>,
}

fn build_system_message(config: &Config, base_prompt: &str, include_memory: bool) -> ApiMessage {
    // base persona + env + language + project sections (client.ts
    // buildSystemMessage). Frozen-at-session-start date keeps the prefix stable.
    // The memory section is main-agent-only: spawned subagents (which override
    // the persona) don't manage memory, so they skip it. The turn-end extraction
    // fork runs with NO persona override, so it correctly keeps the section.
    let memory_section = if include_memory {
        crate::memory::prompt::build_memory_section()
    } else {
        String::new()
    };
    let content = format!(
        "{base_prompt}{}{}{}{}",
        env_info(config),
        language_instruction(config),
        project_instructions(config),
        memory_section,
    );
    ApiMessage {
        role: Role::System,
        content,
        tool_calls: Vec::new(),
        tool_call_id: None,
        reasoning_content: None,
    }
}

fn build_body(config: &Config, messages: &[Message], overrides: &ChatOverrides) -> String {
    let base_prompt = overrides.system_prompt.as_deref().unwrap_or(SYSTEM_PROMPT);

    // Listings ride the stable cache region right after the system message;
    // the conversation body is sliced from the last compact summary and has
    // previous-turn summaries spliced in before stripping to wire shape.
    let (skill_listing, agent_listing, rest) = extract_listings(messages);
    let include_memory = overrides.system_prompt.is_none();
    let mut api_messages = vec![build_system_message(config, base_prompt, include_memory)];
    if let Some(s) = &skill_listing {
        api_messages.extend(strip_non_api_fields(std::slice::from_ref(s)));
    }
    if let Some(a) = &agent_listing {
        api_messages.extend(strip_non_api_fields(std::slice::from_ref(a)));
    }
    let sliced = slice_from_last_summary(&rest);
    let summarized = apply_turn_summaries(&sliced, config.turn_summary_strategy);
    api_messages.extend(strip_non_api_fields(&summarized));

    // Top-level key order doesn't affect DeepSeek's prefix cache (that's keyed
    // on tokenized messages, not the JSON envelope), so the default sorted Map
    // is fine. The cache-critical byte-stability is inside `messages`/`tools`.
    // Auto-model routing: a per-turn override (the flash/pro pick) wins; else
    // `resolve_model` maps the literal "auto" to Pro so it never hits the API.
    let model = overrides
        .model
        .clone()
        .unwrap_or_else(|| crate::config::resolve_model(&config.model).to_string());
    let mut obj = serde_json::Map::new();
    obj.insert("model".into(), Value::String(model));
    obj.insert(
        "messages".into(),
        serde_json::to_value(&api_messages).expect("ApiMessage is infallibly serializable"),
    );
    obj.insert("max_tokens".into(), Value::from(config.max_tokens));
    obj.insert("stream".into(), Value::Bool(true));

    // DeepSeek: non-thinking is `thinking.disabled`, NOT reasoning_effort:"none"
    // (that's a 400 unknown variant). client.ts:380-388.
    if config.reasoning_effort == "none" {
        obj.insert("thinking".into(), serde_json::json!({ "type": "disabled" }));
    } else {
        obj.insert(
            "reasoning_effort".into(),
            Value::String(config.reasoning_effort.clone()),
        );
    }
    // Tools: the verbatim ALL_TOOLS schema (byte-stable for prefix caching), or
    // a subagent's scoped subset when overridden. The main agent additionally
    // gets the connected MCP servers' tools, appended after ALL_TOOLS and frozen
    // for the session (so the array stays byte-stable across turns). Subagents
    // (overridden tool set) do not see MCP tools in v1.
    let tools = match overrides.tools.clone() {
        Some(subset) => subset,
        None => {
            let mut t = crate::tools::schema::ALL_TOOLS.clone();
            t.extend(config.mcp_tools.iter().cloned());
            t
        }
    };
    obj.insert("tools".into(), Value::Array(tools));

    Value::Object(obj).to_string()
}

/// Build the shared HTTP client. reqwest reads `HTTP_PROXY`/`HTTPS_PROXY`/
/// `ALL_PROXY`/`NO_PROXY` from the environment by default — the Rust equivalent
/// of the TS `undici` `EnvHttpProxyAgent`. Reuse one client across turns for
/// connection pooling.
///
/// No `timeout()` here: that would bound the whole response including a healthy
/// streaming body. The connect and idle phases are bounded separately in `net`.
pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(crate::net::CONNECT_TIMEOUT)
        .build()
        .expect("default reqwest client builds")
}

/// Stream one chat completion. Cancelling `cancel` ends the stream (dropping the
/// in-flight response); the caller (`assemble_turn`) treats that as an
/// interruption and keeps partial output.
pub fn chat(
    client: reqwest::Client,
    config: Config,
    messages: Vec<Message>,
    cancel: CancellationToken,
    overrides: ChatOverrides,
) -> impl Stream<Item = Result<StreamChunk>> {
    async_stream::try_stream! {
        let body = build_body(&config, &messages, &overrides);
        let url = format!("{}/chat/completions", config.base_url);

        let resp = crate::net::send_resilient(
            || {
                client
                    .post(&url)
                    .header("Content-Type", "application/json")
                    .header("Authorization", format!("Bearer {}", config.api_key))
                    .body(body.clone())
            },
            &cancel,
            "chat",
        )
        .await?;

        let status = resp.status();
        if !status.is_success() {
            // `resp.text()` consumes `resp`; keep it in this branch only so the
            // success path below still owns `resp` for `bytes_stream()`.
            let text = resp.text().await.unwrap_or_default();
            Err::<(), anyhow::Error>(anyhow!("API error {status}: {text}"))?;
        } else {
            let mut byte_stream = Box::pin(resp.bytes_stream());
            let mut decoder = SseDecoder::new();
            // `?` can't bubble out of a `tokio::select!` arm (the arm returns
            // `()`), so stash any transport error and propagate after the loop.
            let mut stream_err: Option<anyhow::Error> = None;
            loop {
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => break,
                    next = tokio::time::timeout(crate::net::IDLE_TIMEOUT, byte_stream.next()) => {
                        match next {
                            Ok(Some(Ok(bytes))) => {
                                for chunk in decoder.feed(&bytes) {
                                    yield chunk;
                                }
                            }
                            Ok(Some(Err(e))) => { stream_err = Some(anyhow!(e)); break; }
                            Ok(None) => break,
                            Err(_elapsed) => {
                                stream_err = Some(anyhow!(
                                    "Stream idle for {}s — no data from server",
                                    crate::net::IDLE_TIMEOUT.as_secs()
                                ));
                                break;
                            }
                        }
                    }
                }
            }
            if let Some(e) = stream_err {
                Err::<(), anyhow::Error>(e)?;
            }
        }
    }
}

/// Summarize a message list into plain text — the engine behind compaction and
/// previous-turn summaries. Non-streaming, sends NO system prompt and NO tools:
/// just the sliced / summarized / stripped conversation. The caller appends the
/// instruction (COMPACT_INSTRUCTION, or `build_turn_summary_request`) before
/// calling. Port of client.ts `summarize`.
pub async fn summarize(
    client: &reqwest::Client,
    config: &Config,
    messages: &[Message],
    cancel: &CancellationToken,
) -> Result<String> {
    // resolve_model so a session on `model: "auto"` summarizes/compacts with Pro
    // instead of sending the literal "auto" (parity with TS `resolveModel`).
    let base = if config.summary_model.is_empty() {
        &config.model
    } else {
        &config.summary_model
    };
    let model = crate::config::resolve_model(base).to_string();
    let sliced = slice_from_last_summary(messages);
    let summarized = apply_turn_summaries(&sliced, config.turn_summary_strategy);
    let api_messages = strip_non_api_fields(&summarized);
    let messages_value =
        serde_json::to_value(&api_messages).expect("ApiMessage is infallibly serializable");

    let body = serde_json::json!({
        "model": model,
        "messages": messages_value,
        "max_tokens": 4000,
        "reasoning_effort": "low",
        "stream": false,
    })
    .to_string();

    let url = format!("{}/chat/completions", config.base_url);
    let resp = crate::net::send_resilient(
        || {
            client
                .post(&url)
                .header("Content-Type", "application/json")
                .header("Authorization", format!("Bearer {}", config.api_key))
                .body(body.clone())
        },
        cancel,
        "summarize",
    )
    .await?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("Summarize API error {status}: {text}"));
    }
    let json: Value = resp.json().await?;
    Ok(json
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> Config {
        Config {
            api_key: "k".into(),
            base_url: "https://example.invalid".into(),
            model: "deepseek-v4-pro".into(),
            max_tokens: 32_000,
            reasoning_effort: "high".into(),
            cwd: std::path::PathBuf::from("/tmp/work"),
            ..Default::default()
        }
    }

    #[test]
    fn body_has_model_messages_and_reasoning_effort() {
        let body = build_body(&cfg(), &[Message::user("hi")], &ChatOverrides::default());
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["model"], "deepseek-v4-pro");
        assert_eq!(v["stream"], true);
        assert_eq!(v["reasoning_effort"], "high");
        assert!(v.get("thinking").is_none());
        // system message first, then the user message
        let msgs = v["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "system");
        assert!(msgs[0]["content"].as_str().unwrap().contains("/tmp/work"));
        assert_eq!(msgs[1]["role"], "user");
        assert_eq!(msgs[1]["content"], "hi");
    }

    #[test]
    fn auto_model_resolves_to_pro_unless_overridden() {
        // A session on `model: "auto"` must never send the literal "auto" — the
        // no-override path resolves it to Pro (compaction/summary/subagents).
        let mut c = cfg();
        c.model = "auto".into();
        let body = build_body(&c, &[Message::user("hi")], &ChatOverrides::default());
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["model"], "deepseek-v4-pro");

        // A per-turn override (the router's flash/pro pick) wins verbatim.
        let ov = ChatOverrides {
            model: Some("deepseek-v4-flash".into()),
            ..Default::default()
        };
        let body2 = build_body(&c, &[Message::user("hi")], &ov);
        let v2: Value = serde_json::from_str(&body2).unwrap();
        assert_eq!(v2["model"], "deepseek-v4-flash");
    }

    #[test]
    fn non_thinking_mode_uses_thinking_disabled() {
        let mut c = cfg();
        c.reasoning_effort = "none".into();
        let body = build_body(&c, &[Message::user("hi")], &ChatOverrides::default());
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["thinking"]["type"], "disabled");
        assert!(v.get("reasoning_effort").is_none());
    }

    fn skill_listing_msg() -> Message {
        let mut m = Message::user(format!(
            "<system-reminder>\n{}\nskills here\n</system-reminder>",
            crate::skills::SKILL_LISTING_MARKER
        ));
        m.meta = true;
        m
    }
    fn agent_listing_msg() -> Message {
        let mut m = Message::user(format!(
            "<system-reminder>\n{}\nagents here\n</system-reminder>",
            crate::agents::listing::AGENT_LISTING_MARKER
        ));
        m.meta = true;
        m
    }

    #[test]
    fn listings_sit_right_after_system_in_order() {
        // History order is user-first; listings must be hoisted to just after
        // the system message (stable cache region), skill before agent.
        let history = vec![
            Message::user("hi"),
            agent_listing_msg(),
            skill_listing_msg(),
        ];
        let body = build_body(&cfg(), &history, &ChatOverrides::default());
        let v: Value = serde_json::from_str(&body).unwrap();
        let msgs = v["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "system");
        assert!(msgs[1]["content"]
            .as_str()
            .unwrap()
            .contains(crate::skills::SKILL_LISTING_MARKER));
        assert!(msgs[2]["content"]
            .as_str()
            .unwrap()
            .contains(crate::agents::listing::AGENT_LISTING_MARKER));
        assert_eq!(msgs[3]["role"], "user");
        assert_eq!(msgs[3]["content"], "hi");
        assert_eq!(msgs.len(), 4);
    }

    #[test]
    fn body_slices_from_last_compact_summary() {
        let summary = crate::session::make_summary_message("earlier work");
        let history = vec![
            Message::user("ancient"),
            Message::assistant("old reply"),
            summary,
            Message::user("now"),
        ];
        let body = build_body(&cfg(), &history, &ChatOverrides::default());
        let v: Value = serde_json::from_str(&body).unwrap();
        let msgs = v["messages"].as_array().unwrap();
        // system, summary, "now" — the pre-summary raw turns are dropped.
        assert_eq!(msgs.len(), 3);
        assert!(msgs[1]["content"]
            .as_str()
            .unwrap()
            .starts_with(crate::session::COMPACT_SUMMARY_PREFIX));
        assert_eq!(msgs[2]["content"], "now");
    }

    #[test]
    fn language_section_emitted_only_when_set() {
        let mut c = cfg();
        c.response_language = "zh".into();
        let body = build_body(&c, &[Message::user("hi")], &ChatOverrides::default());
        let v: Value = serde_json::from_str(&body).unwrap();
        let sys = v["messages"][0]["content"].as_str().unwrap();
        // "Always respond in …" is unique to the injected language section
        // (base.md only has a generic "## Language" heading).
        assert!(sys.contains("Always respond in 简体中文"));

        // auto (default) → no injected language directive
        let body2 = build_body(&cfg(), &[Message::user("hi")], &ChatOverrides::default());
        let v2: Value = serde_json::from_str(&body2).unwrap();
        assert!(!v2["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("Always respond in"));
    }

    #[test]
    fn overrides_scope_tools_and_persona() {
        let ov = ChatOverrides {
            system_prompt: Some("PERSONA".into()),
            tools: Some(vec![serde_json::json!({
                "type": "function",
                "function": { "name": "only_tool" }
            })]),
            model: None,
        };
        let body = build_body(&cfg(), &[Message::user("hi")], &ov);
        let v: Value = serde_json::from_str(&body).unwrap();
        let tools = v["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["function"]["name"], "only_tool");
        assert!(v["messages"][0]["content"]
            .as_str()
            .unwrap()
            .starts_with("PERSONA"));
    }
}
