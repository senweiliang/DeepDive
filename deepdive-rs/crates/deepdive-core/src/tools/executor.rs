//! Synchronous file/search tools — faithful port of the non-bash parts of
//! `src/tools/executor.ts` (read_file / write_file / edit_file / glob / grep),
//! plus the unified-diff generator. `executeBash` lands in `tools::bash`.

use crate::tools::format::display_path;
use regex::Regex;
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolResult {
    pub content: String,
    pub is_error: bool,
    /// Output was truncated because it exceeded the maxOutput cap.
    pub truncated: bool,
}

impl ToolResult {
    pub fn ok(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            is_error: false,
            truncated: false,
        }
    }
    pub fn error(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            is_error: true,
            truncated: false,
        }
    }
}

fn arg_str(args: &Value, key: &str) -> String {
    args.get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn arg_num(args: &Value, key: &str) -> Option<f64> {
    args.get(key).and_then(Value::as_f64)
}

/// Dispatch a synchronous tool. (bash is async — see `tools::bash`.)
pub fn execute(name: &str, args: &Value, workspace: &Path) -> ToolResult {
    match name {
        "read_file" => read_file(args, workspace),
        "write_file" => write_file(args, workspace),
        "edit_file" => edit_file(args, workspace),
        "glob" => run_glob(args, workspace),
        "grep" => run_grep(args, workspace),
        other => ToolResult::error(format!("Unknown tool: {other}")),
    }
}

/// Resolve relative paths against the workspace; absolute paths pass through.
/// Out-of-workspace access is gated by approval upstream, not blocked here.
fn check_path(workspace: &Path, file_path: &str) -> Option<PathBuf> {
    if file_path.is_empty() {
        return None;
    }
    let p = Path::new(file_path);
    Some(if p.is_absolute() {
        p.to_path_buf()
    } else {
        workspace.join(p)
    })
}

fn path_error() -> ToolResult {
    ToolResult::error("Error: file_path is required.")
}

fn read_file(args: &Value, workspace: &Path) -> ToolResult {
    let Some(resolved) = check_path(workspace, &arg_str(args, "file_path")) else {
        return path_error();
    };
    let content = match std::fs::read_to_string(&resolved) {
        Ok(c) => c,
        Err(e) => return ToolResult::error(format!("Error: {e}")),
    };
    let lines: Vec<&str> = content.split('\n').collect();
    // offset: `Math.max(1, Number(args.offset) || 1)` — 0/NaN/missing ⇒ 1.
    let offset = arg_num(args, "offset")
        .filter(|n| n.is_finite() && *n != 0.0)
        .unwrap_or(1.0)
        .max(1.0) as usize;
    let limit = arg_num(args, "limit")
        .filter(|n| n.is_finite() && *n != 0.0)
        .map(|n| n as usize);
    let len = lines.len();
    let start = (offset - 1).min(len);
    let sliced = match limit {
        Some(l) => lines[start..(start + l).min(len)].join("\n"),
        None => lines[start..].join("\n"),
    };
    ToolResult::ok(sliced)
}

fn write_file(args: &Value, workspace: &Path) -> ToolResult {
    let Some(resolved) = check_path(workspace, &arg_str(args, "file_path")) else {
        return path_error();
    };
    if let Some(dir) = resolved.parent() {
        if !dir.as_os_str().is_empty() && !dir.exists() {
            if let Err(e) = std::fs::create_dir_all(dir) {
                return ToolResult::error(format!("Error: {e}"));
            }
        }
    }
    let existed = resolved.exists();
    let old_content = if existed {
        std::fs::read_to_string(&resolved).unwrap_or_default()
    } else {
        String::new()
    };
    let new_content = arg_str(args, "content");
    if let Err(e) = std::fs::write(&resolved, &new_content) {
        return ToolResult::error(format!("Error: {e}"));
    }

    let disp = display_path(&arg_str(args, "file_path"));
    let old_lines: Vec<&str> = if existed {
        old_content.split('\n').collect()
    } else {
        Vec::new()
    };
    let new_lines: Vec<&str> = new_content.split('\n').collect();
    let diff = compute_diff(&old_lines, &new_lines, 3);
    if diff.is_empty() {
        return ToolResult::ok(format!("Wrote {disp}"));
    }
    ToolResult::ok(format!("```diff\n--- a/{disp}\n+++ b/{disp}\n{diff}\n```"))
}

fn edit_file(args: &Value, workspace: &Path) -> ToolResult {
    let Some(resolved) = check_path(workspace, &arg_str(args, "file_path")) else {
        return path_error();
    };
    let content = match std::fs::read_to_string(&resolved) {
        Ok(c) => c,
        Err(e) => return ToolResult::error(format!("Error: {e}")),
    };
    let old_str = arg_str(args, "old_string");
    let new_str = arg_str(args, "new_string");
    let replace_all = args
        .get("replace_all")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    if old_str == new_str {
        return ToolResult::error("Error: new_string must differ from old_string.");
    }
    let count = content.matches(&old_str).count();
    if count == 0 {
        return ToolResult::error("Error: old_string not found in file");
    }
    if !replace_all && count > 1 {
        return ToolResult::error(format!(
            "Error: old_string appears {count} times. Use replace_all=true or provide more context."
        ));
    }

    let updated = if replace_all {
        content.replace(&old_str, &new_str)
    } else {
        content.replacen(&old_str, &new_str, 1)
    };
    if let Err(e) = std::fs::write(&resolved, &updated) {
        return ToolResult::error(format!("Error: {e}"));
    }

    let disp = display_path(&arg_str(args, "file_path"));
    let old_lines: Vec<&str> = content.split('\n').collect();
    let new_lines: Vec<&str> = updated.split('\n').collect();
    let diff = compute_diff(&old_lines, &new_lines, 3);
    ToolResult::ok(format!("```diff\n--- a/{disp}\n+++ b/{disp}\n{diff}\n```"))
}

fn compute_diff(old_lines: &[&str], new_lines: &[&str], context: usize) -> String {
    // first differing line from the top
    let mut start = 0;
    while start < old_lines.len() && start < new_lines.len() && old_lines[start] == new_lines[start]
    {
        start += 1;
    }
    // last differing line from the bottom
    let mut old_end = old_lines.len();
    let mut new_end = new_lines.len();
    while old_end > start && new_end > start && old_lines[old_end - 1] == new_lines[new_end - 1] {
        old_end -= 1;
        new_end -= 1;
    }

    let ctx_start = start.saturating_sub(context);
    let ctx_old_end = (old_end + context).min(old_lines.len());
    let ctx_new_end = (new_end + context).min(new_lines.len());
    let old_hunk = &old_lines[ctx_start..ctx_old_end];
    let new_hunk = &new_lines[ctx_start..ctx_new_end];
    let old_len = ctx_old_end - ctx_start;
    let new_len = ctx_new_end - ctx_start;
    if old_len == 0 && new_len == 0 {
        return String::new();
    }

    let mut diff = format!(
        "@@ -{},{} +{},{} @@",
        ctx_start + 1,
        old_len,
        ctx_start + 1,
        new_len
    );

    // LCS over the hunk lines → minimal +/- output.
    let m = old_hunk.len();
    let n = new_hunk.len();
    let mut lcs = vec![vec![0usize; n + 1]; m + 1];
    for i in 1..=m {
        for j in 1..=n {
            lcs[i][j] = if old_hunk[i - 1] == new_hunk[j - 1] {
                lcs[i - 1][j - 1] + 1
            } else {
                lcs[i - 1][j].max(lcs[i][j - 1])
            };
        }
    }
    let mut result: Vec<(char, &str)> = Vec::new();
    backtrack(&lcs, old_hunk, new_hunk, m, n, &mut result);
    for (kind, text) in result {
        diff.push('\n');
        diff.push(kind);
        diff.push_str(text);
    }
    diff
}

fn backtrack<'a>(
    lcs: &[Vec<usize>],
    old: &[&'a str],
    new: &[&'a str],
    i: usize,
    j: usize,
    out: &mut Vec<(char, &'a str)>,
) {
    if i > 0 && j > 0 && old[i - 1] == new[j - 1] {
        backtrack(lcs, old, new, i - 1, j - 1, out);
        out.push((' ', old[i - 1]));
    } else if j > 0 && (i == 0 || lcs[i][j - 1] >= lcs[i - 1][j]) {
        backtrack(lcs, old, new, i, j - 1, out);
        out.push(('+', new[j - 1]));
    } else if i > 0 && (j == 0 || lcs[i][j - 1] < lcs[i - 1][j]) {
        backtrack(lcs, old, new, i - 1, j, out);
        out.push(('-', old[i - 1]));
    }
}

fn run_glob(args: &Value, workspace: &Path) -> ToolResult {
    let pattern = arg_str(args, "pattern");
    // Hidden entries match only when the pattern targets a dot segment.
    let include_dot = pattern.starts_with('.') || pattern.contains("/.");
    let mut results: Vec<String> = Vec::new();
    scan_dir(workspace, &pattern, workspace, &mut results, include_dot);
    ToolResult::ok(if results.is_empty() {
        "(no matches)".to_string()
    } else {
        results.join("\n")
    })
}

fn scan_dir(
    dir: &Path,
    pattern: &str,
    workspace: &Path,
    results: &mut Vec<String>,
    include_dot: bool,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == "node_modules" || name == ".git" {
            continue;
        }
        if !include_dot && name.starts_with('.') {
            continue;
        }
        let full = entry.path();
        let Ok(meta) = std::fs::metadata(&full) else {
            continue;
        };
        if meta.is_dir() {
            scan_dir(&full, pattern, workspace, results, include_dot);
        } else {
            let rel = match full.strip_prefix(workspace) {
                Ok(r) => r.to_string_lossy().replace('\\', "/"),
                Err(_) => continue,
            };
            if simple_match(&rel, pattern) {
                results.push(rel);
            }
        }
    }
}

/// Minimal glob matcher with directory-boundary semantics:
///   `*` matches any run of non-`/`; `?` a single non-`/`; `**` crosses dirs;
///   `**/` also matches zero dirs. Other regex metacharacters are escaped.
fn simple_match(s: &str, pattern: &str) -> bool {
    let chars: Vec<char> = pattern.chars().collect();
    let mut re = String::from("^");
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '*' {
            if chars.get(i + 1) == Some(&'*') {
                i += 1; // consume second '*'
                if chars.get(i + 1) == Some(&'/') {
                    i += 1; // consume '/': "**/" matches zero or more dir segments
                    re.push_str("(?:.*/)?");
                } else {
                    re.push_str(".*"); // bare "**" matches anything incl. "/"
                }
            } else {
                re.push_str("[^/]*");
            }
        } else if c == '?' {
            re.push_str("[^/]");
        } else if ".+^${}()|[]\\".contains(c) {
            re.push('\\');
            re.push(c);
        } else {
            re.push(c);
        }
        i += 1;
    }
    re.push('$');
    Regex::new(&re).map(|r| r.is_match(s)).unwrap_or(false)
}

fn run_grep(args: &Value, workspace: &Path) -> ToolResult {
    let pattern = arg_str(args, "pattern");
    let path_arg = arg_str(args, "path");
    let search_path = if path_arg.is_empty() {
        workspace.to_path_buf()
    } else {
        check_path(workspace, &path_arg).unwrap_or_else(|| workspace.to_path_buf())
    };

    let regex = match Regex::new(&pattern) {
        Ok(r) => r,
        Err(e) => return ToolResult::error(format!("Error: {e}")),
    };
    let ws = workspace.to_path_buf();
    let short_path = |p: &Path| -> String {
        match p.strip_prefix(&ws) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => p.to_string_lossy().replace('\\', "/"),
        }
    };

    let mut results: Vec<String> = Vec::new();
    let meta = std::fs::metadata(&search_path);
    if let Ok(meta) = meta {
        if meta.is_dir() {
            search_dir(&search_path, &regex, &short_path, &mut results);
        } else {
            grep_file(
                &search_path,
                &regex,
                &short_path(&search_path),
                &mut results,
                false,
            );
        }
    }

    ToolResult::ok(if results.is_empty() {
        "(no matches)".to_string()
    } else {
        results.join("\n")
    })
}

fn search_dir(
    dir: &Path,
    regex: &Regex,
    short_path: &dyn Fn(&Path) -> String,
    results: &mut Vec<String>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == "node_modules" || name == ".git" {
            continue;
        }
        let full = entry.path();
        let Ok(meta) = std::fs::metadata(&full) else {
            continue;
        };
        if meta.is_dir() {
            search_dir(&full, regex, short_path, results);
            if results.len() >= 50 {
                return;
            }
        } else if meta.is_file() {
            let rel = short_path(&full);
            if grep_file(&full, regex, &rel, results, true) {
                return; // cap reached
            }
        }
    }
}

/// Grep one file. `cap` enables the 50-result early-return used in directory
/// walks. Returns true when the cap was hit.
fn grep_file(path: &Path, regex: &Regex, rel: &str, results: &mut Vec<String>, cap: bool) -> bool {
    let Ok(content) = std::fs::read_to_string(path) else {
        return false; // binary / unreadable — skip
    };
    for (i, line) in content.split('\n').enumerate() {
        if regex.is_match(line) {
            results.push(format!("{rel}:{}: {}", i + 1, line.trim()));
            if cap && results.len() >= 50 {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_ws() -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("deepdive-rs-test-{}-{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn read_back(ws: &Path, p: &str) -> String {
        execute("read_file", &json!({ "file_path": p }), ws).content
    }

    #[test]
    fn read_existing_relative_and_offset_limit() {
        let ws = temp_ws();
        std::fs::write(ws.join("test.txt"), "line1\nline2\nline3\n").unwrap();
        let abs = ws.join("test.txt");
        let r = execute(
            "read_file",
            &json!({ "file_path": abs.to_string_lossy() }),
            &ws,
        );
        assert!(!r.is_error);
        assert_eq!(r.content, "line1\nline2\nline3\n");

        std::fs::write(ws.join("rel.txt"), "relative-ok").unwrap();
        assert_eq!(read_back(&ws, "rel.txt"), "relative-ok");

        std::fs::write(ws.join("lines.txt"), "a\nb\nc\nd\ne\n").unwrap();
        let r = execute(
            "read_file",
            &json!({ "file_path": ws.join("lines.txt").to_string_lossy(), "offset": 2, "limit": 2 }),
            &ws,
        );
        assert_eq!(r.content, "b\nc");
    }

    #[test]
    fn read_empty_path_errors() {
        let ws = temp_ws();
        let r = execute("read_file", &json!({ "file_path": "" }), &ws);
        assert!(r.is_error);
        assert!(r.content.contains("required"));
    }

    #[test]
    fn write_create_overwrite_and_parents() {
        let ws = temp_ws();
        let r = execute(
            "write_file",
            &json!({ "file_path": "new.txt", "content": "hello" }),
            &ws,
        );
        assert!(!r.is_error);
        assert!(ws.join("new.txt").exists());

        execute(
            "write_file",
            &json!({ "file_path": "over.txt", "content": "v1" }),
            &ws,
        );
        execute(
            "write_file",
            &json!({ "file_path": "over.txt", "content": "v2" }),
            &ws,
        );
        assert_eq!(read_back(&ws, "over.txt"), "v2");

        execute(
            "write_file",
            &json!({ "file_path": "deep/nested/f.txt", "content": "ok" }),
            &ws,
        );
        assert_eq!(read_back(&ws, "deep/nested/f.txt"), "ok");
    }

    #[test]
    fn edit_unique_replace_all_and_errors() {
        let ws = temp_ws();
        std::fs::write(ws.join("edit.txt"), "const x = 1;\nconst y = 2;\n").unwrap();
        let r = execute(
            "edit_file",
            &json!({ "file_path": "edit.txt", "old_string": "const x = 1;", "new_string": "let x = 10;" }),
            &ws,
        );
        assert!(!r.is_error);
        let content = read_back(&ws, "edit.txt");
        assert!(content.contains("let x = 10;"));
        assert!(content.contains("const y = 2;"));

        std::fs::write(ws.join("dup.txt"), "dup\ndup\n").unwrap();
        let r = execute(
            "edit_file",
            &json!({ "file_path": "dup.txt", "old_string": "dup", "new_string": "x" }),
            &ws,
        );
        assert!(r.is_error);
        assert!(r.content.contains("appears 2 times"));

        std::fs::write(ws.join("dup2.txt"), "dup\ndup\n").unwrap();
        let r = execute(
            "edit_file",
            &json!({ "file_path": "dup2.txt", "old_string": "dup", "new_string": "x", "replace_all": true }),
            &ws,
        );
        assert!(!r.is_error);
        assert!(r.content.contains("```diff"));
        assert!(r.content.contains("@@ -1,3 +1,3 @@"));
        assert_eq!(read_back(&ws, "dup2.txt"), "x\nx\n");

        std::fs::write(ws.join("nf.txt"), "hello\n").unwrap();
        let r = execute(
            "edit_file",
            &json!({ "file_path": "nf.txt", "old_string": "nope", "new_string": "x" }),
            &ws,
        );
        assert!(r.is_error);
        assert!(r.content.contains("not found"));

        std::fs::write(ws.join("same.txt"), "abc\n").unwrap();
        let r = execute(
            "edit_file",
            &json!({ "file_path": "same.txt", "old_string": "abc", "new_string": "abc" }),
            &ws,
        );
        assert!(r.is_error);
        assert!(r.content.contains("differ"));
    }

    #[test]
    fn glob_finds_by_pattern() {
        let ws = temp_ws();
        std::fs::write(ws.join("a.ts"), "").unwrap();
        std::fs::write(ws.join("b.ts"), "").unwrap();
        std::fs::write(ws.join("c.txt"), "").unwrap();
        let r = execute("glob", &json!({ "pattern": "*.ts" }), &ws);
        assert!(!r.is_error);
        assert!(r.content.contains("a.ts"));
        assert!(r.content.contains("b.ts"));
        assert!(!r.content.contains("c.txt"));

        let r = execute("glob", &json!({ "pattern": "nonexistent*.zzz" }), &ws);
        assert_eq!(r.content, "(no matches)");
    }

    #[test]
    fn grep_with_line_numbers_and_no_match() {
        let ws = temp_ws();
        std::fs::write(ws.join("search.txt"), "foo bar\nbaz foo\nqux\n").unwrap();
        let r = execute(
            "grep",
            &json!({ "pattern": "foo", "path": "search.txt" }),
            &ws,
        );
        assert!(!r.is_error);
        assert!(r.content.contains("search.txt:1: foo bar"));
        assert!(r.content.contains("search.txt:2: baz foo"));

        std::fs::write(ws.join("empty.txt"), "nothing here\n").unwrap();
        let r = execute(
            "grep",
            &json!({ "pattern": "zzzzz", "path": "empty.txt" }),
            &ws,
        );
        assert_eq!(r.content, "(no matches)");
    }

    #[test]
    fn unknown_tool_errors() {
        let ws = temp_ws();
        let r = execute("nonexistent_tool", &json!({}), &ws);
        assert!(r.is_error);
        assert!(r.content.contains("Unknown tool"));
    }
}
