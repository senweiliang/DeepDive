//! Session banner (§10): the static "DeepDive" figlet (Slant) plus two meta
//! lines (`version` / `workspace`). This is the first block pushed to scrollback
//! when a session starts. All glyphs are ACCENT; no gradient. The block owns its
//! trailing blank line.
//!
//! Scaffold ships the real figlet art (it is fixed/hardcoded per §10) so the
//! banner already looks right; Module `banner` only refines styling/meta if
//! needed, without changing the signature.
#![allow(dead_code)]

use ratatui::style::Style;
use ratatui::text::{Line, Span};

/// The hardcoded figlet "Slant" art for "DeepDive" (§10). Each row is 43 cols
/// wide and KEEPS its leading spaces.
pub const FIG_LINES: [&str; 6] = [
    r"    ____                  ____  _          ",
    r"   / __ \___  ___  ____  / __ \(_)   _____ ",
    r"  / / / / _ \/ _ \/ __ \/ / / / / | / / _ \",
    r" / /_/ /  __/  __/ /_/ / /_/ / /| |/ /  __/",
    r"/_____/\___/\___/ .___/_____/_/ |___/\___/ ",
    r"               /_/                         ",
];

/// Build the banner block: figlet (ACCENT) + blank + meta rows + trailing blank.
/// `version` is the app version (e.g. "0.1.0"); `cwd_display` is the workspace
/// path with `$HOME` collapsed to `~`.
///
/// Scaffold ships a working implementation (the art is fixed); Module `banner`
/// may refine without changing the signature.
pub fn banner_lines(version: &str, cwd_display: &str) -> Vec<Line<'static>> {
    let accent = Style::default().fg(crate::theme::ACCENT);
    let mut out: Vec<Line<'static>> = FIG_LINES
        .iter()
        .map(|l| Line::from(Span::styled(l.to_string(), accent)))
        .collect();
    out.push(Line::from(""));
    const LABEL_WIDTH: usize = 11; // "workspace".len() + 2
    for (label, value) in [("version", format!("v{version}")), ("workspace", cwd_display.to_string())] {
        out.push(Line::from(vec![
            Span::raw("  "),
            Span::styled(format!("{label:<LABEL_WIDTH$}"), crate::theme::dim_style()),
            Span::raw(value),
        ]));
    }
    out.push(Line::from(""));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn figlet_is_six_43col_lines() {
        // §10: Slant "DeepDive" → 6 rows, each 43 cols wide, leading spaces kept.
        assert_eq!(FIG_LINES.len(), 6);
        for l in FIG_LINES {
            assert_eq!(l.chars().count(), 43, "row must be 43 cols: {l:?}");
        }
    }

    #[test]
    fn structure_matches_ts_banner() {
        let out = banner_lines("0.1.0", "~/proj");
        // 6 figlet + 1 blank + 2 meta + 1 trailing blank = 10 lines.
        assert_eq!(out.len(), 10);
        // figlet rows are all ACCENT.
        for line in &out[..6] {
            for span in &line.spans {
                assert_eq!(span.style.fg, Some(crate::theme::ACCENT));
            }
        }
        // blank separator after figlet.
        assert_eq!(out[6].spans.iter().map(|s| s.content.as_ref()).collect::<String>(), "");
        // version meta row: "  " + dim "version    " (padEnd 11) + "v0.1.0".
        let v = &out[7];
        assert_eq!(v.spans[0].content.as_ref(), "  ");
        assert_eq!(v.spans[1].content.as_ref(), "version    ");
        assert_eq!(v.spans[1].content.chars().count(), 11);
        assert!(v.spans[1].style.add_modifier.contains(ratatui::style::Modifier::DIM));
        assert_eq!(v.spans[2].content.as_ref(), "v0.1.0");
        // workspace meta row carries the home-collapsed cwd verbatim.
        let w = &out[8];
        assert_eq!(w.spans[1].content.as_ref(), "workspace  ");
        assert_eq!(w.spans[2].content.as_ref(), "~/proj");
        // trailing blank owned by the block (§0.3).
        assert_eq!(out[9].spans.iter().map(|s| s.content.as_ref()).collect::<String>(), "");
    }
}
