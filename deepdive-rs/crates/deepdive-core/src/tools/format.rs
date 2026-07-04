//! Display formatting for tool calls. Faithful port of `src/tools/format.ts`.

use crate::workspace::original_cwd;
use serde_json::Value;

/// Shorten a path for display: if it lives under the original cwd, show it
/// relative (no leading "./"); otherwise show it unchanged. Paths that escape
/// cwd ("../…") keep the absolute form.
pub fn display_path(p: &str) -> String {
    if p.is_empty() || !std::path::Path::new(p).is_absolute() {
        return p.to_string();
    }
    match pathdiff::diff_paths(p, original_cwd()) {
        Some(rel) => {
            let rel_s = rel.to_string_lossy();
            if rel_s.is_empty() || rel_s.starts_with("..") || rel.is_absolute() {
                p.to_string()
            } else {
                rel_s.into_owned()
            }
        }
        None => p.to_string(),
    }
}

/// Human-readable display name for a tool.
pub fn tool_display_name(name: &str) -> String {
    match name {
        "bash" => "Bash",
        "edit_file" => "Edit",
        "read_file" => "Read",
        "write_file" => "Write",
        "glob" | "grep" => "Search",
        "web_search" => "WebSearch",
        "web_fetch" => "WebFetch",
        "skill" => "Skill",
        "ask_user_question" => "AskUser",
        "agent" => "Agent",
        "task_output" => "TaskOutput",
        "task_stop" => "TaskStop",
        other => other,
    }
    .to_string()
}

pub fn summarize_args(name: &str, args: &Value) -> String {
    let s = |k: &str| {
        args.get(k)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    match name {
        "bash" => s("command"),
        "read_file" | "write_file" | "edit_file" => display_path(&s("file_path")),
        "glob" | "grep" => s("pattern"),
        "web_search" => s("query"),
        "web_fetch" => s("url"),
        "skill" => s("name"),
        "agent" => {
            let typ = args
                .get("subagent_type")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or("general-purpose");
            let desc = s("description");
            let bg = if args
                .get("run_in_background")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                " (background)"
            } else {
                ""
            };
            let base = if desc.is_empty() {
                typ.to_string()
            } else {
                format!("{typ}: {desc}")
            };
            format!("{base}{bg}")
        }
        "task_output" | "task_stop" => s("task_id"),
        "ask_user_question" => {
            let arr = args.get("questions").and_then(Value::as_array);
            let (first, len) = match arr {
                Some(qs) => {
                    let first = qs
                        .first()
                        .and_then(|q| q.get("question"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    (first, qs.len())
                }
                None => (String::new(), 0),
            };
            if len > 1 {
                format!("{first} (+{} more)", len - 1)
            } else {
                first
            }
        }
        _ => serde_json::to_string(args).unwrap_or_default(),
    }
}

/// Memory-aware `(display_name, summary)` override for a file tool whose target
/// `path` is inside the auto-memory directory, else `None`. Mirrors the TS
/// `memoryToolLabel`: a read → "Recall memory", a write/edit → "Write memory".
/// The summary keeps the full path (same as the standard tools show).
///
/// Frontends pass the tool's already-computed path summary here; grep/glob carry
/// a pattern rather than a path, so they aren't matched (they render as the plain
/// "Search" in the TUI, which has no path to test).
pub fn memory_display(name: &str, path: &str) -> Option<(String, String)> {
    if !crate::memory::paths::is_auto_mem_path(path) {
        return None;
    }
    match name {
        "read_file" => Some(("Recall memory".to_string(), path.to_string())),
        "write_file" | "edit_file" => Some(("Write memory".to_string(), path.to_string())),
        _ => None,
    }
}

/// Truncate to `max` characters, appending `…` when cut. Uses `char` counts
/// (TS uses UTF-16 units — identical for the BMP, differs only for astral
/// characters, which don't appear in tool summaries).
pub fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let kept: String = s.chars().take(max.saturating_sub(1)).collect();
    format!("{kept}…")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn display_names() {
        assert_eq!(tool_display_name("bash"), "Bash");
        assert_eq!(tool_display_name("glob"), "Search");
        assert_eq!(tool_display_name("grep"), "Search");
        assert_eq!(tool_display_name("unknown_tool"), "unknown_tool");
    }

    #[test]
    fn summarize_basic_and_agent_and_question() {
        assert_eq!(
            summarize_args("bash", &json!({"command":"ls -la"})),
            "ls -la"
        );
        assert_eq!(summarize_args("grep", &json!({"pattern":"foo"})), "foo");
        assert_eq!(
            summarize_args(
                "agent",
                &json!({"subagent_type":"Explore","description":"find auth"})
            ),
            "Explore: find auth"
        );
        assert_eq!(
            summarize_args(
                "agent",
                &json!({"description":"find auth","run_in_background":true})
            ),
            "general-purpose: find auth (background)"
        );
        assert_eq!(summarize_args("agent", &json!({})), "general-purpose");
        assert_eq!(
            summarize_args(
                "ask_user_question",
                &json!({"questions":[{"question":"A?"},{"question":"B?"}]})
            ),
            "A? (+1 more)"
        );
        assert_eq!(
            summarize_args(
                "ask_user_question",
                &json!({"questions":[{"question":"Only?"}]})
            ),
            "Only?"
        );
    }

    #[test]
    fn truncate_keeps_short_and_cuts_long() {
        assert_eq!(truncate("hello", 10), "hello");
        assert_eq!(truncate("hello", 5), "hello");
        assert_eq!(truncate("hello world", 5), "hell…");
    }

    #[test]
    fn display_path_passthrough_relative_and_under_cwd() {
        // relative paths are returned unchanged (cwd-independent)
        assert_eq!(display_path("src/main.rs"), "src/main.rs");
        assert_eq!(display_path(""), "");
        // an absolute path under the (fallback = current) cwd renders relative
        let cwd = std::env::current_dir().unwrap();
        let abs = cwd.join("foo").join("bar.rs");
        assert_eq!(display_path(&abs.to_string_lossy()), "foo/bar.rs");
    }
}
