//! Session persistence (JSONL). Faithful port of the core of `src/session.ts`.
//!
//! Ported now: the **DJB2 `sanitize_path`** (parity-critical — changing it would
//! orphan existing sessions), the compact-summary helpers, the dangling
//! head/tail trims, project/session path computation, and append/load round-trip.
//! Deferred to a later batch: the progressive picker listing + tail-read title
//! extraction (UI affordance) and `append_compact` timestamps.

use crate::types::{Message, Role, Usage};
use crate::workspace::original_cwd;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const COMPACT_SUMMARY_PREFIX: &str = "<previous-conversation-summary>\n";
pub const COMPACT_SUMMARY_SUFFIX: &str = "\n</previous-conversation-summary>";
const MAX_SANITIZED_LENGTH: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionMeta {
    pub id: String,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    pub cwd: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// DJB2 hash (32-bit, matching JS `((h<<5)+h+c)|0` then `>>>0`), over UTF-16
/// code units (JS `charCodeAt`).
fn djb2(s: &str) -> u32 {
    let mut hash: i32 = 5381;
    for u in s.encode_utf16() {
        hash = hash
            .wrapping_shl(5)
            .wrapping_add(hash)
            .wrapping_add(u as i32);
    }
    hash as u32
}

/// Sanitize an absolute path into a filesystem-safe directory name. Every
/// non-`[a-zA-Z0-9]` character becomes `-`; paths over 200 chars are truncated
/// with an 8-hex DJB2 suffix. MUST stay byte-identical to the TS version.
pub fn sanitize_path(path: &str) -> String {
    let sanitized: String = path
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    if sanitized.len() <= MAX_SANITIZED_LENGTH {
        return sanitized;
    }
    format!("{}-{:08x}", &sanitized[..MAX_SANITIZED_LENGTH], djb2(path))
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default()
}

fn projects_dir() -> PathBuf {
    home().join(".deepdive").join("projects")
}

fn project_dir(cwd: &str) -> PathBuf {
    projects_dir().join(sanitize_path(cwd))
}

/// The per-project data directory (`~/.deepdive/projects/<sanitized-cwd>/`) for
/// the current working directory. Session JSONL files and the auto-memory
/// directory both live under here. Exported so the memory subsystem derives its
/// directory from the same project key the session store uses.
pub fn get_project_dir() -> PathBuf {
    project_dir(&original_cwd().to_string_lossy())
}

pub fn session_path(id: &str) -> PathBuf {
    project_dir(&original_cwd().to_string_lossy()).join(format!("{id}.jsonl"))
}

pub fn new_session_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn make_summary_message(summary: &str) -> Message {
    Message::user(format!(
        "{COMPACT_SUMMARY_PREFIX}{summary}{COMPACT_SUMMARY_SUFFIX}"
    ))
}

pub fn is_compact_summary_message(msg: &Message) -> bool {
    msg.role == Role::User && msg.content.starts_with(COMPACT_SUMMARY_PREFIX)
}

/// Drop a trailing assistant message that has tool_calls with no following tool
/// results (crashed mid-turn) — the API rejects tool_calls without responses.
pub fn trim_dangling_tail(messages: &[Message]) -> Vec<Message> {
    if let Some(last) = messages.last() {
        if last.role == Role::Assistant && !last.tool_calls.is_empty() {
            return messages[..messages.len() - 1].to_vec();
        }
    }
    messages.to_vec()
}

/// Drop leading messages that would be API-invalid without their counterpart:
/// a bare tool result, or an assistant whose tool results aren't all present.
pub fn trim_dangling_head(messages: &[Message]) -> Vec<Message> {
    let mut start = 0;
    'outer: while start < messages.len() {
        let first = &messages[start];
        if first.role == Role::Tool {
            start += 1;
            continue;
        }
        if first.role == Role::Assistant && !first.tool_calls.is_empty() {
            let expected: std::collections::HashSet<&str> =
                first.tool_calls.iter().map(|t| t.id.as_str()).collect();
            let mut found = std::collections::HashSet::new();
            for m in &messages[start + 1..] {
                if m.role != Role::Tool {
                    break;
                }
                if let Some(id) = &m.tool_call_id {
                    if expected.contains(id.as_str()) {
                        found.insert(id.as_str());
                    }
                }
            }
            if found.len() == expected.len() {
                break 'outer;
            }
            start += 1;
            continue;
        }
        break;
    }
    messages[start..].to_vec()
}

pub fn build_compacted_messages(summary: &str, recent: &[Message]) -> Vec<Message> {
    let mut out = vec![make_summary_message(summary)];
    out.extend(trim_dangling_head(recent));
    out
}

// ── persistence (JSONL) ──────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct LoadedSession {
    pub meta: Option<SessionMeta>,
    pub messages: Vec<Message>,
    pub usage: Option<Usage>,
}

/// Append a message line to the session file (best-effort; never panics).
pub fn append_message(id: &str, msg: &Message) {
    append_message_to(&session_path(id), msg);
}

fn append_message_to(path: &Path, msg: &Message) {
    if let Ok(mut value) = serde_json::to_value(msg) {
        if let Some(o) = value.as_object_mut() {
            o.insert("type".into(), serde_json::Value::String("msg".into()));
        }
        append_value_to(path, &value);
    }
}

/// Append one JSONL line (best-effort; never panics). Shared by the msg/compact/
/// meta writers.
fn append_value_to(path: &Path, value: &serde_json::Value) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let line = format!("{value}\n");
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = f.write_all(line.as_bytes());
    }
}

/// Append a `{type:"compact"}` summary event. On resume `load_session` turns it
/// back into a `make_summary_message`. Port of session.ts `appendCompact` — the
/// summary is persisted ONCE here, not as a regular `{type:"msg"}` row (the
/// engine advances its persist cursor past it).
pub fn append_compact(id: &str, summary: &str) {
    append_compact_to(&session_path(id), summary);
}

fn append_compact_to(path: &Path, summary: &str) {
    append_value_to(
        path,
        &serde_json::json!({ "type": "compact", "summary": summary }),
    );
}

/// Write the session header (`{type:"meta"}`). The first meta is the base;
/// later metas patch fields (e.g. `title`) — `load_session` merges them.
pub fn append_session_meta(id: &str, meta: &SessionMeta) {
    append_session_meta_to(&session_path(id), meta);
}

/// Append a title-only meta patch (TS `updateSessionTitle`). `load_session`
/// merges it onto the base header so the picker shows the new title.
pub fn update_session_title(id: &str, title: &str) {
    update_session_title_to(&session_path(id), title);
}

fn update_session_title_to(path: &Path, title: &str) {
    // Mirror TS `updateSessionTitle`: skip when the file doesn't exist yet, so a
    // rename on a not-yet-flushed session writes nothing (no phantom file with a
    // lone title-only meta, which would surface in the picker and get clobbered
    // by the later base-meta `title:None` on bootstrap).
    if !path.exists() {
        return;
    }
    append_value_to(path, &serde_json::json!({ "type": "meta", "title": title }));
}

fn append_session_meta_to(path: &Path, meta: &SessionMeta) {
    if let Ok(mut value) = serde_json::to_value(meta) {
        if let Some(o) = value.as_object_mut() {
            o.insert("type".into(), serde_json::Value::String("meta".into()));
        }
        append_value_to(path, &value);
    }
}

pub fn load_session(id: &str) -> Option<LoadedSession> {
    load_session_from(&session_path(id))
}

fn load_session_from(path: &Path) -> Option<LoadedSession> {
    let raw = std::fs::read_to_string(path).ok()?;
    let mut meta: Option<SessionMeta> = None;
    let mut usage: Option<Usage> = None;
    let mut messages: Vec<Message> = Vec::new();

    for line in raw.split('\n').filter(|l| !l.is_empty()) {
        let Ok(obj) = serde_json::from_str::<serde_json::Value>(line) else {
            continue; // skip malformed line
        };
        match obj.get("type").and_then(|v| v.as_str()) {
            Some("meta") => {
                // first meta = base; later metas patch fields (e.g. title).
                if meta.is_none() {
                    meta = serde_json::from_value::<SessionMeta>(obj.clone()).ok();
                } else if let Some(t) = obj.get("title").and_then(|v| v.as_str()) {
                    if let Some(m) = meta.as_mut() {
                        m.title = Some(t.to_string());
                    }
                }
            }
            Some("msg") => {
                if let Ok(msg) = serde_json::from_value::<Message>(obj) {
                    if let Some(u) = &msg.usage {
                        usage = Some(u.clone());
                    }
                    messages.push(msg);
                }
            }
            Some("compact") => {
                let summary = obj.get("summary").and_then(|v| v.as_str()).unwrap_or("");
                messages.push(make_summary_message(summary));
            }
            _ => {}
        }
    }

    let messages = trim_dangling_tail(&trim_dangling_head(&messages));
    Some(LoadedSession {
        meta,
        messages,
        usage,
    })
}

// ── listing / resume ─────────────────────────────────────────────────────────

/// One on-disk session for the current project, for `--resume` / a picker.
#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub id: String,
    pub path: PathBuf,
    pub modified: std::time::SystemTime,
}

/// Sessions for the current project (cwd), most-recently-modified first.
pub fn list_sessions() -> Vec<SessionInfo> {
    list_sessions_in(&project_dir(&original_cwd().to_string_lossy()))
}

fn list_sessions_in(dir: &Path) -> Vec<SessionInfo> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(String::from) else {
                continue;
            };
            if id.is_empty() {
                continue;
            }
            let modified = e
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            out.push(SessionInfo { id, path, modified });
        }
    }
    out.sort_by_key(|s| std::cmp::Reverse(s.modified));
    out
}

/// The id of the most recently modified session for this project, if any.
pub fn latest_session_id() -> Option<String> {
    list_sessions().into_iter().next().map(|s| s.id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{FunctionCall, ToolCall};

    fn tc(id: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            kind: "function".into(),
            function: FunctionCall {
                name: "read_file".into(),
                arguments: "{}".into(),
            },
        }
    }
    fn assistant_with_tools(ids: &[&str]) -> Message {
        let mut m = Message::assistant("");
        m.tool_calls = ids.iter().map(|i| tc(i)).collect();
        m
    }

    #[test]
    fn sanitize_short_path_no_hash() {
        assert_eq!(sanitize_path("/home/user/foo"), "-home-user-foo");
        assert_eq!(sanitize_path("D:\\code\\DeepDive"), "D--code-DeepDive");
    }

    #[test]
    fn sanitize_long_path_has_hash_suffix() {
        let long = "/".to_string() + &"a".repeat(250);
        let s = sanitize_path(&long);
        assert_eq!(s.len(), MAX_SANITIZED_LENGTH + 1 + 8); // 200 + '-' + 8 hex
                                                           // exact suffix verified against the TS sanitizePath (node) for parity —
                                                           // this is the value that keeps existing on-disk sessions findable.
        assert_eq!(&s[MAX_SANITIZED_LENGTH + 1..], "dddf142e");
    }

    #[test]
    fn djb2_is_deterministic_and_known() {
        // anchored against the JS algorithm: ((h<<5)+h+c)|0 then >>>0
        assert_eq!(djb2(""), 5381);
        assert_eq!(djb2("a"), 177670);
    }

    #[test]
    fn compact_summary_round_trip() {
        let m = make_summary_message("did stuff");
        assert!(is_compact_summary_message(&m));
        assert!(m.content.starts_with(COMPACT_SUMMARY_PREFIX));
        assert!(m.content.ends_with(COMPACT_SUMMARY_SUFFIX));
        assert!(!is_compact_summary_message(&Message::user("normal")));
    }

    #[test]
    fn trim_tail_drops_dangling_assistant_tool_calls() {
        let msgs = vec![Message::user("hi"), assistant_with_tools(&["c1"])];
        let out = trim_dangling_tail(&msgs);
        assert_eq!(out.len(), 1);
        // a complete turn is untouched
        let complete = vec![
            Message::user("hi"),
            assistant_with_tools(&["c1"]),
            Message::tool("c1", "result"),
        ];
        assert_eq!(trim_dangling_tail(&complete).len(), 3);
    }

    #[test]
    fn trim_head_drops_orphan_tool_and_incomplete_assistant() {
        // leading bare tool result is dropped
        let msgs = vec![Message::tool("x", "r"), Message::user("hi")];
        assert_eq!(trim_dangling_head(&msgs)[0].role, Role::User);

        // assistant whose tool results are all present is kept
        let kept = vec![
            assistant_with_tools(&["c1"]),
            Message::tool("c1", "r"),
            Message::user("next"),
        ];
        assert_eq!(trim_dangling_head(&kept).len(), 3);

        // assistant missing its tool result is dropped from the head
        let dropped = vec![assistant_with_tools(&["c1"]), Message::user("next")];
        assert_eq!(trim_dangling_head(&dropped).len(), 1);
        assert_eq!(trim_dangling_head(&dropped)[0].role, Role::User);
    }

    #[test]
    fn list_sessions_filters_jsonl_and_handles_missing_dir() {
        let dir = std::env::temp_dir().join(format!("deepdive-list-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("aaa.jsonl"), "{}\n").unwrap();
        std::fs::write(dir.join("bbb.jsonl"), "{}\n").unwrap();
        std::fs::write(dir.join("notes.txt"), "ignore").unwrap();
        let list = list_sessions_in(&dir);
        assert_eq!(list.len(), 2);
        let ids: std::collections::HashSet<&str> = list.iter().map(|s| s.id.as_str()).collect();
        assert!(ids.contains("aaa") && ids.contains("bbb"));
        // missing dir → empty, no panic
        assert!(list_sessions_in(&dir.join("nope")).is_empty());
    }

    #[test]
    fn compact_and_meta_round_trip_single_line() {
        let dir = std::env::temp_dir().join(format!("deepdive-compact-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("c1.jsonl");
        let _ = std::fs::remove_file(&path);

        append_session_meta_to(
            &path,
            &SessionMeta {
                id: "c1".into(),
                started_at: "t0".into(),
                cwd: "/x".into(),
                model: "deepseek-v4-pro".into(),
                title: None,
            },
        );
        append_message_to(&path, &Message::user("hi"));
        append_compact_to(&path, "did stuff");

        let loaded = load_session_from(&path).unwrap();
        assert_eq!(loaded.meta.unwrap().id, "c1");
        // The compact event is reconstituted as a summary message.
        assert!(loaded
            .messages
            .iter()
            .any(|m| is_compact_summary_message(m) && m.content.contains("did stuff")));
        // Persisted exactly once as a compact line (never duplicated as a msg).
        let raw = std::fs::read_to_string(&path).unwrap();
        assert_eq!(raw.matches("\"type\":\"compact\"").count(), 1);
        assert_eq!(raw.matches("\"type\":\"meta\"").count(), 1);
    }

    #[test]
    fn title_patch_merges_onto_base_meta() {
        let dir = std::env::temp_dir().join(format!("deepdive-title-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t1.jsonl");
        let _ = std::fs::remove_file(&path);

        append_session_meta_to(
            &path,
            &SessionMeta {
                id: "t1".into(),
                started_at: "t0".into(),
                cwd: "/x".into(),
                model: "deepseek-v4-pro".into(),
                title: None,
            },
        );
        append_message_to(&path, &Message::user("hi"));
        update_session_title_to(&path, "重构鉴权");

        let loaded = load_session_from(&path).unwrap();
        let meta = loaded.meta.unwrap();
        assert_eq!(meta.id, "t1"); // base preserved
        assert_eq!(meta.title.as_deref(), Some("重构鉴权")); // patch applied
    }

    #[test]
    fn title_patch_skipped_when_file_missing() {
        // Renaming a not-yet-flushed session must NOT create a phantom file with
        // a lone title-only meta (it would surface in the picker / get clobbered).
        let dir = std::env::temp_dir().join(format!("deepdive-notitle-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ghost.jsonl");
        let _ = std::fs::remove_file(&path);
        update_session_title_to(&path, "should-not-write");
        assert!(!path.exists());
    }

    #[test]
    fn append_and_load_round_trip() {
        let dir = std::env::temp_dir().join(format!("deepdive-sess-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s1.jsonl");
        let _ = std::fs::remove_file(&path);

        append_message_to(&path, &Message::user("hello"));
        let mut a = Message::assistant("hi there");
        a.usage = Some(Usage {
            input_tokens: 10,
            output_tokens: 5,
            ..Default::default()
        });
        append_message_to(&path, &a);

        let loaded = load_session_from(&path).unwrap();
        assert_eq!(loaded.messages.len(), 2);
        assert_eq!(loaded.messages[0].content, "hello");
        assert_eq!(loaded.messages[1].content, "hi there");
        assert_eq!(loaded.usage.unwrap().input_tokens, 10);
        // UI-only `type` tag must not leak into the loaded Message content
        assert_eq!(loaded.messages[1].role, Role::Assistant);
    }
}
