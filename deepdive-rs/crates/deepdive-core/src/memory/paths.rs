//! Auto-memory directory layout. Port of the TS `src/memory/paths.ts`
//! (individual-only mode). Memory lives under the SAME per-project key the
//! session store uses:
//!
//! ```text
//! ~/.deepdive/projects/<sanitized-cwd>/memory/
//!     MEMORY.md      — the index (loaded into context every session)
//!     <topic>.md     — one fact per file (frontmatter + body)
//! ```

use crate::session::get_project_dir;
use std::path::{Path, PathBuf};

pub const MEMORY_DIRNAME: &str = "memory";
pub const ENTRYPOINT_NAME: &str = "MEMORY.md";

/// Whether auto-memory features are active this session. Enabled by default;
/// `DEEPDIVE_DISABLE_AUTO_MEMORY=1` (or `true`) turns the whole subsystem off.
pub fn is_auto_memory_enabled() -> bool {
    match std::env::var("DEEPDIVE_DISABLE_AUTO_MEMORY") {
        Ok(v) => !(v == "1" || v == "true"),
        Err(_) => true,
    }
}

/// The auto-memory directory for the current project (no trailing separator).
pub fn memory_dir() -> PathBuf {
    get_project_dir().join(MEMORY_DIRNAME)
}

/// `<memoryDir>/MEMORY.md` — the index entrypoint loaded into context.
pub fn memory_entrypoint() -> PathBuf {
    memory_dir().join(ENTRYPOINT_NAME)
}

/// Ensure the memory directory exists. Idempotent, best-effort — called once per
/// session at prompt-build time so the model can Write topic files without an
/// `ls`/`mkdir` first.
pub fn ensure_memory_dir_exists() {
    let _ = std::fs::create_dir_all(memory_dir());
}

/// Is `path` inside the auto-memory directory? Used by the permission carve-out
/// (memory reads/writes never prompt) and the extraction guard (which restricts
/// the forked agent's writes to this directory).
///
/// Component-aware (`starts_with` on `Path`), so `/…/memory-other` can't slip
/// past the prefix check.
pub fn is_auto_mem_path(path: &str) -> bool {
    if path.is_empty() {
        return false;
    }
    let p = Path::new(path);
    if !p.is_absolute() {
        return false;
    }
    let dir = memory_dir();
    p == dir || p.starts_with(&dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_paths_under_memory_dir_only() {
        let inside = memory_dir().join("a.md");
        assert!(is_auto_mem_path(&inside.to_string_lossy()));
        assert!(is_auto_mem_path(&memory_dir().to_string_lossy()));
        assert!(!is_auto_mem_path("/etc/passwd"));
        assert!(!is_auto_mem_path("relative/path.md"));
        assert!(!is_auto_mem_path(""));
    }

    #[test]
    fn memory_display_labels_and_hides_path() {
        use crate::tools::format::memory_display;
        let mem = memory_dir().join("feedback_tests.md");
        let mem = mem.to_string_lossy();
        assert_eq!(
            memory_display("read_file", &mem),
            Some(("Recall".to_string(), "feedback_tests.md".to_string()))
        );
        assert_eq!(
            memory_display("write_file", &mem),
            Some(("Remember".to_string(), "feedback_tests.md".to_string()))
        );
        assert_eq!(
            memory_display("edit_file", &mem).map(|(d, _)| d),
            Some("Remember".to_string())
        );
        assert_eq!(memory_display("read_file", "/repo/src/a.rs"), None);
    }
}
