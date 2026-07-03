//! Color palette + style helpers, ported 1:1 from `src/theme.ts` (One Dark Code).
//!
//! This is the single source of truth for color in the TUI. All `Color::Rgb`
//! constants are the exact hex values from the TS theme; `dim` is NOT a hardcoded
//! gray — it is the terminal default foreground plus `Modifier::DIM`, so DeepDive
//! blends with the user's shell colors (see `dim_style`).
//!
//! Module agents MUST NOT edit this file — it is fully implemented in Scaffold.
#![allow(dead_code)] // palette/helpers are consumed across Module-stage files.

use deepdive_core::ApprovalMode;
use ratatui::style::{Color, Modifier, Style};

// ── §1 themed palette (from theme.ts) ────────────────────────────────────────

/// brand blue: banner, bold tool names, headings, inline code, command highlight,
/// nav-style selected list item.
pub const ACCENT: Color = Color::Rgb(0x61, 0xaf, 0xef);
/// done `●`, diff `+`, cache hit, Auto mode.
pub const SUCCESS: Color = Color::Rgb(0x8c, 0xd3, 0x69);
/// error `●`/text, diff `-`, YOLO mode, ctx >= 80%.
pub const ERROR: Color = Color::Rgb(0xe0, 0x6c, 0x75);
/// thinking title (expanded/active), blockquote bar, `…` truncation, comment highlight.
pub const THINKING: Color = Color::Rgb(0xf0, 0xc1, 0x4b);
/// thinking body.
pub const THINKING_BODY: Color = Color::Rgb(0xd8, 0xa8, 0x2f);
/// thinking folded single line.
pub const THINKING_FOLDED: Color = Color::Rgb(0xa0, 0x7c, 0x22);
/// Default mode, ctx >= 60%, approval-style titles, AskQuestion unanswered hint.
pub const APPROVAL: Color = Color::Rgb(0xd8, 0x88, 0x5a);
/// Plan mode, bg tasks, links, approval-style selected option.
pub const ACTION: Color = Color::Rgb(0x56, 0xb6, 0xc2);
/// balance ¥, AcceptEdits mode.
pub const COST: Color = Color::Rgb(0xc6, 0x78, 0xdd);
/// `!` bash prompt + separator line.
pub const BASH: Color = Color::Rgb(0xd8, 0x70, 0x93);

// ── §1 non-theme fixed background colors ──────────────────────────────────────

/// user message bar background.
pub const USER_BG: Color = Color::Rgb(0x3a, 0x3a, 0x3a);
/// diff added-line background.
pub const DIFF_ADD_BG: Color = Color::Rgb(0x1a, 0x3a, 0x1a);
/// diff removed-line background.
pub const DIFF_DEL_BG: Color = Color::Rgb(0x3a, 0x1a, 0x1a);
/// soft cursor: white background, black foreground.
pub const CURSOR_BG: Color = Color::Rgb(0xff, 0xff, 0xff);
pub const CURSOR_FG: Color = Color::Rgb(0x00, 0x00, 0x00);

// ── §9 Running waveform gradient endpoints (always blue, never washes white) ──

/// dim end of the Running gradient.
pub const RUN_DARK: Color = Color::Rgb(0x3a, 0x66, 0x96);
/// bright end of the Running gradient.
pub const RUN_BRIGHT: Color = Color::Rgb(0x8e, 0xcb, 0xff);

// ── style helpers ─────────────────────────────────────────────────────────────

/// "dim" = terminal default foreground + `Modifier::DIM`. Never a hardcoded gray,
/// so it tracks the user's shell foreground (see §0.4).
pub fn dim_style() -> Style {
    Style::default().add_modifier(Modifier::DIM)
}

/// The accent color for a given approval mode (footer mode label, §8).
pub fn mode_color(mode: ApprovalMode) -> Color {
    match mode {
        ApprovalMode::Default => APPROVAL,
        ApprovalMode::AcceptEdits => COST,
        ApprovalMode::Plan => ACTION,
        ApprovalMode::Yolo => ERROR,
        ApprovalMode::Auto => SUCCESS,
    }
}

/// The footer label for a given approval mode (§8).
pub fn mode_label(mode: ApprovalMode) -> &'static str {
    match mode {
        ApprovalMode::Default => "Default",
        ApprovalMode::AcceptEdits => "Accept Edits",
        ApprovalMode::Plan => "Plan",
        ApprovalMode::Yolo => "YOLO",
        ApprovalMode::Auto => "Auto",
    }
}

/// Context-usage percentage color (§8 item 4): >=80% error, >=60% approval, else default.
pub fn ctx_color(pct: u16) -> Option<Color> {
    if pct >= 80 {
        Some(ERROR)
    } else if pct >= 60 {
        Some(APPROVAL)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_label_and_color_match_ts() {
        assert_eq!(mode_label(ApprovalMode::Default), "Default");
        assert_eq!(mode_label(ApprovalMode::AcceptEdits), "Accept Edits");
        assert_eq!(mode_label(ApprovalMode::Plan), "Plan");
        assert_eq!(mode_label(ApprovalMode::Yolo), "YOLO");
        assert_eq!(mode_label(ApprovalMode::Auto), "Auto");
        assert_eq!(mode_color(ApprovalMode::Yolo), ERROR);
        assert_eq!(mode_color(ApprovalMode::Plan), ACTION);
    }

    #[test]
    fn ctx_color_thresholds() {
        assert_eq!(ctx_color(50), None);
        assert_eq!(ctx_color(60), Some(APPROVAL));
        assert_eq!(ctx_color(80), Some(ERROR));
    }

    #[test]
    fn dim_is_modifier_not_gray() {
        let s = dim_style();
        assert!(s.add_modifier.contains(Modifier::DIM));
        assert_eq!(s.fg, None); // tracks terminal default fg
    }
}
