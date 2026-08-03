//! First-run API-key setup screen (SetupScreen.tsx).
//!
//! Shown before the session starts when neither the environment nor
//! `~/.deepdive/settings.json` holds a `DEEPSEEK_API_KEY`. This module is pure
//! rendering; the key loop that feeds it lives in `main::run_setup`.

use crate::theme::{self, dim_style};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

/// Ink `paddingX={1}` on the screen's Box.
const PAD: &str = " ";

const TITLE: &str = "Welcome to DeepDive";
const HELP: &str = "Get your API key at https://platform.deepseek.com/api_keys";
const LABEL: &str = "DEEPSEEK_API_KEY: ";
const PLACEHOLDER: &str = "(paste or type, then Enter)";
const HINT: &str = "Saved to ~/.deepdive/settings.json \u{b7} Esc to quit";

/// Rejection shown when Enter lands on an all-whitespace buffer.
pub const EMPTY_ERROR: &str = "Key is empty.";

/// The screen's five lines (SetupScreen.tsx `<Box height={5}>`): title, help
/// link, blank, masked key line, hint — the last turning red when `error` is set.
pub fn setup_lines(value: &str, error: &str, cols: usize) -> Vec<Line<'static>> {
    // Floor of 20 like the transcript truncations (§5): a terminal that reports
    // no size must not collapse every line to a lone ellipsis.
    let width = cols.saturating_sub(PAD.len() * 2).max(20);
    let masked = mask_secret(value);
    let shown = if masked.is_empty() {
        PLACEHOLDER
    } else {
        &masked
    };
    let hint = if error.is_empty() { HINT } else { error };
    let hint_style = if error.is_empty() {
        dim_style()
    } else {
        Style::default().fg(theme::ERROR)
    };

    vec![
        pad_line(TITLE, Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD), width),
        pad_line(HELP, dim_style(), width),
        Line::from(""),
        pad_line(&format!("{LABEL}{shown}"), Style::default(), width),
        pad_line(hint, hint_style, width),
    ]
}

/// Mask a secret the way SetupScreen does: keep 3 chars at each end, bullet the
/// middle. Short values (≤8) are bulleted whole so no useful prefix leaks.
pub fn mask_secret(v: &str) -> String {
    let n = v.chars().count();
    if n == 0 {
        return String::new();
    }
    if n <= 8 {
        return "\u{2022}".repeat(n);
    }
    let chars: Vec<char> = v.chars().collect();
    let head: String = chars[..3].iter().collect();
    let tail: String = chars[n - 3..].iter().collect();
    format!("{head}{}{tail}", "\u{2022}".repeat(n - 6))
}

/// One padded line. Ink reflows an over-long line; autowrap is off here (§2), so
/// a narrow terminal truncates with the usual `…` instead of spilling a row.
fn pad_line(text: &str, style: Style, width: usize) -> Line<'static> {
    Line::from(Span::styled(format!("{PAD}{}", clip(text, width)), style))
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let keep = max.saturating_sub(1);
    let mut out: String = s.chars().take(keep).collect();
    out.push('\u{2026}');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_matches_setup_screen() {
        assert_eq!(mask_secret(""), "");
        // ≤8 chars: fully bulleted.
        assert_eq!(mask_secret("sk-12345"), "\u{2022}".repeat(8));
        // >8: first 3 + bullets + last 3, total length preserved.
        let m = mask_secret("sk-abcdefghijkl");
        assert_eq!(m.chars().count(), 15);
        assert!(m.starts_with("sk-") && m.ends_with("jkl"));
        assert_eq!(m.matches('\u{2022}').count(), 9);
    }

    #[test]
    fn empty_value_shows_placeholder() {
        let lines = setup_lines("", "", 80);
        assert_eq!(lines.len(), 5);
        let key = lines[3].spans[0].content.as_ref();
        assert_eq!(key, format!(" {LABEL}{PLACEHOLDER}"));
    }

    #[test]
    fn hint_turns_red_on_error() {
        let ok = setup_lines("", "", 80);
        assert!(ok[4].spans[0].content.contains("Esc to quit"));
        assert_eq!(ok[4].spans[0].style.fg, None);

        let err = setup_lines("", EMPTY_ERROR, 80);
        assert_eq!(err[4].spans[0].content.as_ref(), " Key is empty.");
        assert_eq!(err[4].spans[0].style.fg, Some(theme::ERROR));
        assert!(!err[4].spans[0].style.add_modifier.contains(Modifier::DIM));
    }

    #[test]
    fn narrow_terminal_truncates_instead_of_wrapping() {
        let lines = setup_lines("", "", 40);
        for l in &lines {
            let w: usize = l.spans.iter().map(|s| s.content.chars().count()).sum();
            assert!(w <= 40, "line overflows 40 cols: {w}");
        }
        assert!(lines[1].spans[0].content.ends_with('\u{2026}'));
    }
}
