//! Terminal tab/window title — port of TS `src/terminal-title.ts`, which itself
//! ports Claude Code's `useTerminalTitle`
//! (`src/ink/hooks/use-terminal-title.ts` + `src/ink/termio/osc.ts`).
//!
//! One universal ANSI sequence (OSC 0: `ESC ] 0 ; <title> <terminator>`) is
//! understood by every modern terminal (iTerm2, Ghostty, Kitty, WezTerm,
//! Alacritty, Windows Terminal, VS Code integrated terminal…), so there is no
//! per-terminal dispatch for the title itself — only two special cases:
//!
//! - Windows classic conhost doesn't parse OSC → call `SetConsoleTitleW`
//!   directly via FFI (Node's `process.title` does the same; zero new deps per
//!   PARITY_SPEC §0.1).
//! - Kitty prefers the ST terminator (`ESC \`) over BEL so setting the title
//!   doesn't beep.
//!
//! Opt-out: `DEEPDIVE_DISABLE_TERMINAL_TITLE` (truthy) disables both setting
//! and clearing, so a user who opted out keeps their own tab title.

pub const TITLE_STATIC_PREFIX: &str = "✳";
pub const TITLE_ANIMATION_FRAMES: [&str; 2] = ["⠂", "⠐"];
pub const TITLE_ANIMATION_INTERVAL_MS: u64 = 960;
pub const DEFAULT_TITLE: &str = "DeepDive";

// OSC generation is only used on non-Windows (Windows writes via
// SetConsoleTitleW) — but tests exercise it on every platform.
#[cfg(any(not(windows), test))]
const OSC_PREFIX: &str = "\x1b]";
#[cfg(any(not(windows), test))]
const BEL: &str = "\x07";
#[cfg(any(not(windows), test))]
const ST: &str = "\x1b\\";

/// Kitty prefers ST (`ESC \`) so the BEL terminator doesn't trigger a bell.
#[cfg(any(not(windows), test))]
fn is_kitty_from(term: Option<&str>, kitty_window_id: Option<&str>) -> bool {
    term.map(|t| t.contains("kitty")).unwrap_or(false)
        || kitty_window_id.filter(|v| !v.is_empty()).is_some()
}

#[cfg(not(windows))]
fn is_kitty() -> bool {
    is_kitty_from(
        std::env::var("TERM").ok().as_deref(),
        std::env::var("KITTY_WINDOW_ID").ok().as_deref(),
    )
}

/// Build an OSC 0 sequence: `ESC ] 0 ; <title> <terminator>` (pure — the
/// terminator is injected so tests don't touch the process env).
#[cfg(any(not(windows), test))]
fn osc0_with(terminator: &str, title: &str) -> String {
    format!("{OSC_PREFIX}0;{title}{terminator}")
}

#[cfg(not(windows))]
fn osc0(title: &str) -> String {
    osc0_with(if is_kitty() { ST } else { BEL }, title)
}

/// Remove ANSI escape sequences (CSI/OSC) so a `/rename` can't inject escape
/// codes into the title. Conservative scanner, equivalent to TS `stripAnsi`.
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars();
    while let Some(c) = it.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match it.next() {
            // CSI: ESC [ ... final byte in @–~
            Some('[') => {
                for c2 in it.by_ref() {
                    if ('\x40'..='\x7e').contains(&c2) {
                        break;
                    }
                }
            }
            // OSC: ESC ] ... until BEL or ST (ESC \)
            Some(']') => {
                for c2 in it.by_ref() {
                    if c2 == '\x07' {
                        break;
                    }
                    if c2 == '\x1b' {
                        // ST terminator: consume the trailing backslash too.
                        if matches!(it.clone().next(), Some('\\')) {
                            let _ = it.next();
                        }
                        break;
                    }
                }
            }
            // A lone ESC or a short escape (ESC ( …) — drop it.
            _ => {}
        }
    }
    out
}

/// Truthy env parsing (Claude Code's `isEnvTruthy`).
fn env_truthy(v: Option<&str>) -> bool {
    match v {
        None => false,
        Some(s) => ["1", "true", "yes", "on"].contains(&s.trim().to_lowercase().as_str()),
    }
}

/// Whether the user opted out of title changes (setting AND clearing).
pub fn is_title_disabled() -> bool {
    env_truthy(std::env::var("DEEPDIVE_DISABLE_TERMINAL_TITLE").ok().as_deref())
}

/// Compose the display string: animated `⠂/⠐` prefix while a turn is running,
/// static `✳` otherwise; session title (`/rename`) wins, else the product name.
pub fn title_string(busy: bool, frame: usize, session_title: Option<&str>) -> String {
    let prefix = if busy {
        TITLE_ANIMATION_FRAMES[frame % TITLE_ANIMATION_FRAMES.len()]
    } else {
        TITLE_STATIC_PREFIX
    };
    format!("{prefix} {}", session_title.unwrap_or(DEFAULT_TITLE))
}

#[cfg(windows)]
fn set_console_title(title: &str) {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn SetConsoleTitleW(lpConsoleTitle: *const u16) -> i32;
    }

    let wide: Vec<u16> = OsStr::new(title).encode_wide().chain(Some(0)).collect();
    // SAFETY: `wide` is a valid NUL-terminated UTF-16 buffer for the duration
    // of the call; SetConsoleTitleW copies the string out.
    unsafe {
        SetConsoleTitleW(wide.as_ptr());
    }
}

#[cfg(not(windows))]
fn write_osc0(title: &str) {
    use std::io::Write;
    let mut out = std::io::stdout();
    let _ = write!(out, "{}", osc0(title));
    let _ = out.flush();
}

/// Set the terminal tab/window title (no-op when disabled).
pub fn set_title(title: &str) {
    if is_title_disabled() {
        return;
    }
    let clean = strip_ansi(title);
    #[cfg(windows)]
    set_console_title(&clean);
    #[cfg(not(windows))]
    write_osc0(&clean);
}

/// Clear the terminal title so the tab doesn't show stale session info on exit
/// (Claude Code's graceful-shutdown clear; respects the opt-out).
pub fn clear_title() {
    if is_title_disabled() {
        return;
    }
    #[cfg(windows)]
    set_console_title("");
    #[cfg(not(windows))]
    write_osc0("");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn osc0_uses_bel_terminator_by_default_and_st_for_kitty() {
        assert_eq!(osc0_with(BEL, "DeepDive"), "\x1b]0;DeepDive\x07");
        assert_eq!(osc0_with(ST, "DeepDive"), "\x1b]0;DeepDive\x1b\\");
    }

    #[test]
    fn kitty_detection_from_term_and_window_id() {
        assert!(is_kitty_from(Some("xterm-kitty"), None));
        assert!(!is_kitty_from(Some("xterm-256color"), None));
        // An empty KITTY_WINDOW_ID doesn't count (TS `!!env` truthiness).
        assert!(!is_kitty_from(None, Some("")));
        assert!(is_kitty_from(None, Some("1")));
        assert!(!is_kitty_from(None, None));
    }

    #[test]
    fn strip_ansi_removes_csi_and_osc() {
        assert_eq!(strip_ansi("\x1b[31mred\x1b[0m"), "red");
        assert_eq!(strip_ansi("evil\x1b]0;hijacked\x07title"), "eviltitle");
        assert_eq!(strip_ansi("重构鉴权"), "重构鉴权");
    }

    #[test]
    fn env_truthy_matches_ts() {
        assert!(env_truthy(Some("1")));
        assert!(env_truthy(Some(" TRUE ")));
        assert!(env_truthy(Some("yes")));
        assert!(env_truthy(Some("on")));
        assert!(!env_truthy(Some("0")));
        assert!(!env_truthy(Some("false")));
        assert!(!env_truthy(Some("")));
        assert!(!env_truthy(None));
    }

    #[test]
    fn title_string_animates_while_busy_and_prefers_session_title() {
        assert_eq!(title_string(false, 3, None), "✳ DeepDive");
        assert_eq!(title_string(true, 0, None), "⠂ DeepDive");
        assert_eq!(title_string(true, 1, None), "⠐ DeepDive");
        // Wraps around (2 frames).
        assert_eq!(title_string(true, 2, None), "⠂ DeepDive");
        assert_eq!(title_string(false, 0, Some("重构鉴权")), "✳ 重构鉴权");
        assert_eq!(title_string(true, 0, Some("重构鉴权")), "⠂ 重构鉴权");
    }
}
