//! Query-time memory recall. Port of the TS `src/memory/recall.ts`.
//!
//! Before a user turn, scan topic-file headers and ask a fast model to pick the
//! few clearly relevant to the query, then inject their contents as a
//! `<system-reminder>` so the main model has them without spending a turn on
//! grep. MEMORY.md (the index) is already in the system prompt, so it's excluded.

use crate::config::Config;
use crate::memory::paths::{is_auto_memory_enabled, memory_dir};
use crate::memory::scan::{format_memory_manifest, scan_memory_files, MemoryHeader};
use crate::types::Message;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::PathBuf;

const RECALL_MARKER: &str = "<deepdive-memory-recall>";
/// Per-file content cap so a huge topic file can't blow up the turn.
const MAX_RECALL_FILE_BYTES: usize = 4_000;

#[derive(Debug, Clone)]
pub struct RelevantMemory {
    pub path: PathBuf,
    pub mtime_ms: u128,
}

const SELECT_SYSTEM_PROMPT: &str = "You are selecting memories that will be useful to a coding agent as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.\n\nReturn the filenames of the memories that will clearly be useful (up to 5). Only include memories you are certain will help based on their name and description.\n- If you are unsure whether a memory will be useful, do not include it. Be selective.\n- If none would clearly help, return an empty list.\n- If a list of recently-used tools is provided, do not select memories that are usage reference or API docs for those tools. DO still select memories with warnings, gotchas, or known issues about those tools.\n\nOutput ONLY a JSON object: {\"selected_memories\": [\"file1.md\", \"file2.md\"]}";

/// Find topic files relevant to `query` (up to 5). Best-effort — any error or an
/// empty memory dir yields `[]`. `already_surfaced` drops files injected in
/// prior turns so the selector spends its budget on fresh candidates.
pub async fn find_relevant_memories(
    client: &reqwest::Client,
    config: &Config,
    query: &str,
    recent_tools: &[String],
    already_surfaced: &HashSet<PathBuf>,
) -> Vec<RelevantMemory> {
    if !is_auto_memory_enabled() || query.trim().is_empty() {
        return Vec::new();
    }
    let memories: Vec<MemoryHeader> = scan_memory_files(&memory_dir())
        .into_iter()
        .filter(|m| !already_surfaced.contains(&m.file_path))
        .collect();
    if memories.is_empty() {
        return Vec::new();
    }

    let selected = select_relevant_memories(client, config, query, &memories, recent_tools).await;
    memories
        .into_iter()
        .filter(|m| selected.contains(&m.filename))
        .map(|m| RelevantMemory {
            path: m.file_path,
            mtime_ms: m.mtime_ms,
        })
        .collect()
}

async fn select_relevant_memories(
    client: &reqwest::Client,
    config: &Config,
    query: &str,
    memories: &[MemoryHeader],
    recent_tools: &[String],
) -> HashSet<String> {
    let valid: HashSet<String> = memories.iter().map(|m| m.filename.clone()).collect();
    let manifest = format_memory_manifest(memories);
    let tools_section = if recent_tools.is_empty() {
        String::new()
    } else {
        format!("\n\nRecently used tools: {}", recent_tools.join(", "))
    };

    let body = json!({
        "model": "deepseek-v4-flash",
        "messages": [
            { "role": "system", "content": SELECT_SYSTEM_PROMPT },
            { "role": "user", "content": format!("Query: {query}\n\nAvailable memories:\n{manifest}{tools_section}") }
        ],
        "max_tokens": 256,
        "temperature": 0,
        "stream": false,
        "thinking": { "type": "disabled" },
        "response_format": { "type": "json_object" }
    });

    let resp = client
        .post(format!("{}/chat/completions", config.base_url))
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", config.api_key))
        .body(body.to_string())
        .send()
        .await;
    let Ok(resp) = resp else { return HashSet::new() };
    if !resp.status().is_success() {
        return HashSet::new();
    }
    let Ok(data) = resp.json::<Value>().await else {
        return HashSet::new();
    };
    let text = data
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(Value::as_str)
        .unwrap_or("");
    parse_selected(text, &valid)
}

/// Parse `{"selected_memories":[...]}`; fall back to any known filename in text.
fn parse_selected(text: &str, valid: &HashSet<String>) -> HashSet<String> {
    if let Ok(parsed) = serde_json::from_str::<Value>(text) {
        if let Some(arr) = parsed.get("selected_memories").and_then(Value::as_array) {
            return arr
                .iter()
                .filter_map(Value::as_str)
                .filter(|s| valid.contains(*s))
                .map(String::from)
                .collect();
        }
    }
    valid.iter().filter(|n| text.contains(*n)).cloned().collect()
}

/// Build a `<system-reminder>` meta message injecting the recalled memories'
/// contents, or `None` if none. Marked `meta` so persistence-only fields are
/// stripped but the message still reaches the model.
pub fn make_recall_message(memories: &[RelevantMemory]) -> Option<Message> {
    if memories.is_empty() {
        return None;
    }
    let mut blocks: Vec<String> = Vec::new();
    for m in memories {
        let Ok(mut content) = std::fs::read_to_string(&m.path) else {
            continue;
        };
        if content.len() > MAX_RECALL_FILE_BYTES {
            // char-boundary-safe truncation near the byte cap.
            let mut cut = MAX_RECALL_FILE_BYTES;
            while cut > 0 && !content.is_char_boundary(cut) {
                cut -= 1;
            }
            content.truncate(cut);
            content.push_str("\n… (truncated)");
        }
        let name = m
            .path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| m.path.to_string_lossy().into_owned());
        blocks.push(format!("## {name}\n{}", content.trim()));
    }
    if blocks.is_empty() {
        return None;
    }

    let mut msg = Message::user(format!(
        "<system-reminder>\n{RECALL_MARKER}\nThe following memories from past sessions may be relevant to this request. They reflect what was true when written — verify against current state before relying on them.\n\n{}\n</deepdive-memory-recall>\n</system-reminder>",
        blocks.join("\n\n")
    ));
    msg.meta = true;
    Some(msg)
}

pub fn is_memory_recall_message(msg: &Message) -> bool {
    msg.role == crate::types::Role::User && msg.meta && msg.content.contains(RECALL_MARKER)
}
