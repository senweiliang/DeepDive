//! The `# Memory` system-prompt section. Port of the TS `src/memory/prompt.ts`.
//!
//! `build_memory_section` returns the whole section (behavioral instructions +
//! the current MEMORY.md index content) to append to the system message, frozen
//! at session start like the project-instructions block — so the index rides the
//! stable prefix-cache region. New memories appear in the next session's prompt.

use crate::memory::paths::{
    ensure_memory_dir_exists, is_auto_memory_enabled, memory_dir, memory_entrypoint,
    ENTRYPOINT_NAME,
};
use crate::memory::types::{
    memory_frontmatter_example, TRUSTING_RECALL_SECTION, TYPES_SECTION,
    WHAT_NOT_TO_SAVE_SECTION, WHEN_TO_ACCESS_SECTION,
};
use crate::session::get_project_dir;

pub const MAX_ENTRYPOINT_LINES: usize = 200;
pub const MAX_ENTRYPOINT_BYTES: usize = 25_000;

pub struct EntrypointTruncation {
    pub content: String,
    pub line_count: usize,
    pub byte_count: usize,
    pub was_line_truncated: bool,
    pub was_byte_truncated: bool,
}

/// Truncate MEMORY.md content to the line AND byte caps, appending a warning
/// naming which cap fired. Line-truncates first (natural boundary), then
/// byte-truncates at the last newline before the cap so we never cut mid-line.
pub fn truncate_entrypoint_content(raw: &str) -> EntrypointTruncation {
    let trimmed = raw.trim();
    let lines: Vec<&str> = trimmed.split('\n').collect();
    let line_count = lines.len();
    let byte_count = trimmed.len();

    let was_line_truncated = line_count > MAX_ENTRYPOINT_LINES;
    let was_byte_truncated = byte_count > MAX_ENTRYPOINT_BYTES;

    if !was_line_truncated && !was_byte_truncated {
        return EntrypointTruncation {
            content: trimmed.to_string(),
            line_count,
            byte_count,
            was_line_truncated,
            was_byte_truncated,
        };
    }

    let mut truncated = if was_line_truncated {
        lines[..MAX_ENTRYPOINT_LINES].join("\n")
    } else {
        trimmed.to_string()
    };
    if truncated.len() > MAX_ENTRYPOINT_BYTES {
        // last newline at or before the byte cap (byte-safe: newlines are ASCII).
        let cut = truncated[..MAX_ENTRYPOINT_BYTES.min(truncated.len())]
            .rfind('\n')
            .unwrap_or(MAX_ENTRYPOINT_BYTES.min(truncated.len()));
        truncated.truncate(cut);
    }

    let reason = if was_byte_truncated && !was_line_truncated {
        format!("{byte_count} bytes (limit: {MAX_ENTRYPOINT_BYTES}) — index entries are too long")
    } else if was_line_truncated && !was_byte_truncated {
        format!("{line_count} lines (limit: {MAX_ENTRYPOINT_LINES})")
    } else {
        format!("{line_count} lines and {byte_count} bytes")
    };

    let content = format!(
        "{truncated}\n\n> WARNING: {ENTRYPOINT_NAME} is {reason}. Only part of it was loaded. \
         Keep index entries to one line under ~150 chars; move detail into topic files."
    );
    EntrypointTruncation {
        content,
        line_count,
        byte_count,
        was_line_truncated,
        was_byte_truncated,
    }
}

const DIR_EXISTS_GUIDANCE: &str = "This directory already exists — write to it directly with the write_file tool (do not run mkdir or check for its existence).";

/// The behavioral instructions (taxonomy, how/when to save & access).
fn build_memory_lines(memory_dir_str: &str) -> Vec<String> {
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
        "**Step 2** — add a pointer to that file in `{ENTRYPOINT_NAME}`. `{ENTRYPOINT_NAME}` is an index, not a memory — each entry should be one line, under ~150 characters: `- [Title](file.md) — one-line hook`. It has no frontmatter. Never write memory content directly into `{ENTRYPOINT_NAME}`."
    ));
    how_to_save.push("".into());
    how_to_save.push(format!(
        "- `{ENTRYPOINT_NAME}` is always loaded into your context — lines after {MAX_ENTRYPOINT_LINES} are truncated, so keep the index concise"
    ));
    how_to_save.extend([
        "- Keep the name, description, and type fields in memory files up-to-date with the content".into(),
        "- Organize memory semantically by topic, not chronologically".into(),
        "- Update or remove memories that turn out to be wrong or outdated".into(),
        "- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.".into(),
    ]);

    let mut lines: Vec<String> = vec![
        "# Memory".into(),
        "".into(),
        format!("You have a persistent, file-based memory system at `{memory_dir_str}`. {DIR_EXISTS_GUIDANCE}"),
        "".into(),
        "You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.".into(),
        "".into(),
        "If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.".into(),
        "".into(),
    ];
    lines.extend(TYPES_SECTION.iter().map(|s| s.to_string()));
    lines.extend(WHAT_NOT_TO_SAVE_SECTION.iter().map(|s| s.to_string()));
    lines.push("".into());
    lines.extend(how_to_save);
    lines.push("".into());
    lines.extend(WHEN_TO_ACCESS_SECTION.iter().map(|s| s.to_string()));
    lines.push("".into());
    lines.extend(TRUSTING_RECALL_SECTION.iter().map(|s| s.to_string()));
    lines.extend([
        "".into(),
        "## Memory and other forms of persistence".into(),
        "Memory persists across conversations. Do not use it for information that is only useful within the current conversation — reserve that for the current task, plans, or scratch files. Memory is for what future sessions need to know.".into(),
        "".into(),
    ]);
    lines.extend(build_searching_past_context_section(memory_dir_str));
    lines
}

/// `## Searching past context` — how to grep topic files and past transcripts.
fn build_searching_past_context_section(memory_dir_str: &str) -> Vec<String> {
    let project_dir = get_project_dir().to_string_lossy().into_owned();
    vec![
        "## Searching past context".into(),
        "".into(),
        "When looking for past context:".into(),
        format!("1. Search topic files in your memory directory: grep with pattern=\"<search term>\" path=\"{memory_dir_str}\""),
        format!("2. Session transcript logs (last resort — large files): grep with pattern=\"<search term>\" path=\"{project_dir}\""),
        "Use narrow search terms (error messages, file paths, function names) rather than broad keywords.".into(),
        "".into(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leaves_short_content_untouched() {
        let t = truncate_entrypoint_content("- [A](a.md) — hook\n- [B](b.md) — hook");
        assert!(!t.was_line_truncated);
        assert!(!t.was_byte_truncated);
        assert!(!t.content.contains("WARNING"));
    }

    #[test]
    fn line_truncates_past_cap_with_warning() {
        let raw: String = (0..MAX_ENTRYPOINT_LINES + 20)
            .map(|i| format!("- line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let t = truncate_entrypoint_content(&raw);
        assert!(t.was_line_truncated);
        assert!(t.content.contains("WARNING"));
        // kept body (<=cap lines) + blank + warning line
        assert!(t.content.lines().count() <= MAX_ENTRYPOINT_LINES + 4);
    }
}

/// Build the full memory system-prompt section (instructions + MEMORY.md index
/// content), or `""` when auto-memory is disabled. Pre-creates the memory
/// directory as a side effect so the model can Write without an `ls`/`mkdir`.
///
/// FROZEN at first call (like `session_date`): a memory written mid-session must
/// NOT mutate the system prompt, or the DeepSeek prefix cache would invalidate
/// every request after a save. New memories surface in the next session's
/// prompt; within a session, `recall` handles per-turn relevance instead.
pub fn build_memory_section() -> String {
    static SECTION: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    SECTION.get_or_init(build_memory_section_uncached).clone()
}

fn build_memory_section_uncached() -> String {
    if !is_auto_memory_enabled() {
        return String::new();
    }
    ensure_memory_dir_exists();
    let dir = memory_dir().to_string_lossy().into_owned();
    let mut lines = build_memory_lines(&dir);

    let entrypoint = std::fs::read_to_string(memory_entrypoint()).unwrap_or_default();
    if entrypoint.trim().is_empty() {
        lines.push(format!("## {ENTRYPOINT_NAME}"));
        lines.push("".into());
        lines.push(format!(
            "Your {ENTRYPOINT_NAME} is currently empty. When you save new memories, they will appear here."
        ));
    } else {
        let t = truncate_entrypoint_content(&entrypoint);
        lines.push(format!("## {ENTRYPOINT_NAME}"));
        lines.push("".into());
        lines.push(t.content);
    }

    format!("\n{}\n", lines.join("\n"))
}
