//! Bottom dynamic-frame assembly (§2). This builds the inline viewport drawn every
//! frame. Committed transcript rows go to native scrollback via `insert_before`
//! (see `main.rs`); this frame holds only the live tail:
//!
//!   1. streaming preview (live thinking + un-committed answer tail), capped to
//!      the inline-height budget,
//!   2. the Running waveform (while busy),
//!   3. a modal (mutually exclusive with input+footer),
//!   4. the input box,
//!   5. the footer (hidden while the slash menu is open).
//!
//! `build` returns the exact `Vec<Line>` plus the relative cursor cell. The
//! `region` renderer paints exactly those rows so the input box hugs the bottom
//! of scrollback with no blank padding below it (the streaming preview is
//! budgeted so the total never exceeds `max_inline`; overflow head rows have
//! already been flushed to history by `on_content`).

use crate::app::{AppState, Status};
use crate::render::{footer, markdown, modals, running};
use ratatui::prelude::*;

/// The frame animation tick + elapsed (ms) passed through to the Running render.
#[derive(Debug, Clone, Copy, Default)]
pub struct Anim {
    pub frame: u64,
    pub elapsed_ms: u64,
}

/// Build the bottom dynamic frame as a flat list of terminal rows, plus the
/// relative cursor position `(x, y)` (frame-local; `None` when a modal owns the
/// frame). `max_inline` is the hard cap on the frame height — the streaming
/// preview is trimmed from its head so `lines.len() <= max_inline`, which keeps
/// the input box + footer (the tail) always visible. `anim` drives Running.
pub fn build(
    app: &AppState,
    cols: usize,
    max_inline: usize,
    anim: Anim,
) -> (Vec<Line<'static>>, Option<(u16, u16)>) {
    // 1. Streaming preview (current turn).
    let mut stream: Vec<Line<'static>> = Vec::new();
    // Live thinking: an active braille-spinner title (THINKING) only — the body
    // (THINKING_BODY) stays folded (revealed via ctrl+o), mirroring the committed
    // Thinking row (§5/§9 StreamPreview) so it does not scroll the whole thought
    // process into the live frame.
    if !app.live_thinking.trim().is_empty() {
        const SPIN: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
        let sp = SPIN[(anim.frame as usize) % SPIN.len()];
        let n = app.live_thinking.chars().count();
        let count = if n > 1000 {
            format!("{:.1}K chars", n as f64 / 1000.0)
        } else {
            format!("{n} chars")
        };
        stream.push(Line::from(Span::styled(
            format!("{sp} thinking (ctrl+o to view) ({count})"),
            Style::default().fg(crate::theme::THINKING),
        )));
        // Trailing blank so the answer / Running waveform sits one row below the
        // thinking title (mirrors the committed Thinking row's block spacing).
        stream.push(Line::from(""));
    }
    // Live answer tail: run it through the markdown renderer (same path as a
    // committed Assistant row, §5/§6) with the `● `/`  ` bullet prefixes, so the
    // streaming preview reads identically to the block it eventually commits to.
    // Preview only the un-frozen tail's COMPLETED lines (everything before its
    // last `\n`); the in-progress final line is withheld until it ends, so the
    // answer commits one whole line/block at a time (§ TS StreamPreview).
    let tail = app.live_tail();
    let visible = completed_lines(tail);
    let answer_active = !visible.is_empty() || !app.live_tail_is_first();
    if !visible.is_empty() {
        let md = markdown::render_markdown(visible, cols.saturating_sub(2));
        let first_bullet = app.live_tail_is_first();
        for (i, line) in md.into_iter().enumerate() {
            let prefix = if i == 0 && first_bullet { "● " } else { "  " };
            let mut spans = vec![Span::raw(prefix.to_string())];
            spans.extend(line.spans);
            stream.push(Line::from(spans));
        }
    } else if app.status == Status::Busy && !app.has_modal() && !answer_active {
        // Pre-answer wait: the "Deep Diving" waveform occupies the answer's slot.
        // When the answer starts streaming it replaces this line *in place* (TS
        // behaviour), so the waveform never vanishes leaving a stray gap above the
        // footer when the turn collapses.
        stream.push(running::render_running(anim.frame, anim.elapsed_ms, None, true));
    }

    // The Running waveform now lives in the stream slot above (replaced in place by
    // the answer); there is no separate mid section.
    let mid: Vec<Line<'static>> = Vec::new();

    // 3/4/5. Modal is mutually exclusive with input + footer.
    let mut bottom: Vec<Line<'static>> = Vec::new();
    let mut cur_rc: Option<(usize, usize)> = None;
    if app.has_modal() {
        bottom.extend(modals::render_modal(&app.modal, cols, anim.frame, max_inline));
    } else {
        // The InputBox owns its top/bottom rules + soft cursor + slash menu (§7).
        bottom.extend(app.input.render(cols));
        // A completion menu (slash or /add-dir dir candidates) replaces the bottom
        // rule and signals the footer to hide.
        if !app.input.menu_open() {
            bottom.extend(footer::render_footer(app, cols));
        }
        // (row, col) of the cursor inside the input box; offset into the frame is
        // applied below once the (budgeted) stream height is known.
        cur_rc = Some(app.input.cursor_view_pos(cols));
    }

    // Assemble the region top→bottom: streaming preview (+ its block-trailing
    // blank), Running, the input box + footer, then one breathing-room blank.
    let has_stream = !stream.is_empty();
    let mut lines: Vec<Line<'static>> = stream;
    if has_stream && !lines.is_empty() {
        // The streaming block owns a trailing blank — TS wraps it in a
        // <Block marginBottom={1}>. Without it the next block hugs it.
        lines.push(Line::from(""));
    }
    let top_len = lines.len();
    let mid_len = mid.len();
    let bottom_len = bottom.len();
    lines.extend(mid);
    lines.extend(bottom);
    lines.push(Line::from("")); // the trailing breathing-room row (§0.3 块尾留 1 空行)

    // Cursor: the input box starts right after the stream + Running sections.
    let mut cursor = cur_rc.map(|(row, col)| (col as u16, (top_len + mid_len + row) as u16));

    // Trim the WHOLE region to `max_inline` so the streaming preview never scrolls
    // committed history off the top of the screen (which a turn's collapse could
    // then never restore, leaving stray blank rows under the footer). Trim only the
    // streaming preview / Running from the TOP — always keep the input box + footer
    // AND its one trailing breathing blank (so the footer always has exactly one
    // blank row beneath it, at startup and when bottom-anchored alike). When even
    // that floor (footer + blank) exceeds the budget — history truly fills the
    // screen — the footer scrolls naturally, landing at the bottom of scrollback
    // with its one trailing blank as the last row, which is correct.
    if lines.len() > max_inline {
        let floor = (bottom_len + 1).min(lines.len());
        let excess = (lines.len() - max_inline).min(lines.len() - floor);
        lines.drain(0..excess);
        cursor = cursor.map(|(c, r)| (c, r.saturating_sub(excess as u16)));
    }

    (lines, cursor)
}

/// The portion of `text` up to (not including) the last `\n` — the completed
/// lines. Returns "" when there is no newline yet (the single in-progress line
/// is withheld until it ends). Mirrors TS `completedLines` in Chat.tsx.
fn completed_lines(text: &str) -> &str {
    match text.rfind('\n') {
        Some(i) => &text[..i],
        None => "",
    }
}
