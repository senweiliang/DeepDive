//! Frozen original working directory captured at session start. Port of
//! `src/workspace.ts`. All file tools / bash / permission checks resolve against
//! this snapshot, not the live cwd (which can drift if a script `cd`s).

use std::path::PathBuf;
use std::sync::OnceLock;

static ORIGINAL_CWD: OnceLock<PathBuf> = OnceLock::new();

/// Freeze the working directory at session start. Idempotent: the first call
/// wins (`OnceLock::set` returns `Err` on subsequent calls, which we ignore).
pub fn set_original_cwd(cwd: PathBuf) {
    let _ = ORIGINAL_CWD.set(cwd);
}

/// The working directory frozen at session start. Falls back to the live cwd
/// when `set_original_cwd` was never called (tests, library use).
pub fn original_cwd() -> PathBuf {
    ORIGINAL_CWD
        .get()
        .cloned()
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

fn home_dir() -> String {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default()
}

/// Expand a leading `~` to the user's home directory, like a shell. Only the
/// current-user form (`~`, `~/…`, `~\…`) is handled; `~otheruser` is untouched.
pub fn expand_tilde(p: &str) -> String {
    if p == "~" {
        return home_dir();
    }
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        let mut h = PathBuf::from(home_dir());
        h.push(rest);
        return h.to_string_lossy().into_owned();
    }
    p.to_string()
}
