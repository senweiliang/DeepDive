//! Manual bottom live-region renderer (§2).
//!
//! ratatui's `Viewport::Inline` reserves a *fixed* number of rows at creation and
//! cannot be cheaply resized (`resize`/recreate both issue a DSR cursor query that
//! times out under streaming). So instead of fighting it we drive the bottom
//! region ourselves, log-update style: committed history is printed above (and
//! scrolls into the terminal's native scrollback), and the live region (streaming
//! preview + Running + input + footer) is repainted in place at the exact height
//! of its content — so the input box hugs the last history line with no reserved
//! blank padding above or below. As the conversation grows the region is pushed
//! down by the committed history until it naturally reaches (and stays at) the
//! bottom of the screen — the Ink "scrollback grows, input follows" model.
//!
//! The invariant between frames: the hardware cursor sits `cursor_row` rows below
//! the live region's top. Every move is *relative* (`MoveUp`/`MoveDown`) so it
//! survives the terminal scrolling when history or a tall region spills off the
//! bottom — no absolute row is ever assumed, and no cursor-position query is made.

use crossterm::{cursor, queue, style, terminal};
use ratatui::style::{Color, Modifier};
use ratatui::text::Line;
use std::io::{self, Write};

/// Tracks the on-screen geometry of the live region across frames.
pub struct LiveRegion {
    /// Height (rows) of the live region currently painted on screen.
    region_rows: u16,
    /// Row within the region where the hardware cursor was left last frame.
    cursor_row: u16,
    /// Last painted live lines + cursor, to skip no-op repaints (idle ticks).
    last_live: Vec<Line<'static>>,
    last_cursor: Option<(u16, u16)>,
    started: bool,
}

impl LiveRegion {
    pub fn new() -> Self {
        Self {
            region_rows: 0,
            cursor_row: 0,
            last_live: Vec::new(),
            last_cursor: None,
            started: false,
        }
    }

    /// Paint one frame: commit `history` (printed above, into scrollback), then
    /// repaint the live region as `live` with the hardware cursor at `cursor`
    /// (frame-local `(col, row)`; `None` hides it — used by modals). `force`
    /// bypasses the idle skip-cache (e.g. after a terminal resize).
    pub fn render<W: Write>(
        &mut self,
        out: &mut W,
        history: &[Line<'static>],
        live: Vec<Line<'static>>,
        cursor: Option<(u16, u16)>,
        force: bool,
    ) -> io::Result<()> {
        if !force
            && self.started
            && history.is_empty()
            && live == self.last_live
            && cursor == self.last_cursor
        {
            return Ok(());
        }

        // Best-effort tear-free repaint (ignored by terminals that lack DEC 2026).
        let _ = queue!(out, terminal::BeginSynchronizedUpdate);

        // 1. Park the cursor at the live region's top-left.
        queue!(out, cursor::MoveToColumn(0))?;
        if self.cursor_row > 0 {
            queue!(out, cursor::MoveUp(self.cursor_row))?;
        }

        // 2. Commit history above the region. Each printed line is permanent and
        //    scrolls into native scrollback once the screen fills.
        for line in history {
            write_line(out, line)?;
            queue!(out, style::Print("\r\n"))?;
        }

        // 3. Repaint the live region in place (overwrite, clearing each line's
        //    leftover tail). No trailing newline after the last line.
        let height = live.len() as u16;
        for (i, line) in live.iter().enumerate() {
            write_line(out, line)?;
            if (i as u16) + 1 < height {
                queue!(out, style::Print("\r\n"))?;
            }
        }

        // 4. Wipe any rows the previous (taller) region left below us.
        queue!(out, terminal::Clear(terminal::ClearType::FromCursorDown))?;

        // 5. Place the hardware cursor at the input cell (relative from the region
        //    bottom, where step 3 left us).
        let (ccol, crow) = cursor.unwrap_or((0, 0));
        let bottom = height.saturating_sub(1);
        if bottom > crow {
            queue!(out, cursor::MoveUp(bottom - crow))?;
        }
        queue!(out, cursor::MoveToColumn(ccol))?;
        if cursor.is_some() {
            queue!(out, cursor::Show)?;
        } else {
            queue!(out, cursor::Hide)?;
        }

        let _ = queue!(out, terminal::EndSynchronizedUpdate);
        out.flush()?;

        self.region_rows = height;
        self.cursor_row = crow;
        self.last_live = live;
        self.last_cursor = cursor;
        self.started = true;
        Ok(())
    }

    /// On exit, drop the cursor below the region so the shell prompt resumes on a
    /// fresh line instead of overwriting the input box.
    pub fn leave<W: Write>(&mut self, out: &mut W) -> io::Result<()> {
        if !self.started {
            return Ok(());
        }
        queue!(out, cursor::MoveToColumn(0))?;
        let bottom = self.region_rows.saturating_sub(1);
        if bottom > self.cursor_row {
            queue!(out, cursor::MoveDown(bottom - self.cursor_row))?;
        }
        queue!(out, style::Print("\r\n"), cursor::Show)?;
        out.flush()
    }

    /// A terminal resize reflows everything under us, so our relative cursor
    /// bookkeeping is no longer valid. Wipe the screen and forget the painted
    /// geometry; the caller replays the whole transcript so the next `render`
    /// repaints from the top at the new width.
    pub fn reset_for_resize<W: Write>(&mut self, out: &mut W) -> io::Result<()> {
        queue!(
            out,
            terminal::Clear(terminal::ClearType::All),
            cursor::MoveTo(0, 0)
        )?;
        self.region_rows = 0;
        self.cursor_row = 0;
        self.last_live.clear();
        self.last_cursor = None;
        self.started = false;
        out.flush()
    }
}

/// Paint a full-screen overlay (the Ctrl+O transcript) from the top-left down.
///
/// Absolute cursor positioning is safe here and nowhere else in this module: the
/// alternate screen is ours alone and never scrolls, so the live region's
/// relative bookkeeping — which exists precisely because the main buffer *does*
/// scroll under us — doesn't apply. The region's saved geometry is untouched, so
/// leaving the alt screen resumes the frame loop exactly where it left off.
pub fn paint_fullscreen<W: Write>(out: &mut W, lines: &[Line<'static>]) -> io::Result<()> {
    let _ = queue!(out, terminal::BeginSynchronizedUpdate);
    queue!(out, cursor::Hide, cursor::MoveTo(0, 0))?;
    for (i, line) in lines.iter().enumerate() {
        if i > 0 {
            queue!(out, cursor::MoveToNextLine(1))?;
        }
        write_line(out, line)?;
    }
    queue!(out, terminal::Clear(terminal::ClearType::FromCursorDown))?;
    let _ = queue!(out, terminal::EndSynchronizedUpdate);
    out.flush()
}

/// Repaint one ratatui `Line` as styled ANSI on the current row. We clear the
/// whole row *first* (then print over it), rather than clearing the tail after
/// printing: a full-width line (e.g. a `─` rule) leaves the cursor in the
/// terminal's deferred-wrap state, where a trailing `Clear(UntilNewLine)` is
/// unreliable. Autowrap is disabled for the app (see `main`), so width-filling
/// lines never wrap to a second row.
fn write_line<W: Write>(out: &mut W, line: &Line<'static>) -> io::Result<()> {
    queue!(
        out,
        cursor::MoveToColumn(0),
        terminal::Clear(terminal::ClearType::UntilNewLine)
    )?;
    for span in &line.spans {
        // Reset between spans (clears colors + attributes) so styles never bleed.
        queue!(out, style::SetAttribute(style::Attribute::Reset))?;
        if let Some(fg) = span.style.fg {
            queue!(out, style::SetForegroundColor(to_ct(fg)))?;
        }
        if let Some(bg) = span.style.bg {
            queue!(out, style::SetBackgroundColor(to_ct(bg)))?;
        }
        apply_modifiers(out, span.style.add_modifier)?;
        queue!(out, style::Print(span.content.as_ref()))?;
    }
    queue!(out, style::SetAttribute(style::Attribute::Reset))
}

fn apply_modifiers<W: Write>(out: &mut W, m: Modifier) -> io::Result<()> {
    use style::Attribute as A;
    if m.contains(Modifier::BOLD) {
        queue!(out, style::SetAttribute(A::Bold))?;
    }
    if m.contains(Modifier::DIM) {
        queue!(out, style::SetAttribute(A::Dim))?;
    }
    if m.contains(Modifier::ITALIC) {
        queue!(out, style::SetAttribute(A::Italic))?;
    }
    if m.contains(Modifier::UNDERLINED) {
        queue!(out, style::SetAttribute(A::Underlined))?;
    }
    if m.contains(Modifier::REVERSED) {
        queue!(out, style::SetAttribute(A::Reverse))?;
    }
    if m.contains(Modifier::CROSSED_OUT) {
        queue!(out, style::SetAttribute(A::CrossedOut))?;
    }
    if m.intersects(Modifier::SLOW_BLINK | Modifier::RAPID_BLINK) {
        queue!(out, style::SetAttribute(A::SlowBlink))?;
    }
    if m.contains(Modifier::HIDDEN) {
        queue!(out, style::SetAttribute(A::Hidden))?;
    }
    Ok(())
}

/// Map a ratatui color to its crossterm equivalent.
fn to_ct(c: Color) -> style::Color {
    use style::Color as C;
    match c {
        Color::Reset => C::Reset,
        Color::Black => C::Black,
        Color::Red => C::DarkRed,
        Color::Green => C::DarkGreen,
        Color::Yellow => C::DarkYellow,
        Color::Blue => C::DarkBlue,
        Color::Magenta => C::DarkMagenta,
        Color::Cyan => C::DarkCyan,
        Color::Gray => C::Grey,
        Color::DarkGray => C::DarkGrey,
        Color::LightRed => C::Red,
        Color::LightGreen => C::Green,
        Color::LightYellow => C::Yellow,
        Color::LightBlue => C::Blue,
        Color::LightMagenta => C::Magenta,
        Color::LightCyan => C::Cyan,
        Color::White => C::White,
        Color::Rgb(r, g, b) => C::Rgb { r, g, b },
        Color::Indexed(i) => C::AnsiValue(i),
    }
}
