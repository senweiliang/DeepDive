//! Memory-directory scanning. Port of the TS `src/memory/scan.ts`.
//!
//! Walks the memory directory for topic `.md` files (excluding MEMORY.md),
//! reads each one's frontmatter `description`/`type`, and returns a header list
//! sorted newest-first (capped). Shared by recall and the extraction agent.

use crate::memory::paths::{memory_dir, ENTRYPOINT_NAME};
use crate::memory::types::parse_memory_type;
use crate::skills::parse_frontmatter;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAX_MEMORY_FILES: usize = 200;

#[derive(Debug, Clone)]
pub struct MemoryHeader {
    /// Path relative to the memory directory (e.g. `feedback_testing.md`).
    pub filename: String,
    pub file_path: PathBuf,
    pub mtime_ms: u128,
    pub description: Option<String>,
    pub memory_type: Option<&'static str>,
}

/// Scan `dir` for topic `.md` files and return their headers sorted
/// newest-first (capped). Never fails — a missing dir yields an empty list.
pub fn scan_memory_files(dir: &Path) -> Vec<MemoryHeader> {
    let mut headers: Vec<MemoryHeader> = Vec::new();
    walk(dir, dir, &mut headers);
    headers.sort_by_key(|h| std::cmp::Reverse(h.mtime_ms));
    headers.truncate(MAX_MEMORY_FILES);
    headers
}

/// Convenience wrapper: scan the current project's memory directory.
pub fn scan_current_memory() -> Vec<MemoryHeader> {
    scan_memory_files(&memory_dir())
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<MemoryHeader>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            walk(root, &path, out);
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let filename = match path.strip_prefix(root) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if path.file_name().and_then(|n| n.to_str()) == Some(ENTRYPOINT_NAME) {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let (frontmatter, _) = parse_frontmatter(&content);
        let description = frontmatter
            .get("description")
            .filter(|s| !s.is_empty())
            .cloned();
        let memory_type = frontmatter
            .get("type")
            .and_then(|t| parse_memory_type(t));
        out.push(MemoryHeader {
            filename,
            file_path: path,
            mtime_ms,
            description,
            memory_type,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_dir() -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let d = std::env::temp_dir().join(format!("dd-memscan-{}-{}", std::process::id(), n));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn reads_frontmatter_excludes_index() {
        let d = temp_dir();
        std::fs::write(d.join("MEMORY.md"), "- [X](x.md) — index").unwrap();
        std::fs::write(
            d.join("user_role.md"),
            "---\nname: user_role\ndescription: user is a data scientist\ntype: user\n---\nbody",
        )
        .unwrap();
        let headers = scan_memory_files(&d);
        let names: Vec<&str> = headers.iter().map(|h| h.filename.as_str()).collect();
        assert!(names.contains(&"user_role.md"));
        assert!(!names.contains(&"MEMORY.md"));
        let user = headers.iter().find(|h| h.filename == "user_role.md").unwrap();
        assert_eq!(user.memory_type, Some("user"));
        assert_eq!(user.description.as_deref(), Some("user is a data scientist"));
        let manifest = format_memory_manifest(&headers);
        assert!(manifest.contains("[user] user_role.md"));
    }

    #[test]
    fn missing_dir_is_empty() {
        assert!(scan_memory_files(&std::env::temp_dir().join("dd-memscan-nope-xyz")).is_empty());
    }
}

/// Format headers as a text manifest, one line per file:
///   `- [type] filename (ISO-ish timestamp ms): description`
/// Used by both the recall selector prompt and the extraction-agent prompt.
///
/// The timestamp is the raw epoch-millis (not an ISO string): the manifest is
/// only ever read by a model choosing relevance/recency, and formatting a civil
/// datetime here would drag in a date dependency for no behavioral gain.
pub fn format_memory_manifest(memories: &[MemoryHeader]) -> String {
    memories
        .iter()
        .map(|m| {
            let tag = match m.memory_type {
                Some(t) => format!("[{t}] "),
                None => String::new(),
            };
            match &m.description {
                Some(d) => format!("- {tag}{} ({}): {d}", m.filename, m.mtime_ms),
                None => format!("- {tag}{} ({})", m.filename, m.mtime_ms),
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}
