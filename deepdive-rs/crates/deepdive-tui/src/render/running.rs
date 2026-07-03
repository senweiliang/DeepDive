//! Running indicator (§9): a single animated line —
//! `[5 waveform cells][space][verb, per-char highlight sweep][optional hint]`.
//!
//! - waveform: `CELLS = 5`, `BLOCKS` is the 12-frame ramp; cell `i` shows
//!   `BLOCKS[(frame + i*2) % 12]`.
//! - `TICK_MS = 90`; a 1s timer drives the elapsed display.
//! - truecolor gradient between `theme::RUN_DARK` and `theme::RUN_BRIGHT` (always
//!   blue). `DOT_BLINK_MS = TICK_MS * 6 = 540` (tool running-dot blink period).
//! - default verb `Deep Diving`; hint (default shown) is dim ` · {elapsed} · esc 中断`.
//!
//! Scaffold ships a minimal placeholder; Module `running` fills §9 here without
//! changing these signatures.
#![allow(dead_code)]

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};

use crate::theme;

/// Waveform cell count (§9).
pub const CELLS: usize = 5;
/// Animation tick period in ms (§9).
pub const TICK_MS: u64 = 90;
/// Tool running-dot blink period in ms = `TICK_MS * 6` (§9).
pub const DOT_BLINK_MS: u64 = TICK_MS * 6;
/// 12-frame waveform block ramp (§9).
pub const BLOCKS: [&str; 12] = [
    "▁", "▂", "▃", "▄", "▅", "▆", "▇", "▆", "▅", "▄", "▃", "▂",
];
/// Default verb (§9).
pub const DEFAULT_VERB: &str = "Deep Diving";

/// Extract the RGB triple from a `Color::Rgb`; other variants fall back to
/// black (theme constants are always `Rgb`, so this never triggers in practice).
fn rgb_of(c: Color) -> (u8, u8, u8) {
    match c {
        Color::Rgb(r, g, b) => (r, g, b),
        _ => (0, 0, 0),
    }
}

/// Linear interpolation between the dim and bright gradient endpoints
/// (`theme::RUN_DARK` ↔ `theme::RUN_BRIGHT`), mirroring TS `shade(level)`.
///
/// `level` is clamped to `[0, 1]`. Output stays in the blue band (never white),
/// since both endpoints are fixed blues.
fn shade(level: f64) -> Color {
    let t = level.clamp(0.0, 1.0);
    let (dr, dg, db) = rgb_of(theme::RUN_DARK);
    let (br, bg, bb) = rgb_of(theme::RUN_BRIGHT);
    let lerp = |dark: u8, bright: u8| -> u8 {
        (dark as f64 + (bright as f64 - dark as f64) * t).round() as u8
    };
    Color::Rgb(lerp(dr, br), lerp(dg, bg), lerp(db, bb))
}

/// Render the Running line. `frame` is the animation tick counter, `elapsed_ms`
/// the time since the turn started (for the ` · {elapsed} · esc 中断` hint),
/// `verb` the active verb (defaults to [`DEFAULT_VERB`] when `None`).
///
/// Layout (§9): `[5 waveform cells][space][verb per-char sweep][· {elapsed} · esc 中断]`.
/// Pure function of `frame`/`elapsed_ms`, so the main loop can re-tick every
/// `TICK_MS` (90ms) and re-render. `show_hint` is false during compaction
/// (TS `<Running showHint={false}>`), which suppresses the ` · {elapsed} · esc`
/// hint span.
pub fn render_running(frame: u64, elapsed_ms: u64, verb: Option<&str>, show_hint: bool) -> Line<'static> {
    let v = verb.unwrap_or(DEFAULT_VERB);
    // f64 frame for the sine sweeps; matches TS `frame` semantics.
    let f = frame as f64;
    let mut spans: Vec<Span<'static>> = Vec::new();

    // Waveform: shape pans per frame, color rides a travelling brightness wave.
    for i in 0..CELLS {
        let ch = BLOCKS[(frame as usize + i * 2) % BLOCKS.len()];
        let b = 0.5 + 0.5 * (f * 0.5 - i as f64 * 0.9).sin();
        spans.push(Span::styled(
            ch.to_string(),
            Style::default().fg(shade(0.35 + 0.65 * b)),
        ));
    }

    // Separating space between waveform and verb.
    spans.push(Span::raw(" "));

    // Verb: a highlight sweeps left → right, one Span per (Unicode) char.
    for (j, ch) in v.chars().enumerate() {
        let b = 0.5 + 0.5 * (f * 0.45 - j as f64 * 0.55).sin();
        spans.push(Span::styled(
            ch.to_string(),
            Style::default().fg(shade(0.5 + 0.5 * b)),
        ));
    }

    // Hint (suppressed during compaction, §9): dim ` · {elapsed} · esc 中断`.
    if show_hint {
        spans.push(Span::styled(
            format!(" · {} · esc 中断", format_elapsed(elapsed_ms)),
            Style::default().add_modifier(Modifier::DIM),
        ));
    }

    Line::from(spans)
}

/// Format an elapsed duration per §9: `<60s → Ns`, `<60m → Mm`/`Mm Ss`, else
/// `Hh`/`Hh Mm`. Driven by the 1s clock (whole seconds).
pub fn format_elapsed(elapsed_ms: u64) -> String {
    let total_seconds = elapsed_ms / 1000;
    if total_seconds < 60 {
        return format!("{total_seconds}s");
    }
    let minutes = total_seconds / 60;
    let seconds = total_seconds % 60;
    if minutes < 60 {
        if seconds == 0 {
            return format!("{minutes}m");
        }
        return format!("{minutes}m {seconds}s");
    }
    let hours = minutes / 60;
    let remaining_minutes = minutes % 60;
    if remaining_minutes == 0 {
        format!("{hours}h")
    } else {
        format!("{hours}h {remaining_minutes}m")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elapsed_formats_match_ts() {
        assert_eq!(format_elapsed(0), "0s");
        assert_eq!(format_elapsed(59_000), "59s");
        assert_eq!(format_elapsed(60_000), "1m");
        assert_eq!(format_elapsed(61_000), "1m 1s");
        assert_eq!(format_elapsed(3_600_000), "1h");
        assert_eq!(format_elapsed(3_660_000), "1h 1m");
    }

    #[test]
    fn shade_stays_within_blue_band() {
        // Endpoints are exact; interior stays bounded by them per channel.
        assert_eq!(shade(0.0), theme::RUN_DARK);
        assert_eq!(shade(1.0), theme::RUN_BRIGHT);
        assert_eq!(shade(-5.0), theme::RUN_DARK);
        assert_eq!(shade(5.0), theme::RUN_BRIGHT);
    }

    #[test]
    fn waveform_has_five_cells_plus_space_verb_and_hint() {
        let line = render_running(0, 0, None, true);
        // 5 wave cells + 1 space + 11 verb chars ("Deep Diving") + 1 hint span.
        assert_eq!(line.spans.len(), CELLS + 1 + "Deep Diving".chars().count() + 1);
        // show_hint=false drops the trailing hint span.
        let no_hint = render_running(0, 0, None, false);
        assert_eq!(no_hint.spans.len(), CELLS + 1 + "Deep Diving".chars().count());
    }
}
