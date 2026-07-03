//! Background memory extraction. Port of the TS `src/memory/extract.ts`.
//!
//! Runs once at the end of a query loop (final assistant message, no tool
//! calls). A forked agent re-reads the recent conversation and writes durable
//! memories the main agent didn't. Best-effort catch net: when the MAIN agent
//! already wrote to memory this turn (`has_memory_writes_since`), extraction is
//! skipped — the two are mutually exclusive per turn.
//!
//! The fork's tools are scoped to read/search + writes INSIDE the memory dir
//! only (`gate_extraction_tool`); everything else is denied.

use crate::client::ChatOverrides;
use crate::config::Config;
use crate::memory::paths::{
    is_auto_mem_path, is_auto_memory_enabled, memory_dir, ENTRYPOINT_NAME,
};
use crate::memory::scan::{format_memory_manifest, scan_memory_files};
use crate::memory::types::{
    memory_frontmatter_example, TYPES_SECTION, WHAT_NOT_TO_SAVE_SECTION,
};
use crate::tools::bash::{execute_bash, BashOptions};
use crate::tools::executor::execute;
use crate::tools::permissions::is_read_only_command;
use crate::tools::schema::{tool_name, ALL_TOOLS};
use crate::turn::stream_turn;
use crate::types::{Message, Role};
use crate::workspace::original_cwd;
use serde_json::Value;
use std::path::Path;
use tokio_util::sync::CancellationToken;

/// Well-behaved extractions finish in 2-4 turns (read → write); cap the rest.
const MAX_EXTRACTION_TURNS: u32 = 5;

const EXTRACTION_TOOL_NAMES: &[&str] =
    &["read_file", "grep", "glob", "bash", "write_file", "edit_file"];

pub struct ExtractionResult {
    /// Topic files written this run (excludes MEMORY.md index touches).
    pub written_paths: Vec<String>,
    pub turns: u32,
    /// Skipped because the main agent already wrote memory this turn.
    pub skipped: bool,
}

/// Did any assistant message write to a memory-dir path? If so, the main agent
/// already saved this turn and the fork is redundant.
pub fn has_memory_writes_since(messages: &[Message]) -> bool {
    for m in messages {
        if m.role != Role::Assistant {
            continue;
        }
        for tc in &m.tool_calls {
            if tc.function.name != "write_file" && tc.function.name != "edit_file" {
                continue;
            }
            if let Ok(args) = serde_json::from_str::<Value>(&tc.function.arguments) {
                if let Some(fp) = args.get("file_path").and_then(Value::as_str) {
                    if is_auto_mem_path(fp) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// Build the extraction user prompt (individual mode).
fn build_extract_prompt(new_message_count: usize, existing_manifest: &str) -> String {
    let manifest = if existing_manifest.is_empty() {
        String::new()
    } else {
        format!(
            "\n\n## Existing memory files\n\n{existing_manifest}\n\nCheck this list before writing — update an existing file rather than creating a duplicate."
        )
    };

    let opener = format!(
        "You are now acting as the memory extraction subagent. Analyze the most recent ~{new_message_count} messages above and use them to update your persistent memory system.\n\nAvailable tools: read_file, grep, glob, read-only bash (ls/find/cat/stat/wc/head/tail and similar), and write_file/edit_file for paths inside the memory directory only. All other tools are denied.\n\nYou have a limited turn budget. The efficient strategy is: read every file you might update in parallel first, then issue all write_file/edit_file calls. Do not interleave reads and writes across many turns.\nYou MUST only use content from the last ~{new_message_count} messages to update your memories. Do not investigate or verify further — no grepping source files, no reading code to confirm a pattern, no git commands.{manifest}"
    );

    let mut how_to_save: Vec<String> = vec![
        "## How to save memories".into(),
        "".into(),
        "Saving a memory is a two-step process:".into(),
        "".into(),
        "**Step 1** — write the memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:".into(),
        "".into(),
    ];
    how_to_save.extend(memory_frontmatter_example());
    how_to_save.push("".into());
    how_to_save.push(format!(
        "**Step 2** — add a pointer to that file in `{ENTRYPOINT_NAME}`. It is an index, not a memory — one line per entry, under ~150 characters: `- [Title](file.md) — one-line hook`. No frontmatter. Never write memory content directly into `{ENTRYPOINT_NAME}`."
    ));
    how_to_save.extend([
        "".into(),
        "- Organize memory semantically by topic, not chronologically".into(),
        "- Update or remove memories that turn out to be wrong or outdated".into(),
        "- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.".into(),
    ]);

    let mut lines: Vec<String> = vec![
        opener,
        "".into(),
        "If the user explicitly asked you to remember something, save it immediately as whichever type fits best. If they asked you to forget something, find and remove the relevant entry.".into(),
        "".into(),
    ];
    lines.extend(TYPES_SECTION.iter().map(|s| s.to_string()));
    lines.extend(WHAT_NOT_TO_SAVE_SECTION.iter().map(|s| s.to_string()));
    lines.push("".into());
    lines.extend(how_to_save);
    lines.join("\n")
}

/// The fork's per-tool gate: read/search unrestricted, writes memory-dir-only.
fn gate_extraction_tool(name: &str, args: &Value) -> bool {
    match name {
        "read_file" | "grep" | "glob" => true,
        "bash" => is_read_only_command(args.get("command").and_then(Value::as_str).unwrap_or("")),
        "write_file" | "edit_file" => args
            .get("file_path")
            .and_then(Value::as_str)
            .map(is_auto_mem_path)
            .unwrap_or(false),
        _ => false,
    }
}

async fn exec_extraction_tool(
    client: &reqwest::Client,
    name: &str,
    args: &Value,
    workspace: &Path,
    cancel: &CancellationToken,
) -> String {
    if name == "bash" {
        let command = args.get("command").and_then(Value::as_str).unwrap_or("");
        let opts = BashOptions {
            background: false,
            timeout_ms: args.get("timeout").and_then(Value::as_u64),
        };
        return execute_bash(command, workspace, opts, cancel, |_| {}).await.content;
    }
    let _ = client;
    execute(name, args, workspace).content
}

/// Run one memory-extraction pass over `conversation` (the model-visible history
/// of the turn that just finished). Best-effort — errors are swallowed. Returns
/// the topic files written (excluding the MEMORY.md index).
pub async fn run_memory_extraction(
    client: &reqwest::Client,
    config: &Config,
    conversation: &[Message],
    new_message_count: usize,
    cancel: &CancellationToken,
) -> ExtractionResult {
    if !is_auto_memory_enabled() {
        return ExtractionResult { written_paths: Vec::new(), turns: 0, skipped: true };
    }
    if has_memory_writes_since(conversation) {
        tracing::debug!(target: "memory", "extraction skipped — conversation already wrote to memory");
        return ExtractionResult { written_paths: Vec::new(), turns: 0, skipped: true };
    }

    let dir = memory_dir();
    let manifest = format_memory_manifest(&scan_memory_files(&dir));
    let prompt = build_extract_prompt(new_message_count, &manifest);
    let tools: Vec<Value> = ALL_TOOLS
        .iter()
        .filter(|t| EXTRACTION_TOOL_NAMES.contains(&tool_name(t).unwrap_or("")))
        .cloned()
        .collect();

    let workspace = original_cwd();
    let mut history: Vec<Message> = conversation.to_vec();
    history.push(Message::user(prompt));
    let mut written: Vec<String> = Vec::new();
    let mut turn: u32 = 0;

    while turn < MAX_EXTRACTION_TURNS {
        if cancel.is_cancelled() {
            break;
        }
        turn += 1;
        let overrides = ChatOverrides { system_prompt: None, tools: Some(tools.clone()) };
        let res = match stream_turn(client, config, &history, cancel, overrides, |_| {}, |_| {}).await
        {
            Ok(r) => r,
            Err(_) => break,
        };
        let assistant = res.assistant.clone();
        history.push(assistant.clone());
        if res.interrupted {
            break;
        }
        let calls = &assistant.tool_calls;
        if calls.is_empty() || res.finish_reason.as_deref() != Some("tool_calls") {
            break;
        }

        for tc in calls {
            if cancel.is_cancelled() {
                history.push(Message::tool(&tc.id, "Aborted."));
                continue;
            }
            let name = tc.function.name.as_str();
            let args: Value =
                serde_json::from_str(&tc.function.arguments).unwrap_or(Value::Null);
            let content = if !gate_extraction_tool(name, &args) {
                format!("Error: tool \"{name}\" is not permitted during memory extraction.")
            } else {
                let out = exec_extraction_tool(client, name, &args, &workspace, cancel).await;
                if name == "write_file" || name == "edit_file" {
                    if let Some(fp) = args.get("file_path").and_then(Value::as_str) {
                        written.push(fp.to_string());
                    }
                }
                out
            };
            history.push(Message::tool(&tc.id, content));
        }
    }

    let written_paths: Vec<String> = written
        .into_iter()
        .filter(|p| {
            Path::new(p).file_name().and_then(|n| n.to_str()) != Some(ENTRYPOINT_NAME)
        })
        .collect();
    tracing::debug!(target: "memory", "extraction done turns={turn} files={}", written_paths.len());
    ExtractionResult { written_paths, turns: turn, skipped: false }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{FunctionCall, ToolCall};

    fn mem_write(fp: &str) -> Message {
        let mut m = Message::assistant("");
        m.tool_calls = vec![ToolCall {
            id: "1".into(),
            kind: "function".into(),
            function: FunctionCall {
                name: "write_file".into(),
                arguments: serde_json::json!({ "file_path": fp }).to_string(),
            },
        }];
        m
    }

    #[test]
    fn detects_write_into_memory_dir() {
        let inside = memory_dir().join("feedback_x.md");
        assert!(has_memory_writes_since(&[mem_write(&inside.to_string_lossy())]));
    }

    #[test]
    fn ignores_writes_outside_memory_dir() {
        assert!(!has_memory_writes_since(&[mem_write("/tmp/some/other/file.md")]));
        assert!(!has_memory_writes_since(&[Message::assistant("hi")]));
    }
}
