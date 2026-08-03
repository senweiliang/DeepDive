//! Ctrl+O full-screen transcript overlay (Chat.tsx `TranscriptView` +
//! `buildTranscriptLines`).
//!
//! The inline scrollback folds thinking away and caps tool results at three
//! lines, so that content was never printed anywhere the terminal's own
//! scrollback can reach. This overlay is the only way to read it: every row is
//! re-rendered at [`Detail::Full`] into a flat line list, which is then paged
//! over. Unlike the rest of the render layer this one paints into the alternate
//! screen (see `main::paint_transcript`), so it owns the whole terminal and the
//! live region is left untouched underneath.

use crate::app::Row;
use crate::render::transcript::{row_lines_detail, Detail};
use crate::theme::{self, dim_style};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

/// Rows reserved above the scrolling body: the header line.
const HEADER_ROWS: usize = 1;
/// Header + one trailing slack row. TranscriptView keeps its rendered height
/// strictly under the terminal's, and so do we — a dynamic region as tall as the
/// screen makes the renderer thrash the scrollback (see `tui-dynamic-region`).
const RESERVED_ROWS: usize = HEADER_ROWS + 1;

/// Flatten every committed row into one `Line` per terminal row, fully expanded.
pub fn transcript_lines(rows: &[Row], cols: usize) -> Vec<Line<'static>> {
    rows.iter()
        .flat_map(|r| row_lines_detail(r, cols, Detail::Full))
        .collect()
}

/// How many body rows fit under the header for a terminal `rows` tall.
pub fn viewport_rows(rows: usize) -> usize {
    rows.saturating_sub(RESERVED_ROWS).max(1)
}

/// The overlay's frame: header + the visible slice of `all`, starting at
/// `offset` (already clamped by the caller). Returns exactly `rows - 1` lines so
/// the painter can blank the screen deterministically.
pub fn render(all: &[Line<'static>], offset: usize, rows: usize) -> Vec<Line<'static>> {
    let viewport = viewport_rows(rows);
    let max_offset = all.len().saturating_sub(viewport);
    let clamped = offset.min(max_offset);

    let start_line = if all.is_empty() { 0 } else { clamped + 1 };
    let end_line = (clamped + viewport).min(all.len());

    let mut out: Vec<Line<'static>> = Vec::with_capacity(viewport + HEADER_ROWS);
    out.push(header(start_line, end_line, all.len()));
    out.extend(all.iter().skip(clamped).take(viewport).cloned());
    // Pad to a fixed height so a short transcript still clears the screen below.
    while out.len() < viewport + HEADER_ROWS {
        out.push(Line::from(""));
    }
    out
}

/// `  Transcript  · 1-40 / 512  · ↑↓/PgUp/PgDn/g/G  · esc to close`
/// (Ink `paddingX={2}` on the header Box).
fn header(start: usize, end: usize, total: usize) -> Line<'static> {
    Line::from(vec![
        Span::styled(
            "  Transcript".to_string(),
            Style::default()
                .fg(theme::ACCENT)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!("  \u{b7} {start}-{end} / {total}  \u{b7} \u{2191}\u{2193}/PgUp/PgDn/g/G  \u{b7} esc to close"),
            dim_style(),
        ),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(n: usize) -> Vec<Line<'static>> {
        (0..n).map(|i| Line::from(format!("line{i}"))).collect()
    }

    #[test]
    fn viewport_stays_under_terminal_height() {
        // 24-row terminal → header + 22 body rows = 23 painted rows.
        assert_eq!(viewport_rows(24), 22);
        let out = render(&lines(100), 0, 24);
        assert_eq!(out.len(), 23);
        assert!(out.len() < 24);
    }

    #[test]
    fn header_reports_the_visible_window() {
        let out = render(&lines(100), 0, 24);
        let head: String = out[0].spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(head.starts_with("  Transcript"));
        assert!(head.contains("· 1-22 / 100"));
        assert!(head.contains("esc to close"));
    }

    #[test]
    fn offset_clamps_to_the_last_page() {
        // 100 lines, 22-row viewport → maxOffset 78. An over-large offset pins
        // to the bottom rather than scrolling past the end.
        let out = render(&lines(100), 999, 24);
        let head: String = out[0].spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(head.contains("· 79-100 / 100"), "{head}");
        assert_eq!(out[1].spans[0].content.as_ref(), "line78");
    }

    #[test]
    fn expands_what_the_inline_view_hides() {
        // The whole point of the overlay: thinking and a long tool body are
        // folded/capped in scrollback, so they were never printed anywhere the
        // terminal's own scrollback could reach.
        let body = (1..=10).map(|i| format!("out{i}")).collect::<Vec<_>>().join("\n");
        let rows = vec![
            Row::Thinking {
                content: "why\nnot\nso".to_string(),
                expanded: false,
            },
            Row::Tool {
                name: "bash".to_string(),
                summary: "ls".to_string(),
                output: Some(body),
                ok: true,
            },
        ];
        let text: Vec<String> = transcript_lines(&rows, 80)
            .iter()
            .map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect())
            .collect();

        // Thinking body is present and the fold affordance is gone.
        assert!(text.iter().any(|l| l == "\u{2713} thinking"));
        assert!(text.iter().any(|l| l.contains("not")));
        assert!(!text.iter().any(|l| l.contains("ctrl+o to view")));
        // All ten result lines, no "… +N lines" cap.
        assert!(text.iter().any(|l| l.contains("out10")));
        assert!(!text.iter().any(|l| l.contains("+7 lines")));
    }

    #[test]
    fn short_transcript_pads_and_reports_zero_start() {
        let out = render(&[], 0, 24);
        assert_eq!(out.len(), 23);
        let head: String = out[0].spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(head.contains("· 0-0 / 0"), "{head}");
    }
}
