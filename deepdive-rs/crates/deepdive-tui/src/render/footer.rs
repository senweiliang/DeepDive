//! Footer rendering (§8). One logical row (may wrap at `cols`): model | mode,
//! token in/out, cache hit, ctx gauge, balance, bg-task count. When a `hint` is
//! present the footer shows ONLY the dim hint.
//!
//! Container has 2 columns of left/right padding and 2-space segment gaps.
//!
//! Scaffold ships a minimal placeholder; Module `footer` fills §8 here without
//! changing this signature.
#![allow(dead_code)]

use crate::app::AppState;
use crate::theme;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

/// Left/right padding columns (TS `paddingX={2}`).
const PAD: usize = 2;
/// Inter-segment gap (TS `marginRight={2}` on each segment box).
const GAP: usize = 2;

/// Format a token count like TS `formatTokens`: `>1000` → `(n/1000).1f + "K"`,
/// otherwise the plain integer.
fn format_tokens(n: u64) -> String {
    if n > 1000 {
        format!("{:.1}K", n as f64 / 1000.0)
    } else {
        n.to_string()
    }
}

/// Render the footer into terminal-row `Line`s, wrapped to `cols`. Reads
/// `app.model/usage/cumulative_*/mode/balance/context_window/bg_tasks` and
/// `app.footer_hint` per §8.
pub fn render_footer(app: &AppState, cols: usize) -> Vec<Line<'static>> {
    // Hint mode: the whole footer is replaced by a single dim hint line.
    if let Some(hint) = &app.footer_hint {
        return wrap_segments(vec![vec![Span::styled(hint.clone(), theme::dim_style())]], cols);
    }

    let in_tokens = app.cumulative_in;
    let out_tokens = app.cumulative_out;

    // cache hit: needs both hit+miss present with a positive total (§8.3).
    let cache_hit_pct: Option<u64> = match &app.usage {
        Some(u) => match (u.prompt_cache_hit_tokens, u.prompt_cache_miss_tokens) {
            (Some(hit), Some(miss)) if hit + miss > 0 => {
                Some(((hit as f64 / (hit + miss) as f64) * 100.0).round() as u64)
            }
            _ => None,
        },
        None => None,
    };

    // ctx: % of context window consumed by the live input usage (§8.4).
    // Use the latest reported input_tokens (not the cumulative counter).
    let ctx_in = app.usage.as_ref().map(|u| u.input_tokens).unwrap_or(in_tokens);
    let ctx_pct: Option<u64> = match app.context_window {
        Some(w) if w > 0 => Some(((ctx_in as f64 / w as f64) * 100.0).round() as u64),
        _ => None,
    };

    let dim = theme::dim_style();

    // Each segment is a Vec<Span> rendered atomically (segments are separated by
    // GAP spaces and may wrap between segments — never inside one).
    let mut segments: Vec<Vec<Span<'static>>> = Vec::new();

    // 1. model | mode. In `auto` mode the footer shows `Auto(<resolved>)`, where
    //    <resolved> is the router's per-turn pick (or the resolved default — Pro —
    //    before the first route). Port of Footer.tsx `Auto(${activeModel})`.
    let model_display = if app.model == "auto" {
        let resolved = app
            .active_model
            .clone()
            .unwrap_or_else(|| deepdive_core::config::resolve_model(&app.model).to_string());
        format!("Auto({resolved})")
    } else {
        app.model.clone()
    };
    segments.push(vec![
        Span::styled(
            model_display,
            Style::default()
                .fg(theme::ACCENT)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw(" "),
        Span::styled("|", dim),
        Span::raw(" "),
        Span::styled(
            theme::mode_label(app.mode).to_string(),
            Style::default()
                .fg(theme::mode_color(app.mode))
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw(" "),
        Span::styled("|", dim),
        Span::raw(" "),
        Span::styled(
            format!("think: {}", app.reasoning_effort),
            Style::default().fg(theme::THINKING),
        ),
    ]);

    // 2. in / out (session-cumulative), dim.
    segments.push(vec![
        Span::styled(format!("in: {}", format_tokens(in_tokens)), dim),
        Span::raw(" "),
        Span::styled(format!("out: {}", format_tokens(out_tokens)), dim),
    ]);

    // 3. cache hit (session-cumulative %; per-turn % as a "(turn x%)" suffix)
    match cache_hit_pct {
        Some(pct) => {
            let mut body = format!("cache hit: {pct}%");
            if let Some(turn) = app.turn_cache_pct {
                body.push_str(&format!(" (turn {turn}%)"));
            }
            segments.push(vec![Span::styled(body, Style::default().fg(theme::SUCCESS))]);
        }
        None => segments.push(vec![Span::styled("cache hit: \u{2014}".to_string(), dim)]),
    }

    // 4. ctx gauge (only when a context window is known).
    if let (Some(pct), Some(window)) = (ctx_pct, app.context_window) {
        let mut style = Style::default();
        if let Some(c) = theme::ctx_color(pct as u16) {
            style = style.fg(c);
        }
        segments.push(vec![Span::styled(
            format!(
                "ctx: {}/{} ({pct}%)",
                format_tokens(ctx_in),
                format_tokens(window)
            ),
            style,
        )]);
    }

    // 5. balance (¥, COST purple, ¥ glued to the number).
    if let Some(balance) = &app.balance {
        segments.push(vec![Span::styled(
            format!("\u{a5}{balance}"),
            Style::default().fg(theme::COST),
        )]);
    }

    // 6. background tasks (⚙ N bg task(s), ACTION cyan).
    if app.bg_tasks > 0 {
        let n = app.bg_tasks;
        let label = if n > 1 { "tasks" } else { "task" };
        segments.push(vec![Span::styled(
            format!("\u{2699} {n} bg {label}"),
            Style::default().fg(theme::ACTION),
        )]);
    }

    wrap_segments(segments, cols)
}

/// Lay segments out left-to-right with `GAP` spaces between them and `PAD`
/// columns of left/right padding, wrapping to a new line when a segment would
/// overflow `cols` (TS `flexWrap="wrap"`). Segments themselves are atomic.
fn wrap_segments(segments: Vec<Vec<Span<'static>>>, cols: usize) -> Vec<Line<'static>> {
    let avail = cols.saturating_sub(PAD * 2).max(1);
    let mut lines: Vec<Line<'static>> = Vec::new();
    let mut cur: Vec<Span<'static>> = vec![Span::raw(" ".repeat(PAD))];
    let mut cur_w = 0usize; // width of content placed after the left pad.

    for seg in segments {
        let seg_w: usize = seg.iter().map(|s| s.width()).sum();
        if cur_w == 0 {
            // First segment on this line — always place it.
            cur.extend(seg);
            cur_w = seg_w;
        } else if cur_w + GAP + seg_w <= avail {
            cur.push(Span::raw(" ".repeat(GAP)));
            cur.extend(seg);
            cur_w += GAP + seg_w;
        } else {
            // Wrap: flush the current line and start a new one with PAD.
            lines.push(Line::from(std::mem::take(&mut cur)));
            cur = vec![Span::raw(" ".repeat(PAD))];
            cur.extend(seg);
            cur_w = seg_w;
        }
    }
    lines.push(Line::from(cur));
    lines
}
