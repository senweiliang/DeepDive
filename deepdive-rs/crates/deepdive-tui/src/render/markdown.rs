//! Markdown → `Vec<Line>` renderer (§6). Hand-written (no third-party crate).
//!
//! Contract: each markdown block becomes one or more "full" `Line`s (one line ==
//! one terminal row). An empty line is an empty `Line`. `width` is the usable
//! content width (the caller passes `cols - prefix_width`). Inline styles
//! (bold/italic/code/links) and block constructs (headings, lists, code fences,
//! blockquotes, rules, tables) are handled per §6.
//!
//! This is a from-scratch port of `src/components/Markdown.tsx` (which uses
//! `marked` + `string-width` + `lowlight`). We hand-roll a small block/inline
//! parser instead of pulling a dependency. Code blocks are colored by a
//! heuristic, language-agnostic scanner that approximates highlight.js's common
//! scopes (it is NOT a real grammar — see `highlight_code_spans`). Tables render
//! with full per-cell inline styling. CJK width is computed with a hand-rolled
//! East-Asian-Width table (no `unicode-width` crate available).
#![allow(dead_code)]

use crate::theme::{dim_style, ACCENT, ACTION, APPROVAL, COST, SUCCESS, THINKING};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};

// ─── public entry ─────────────────────────────────────────────────────────

/// Render markdown `md` wrapped to `width` columns into terminal-row `Line`s.
///
/// Mirrors `markdownRows()` in Markdown.tsx: blocks are emitted in order, the
/// leading blank line(s) are trimmed, the trailing blank line is trimmed (a
/// whole message should not end on a blank), and consecutive blanks collapse to
/// one. Rows are returned UNPREFIXED — the transcript layer adds the `● `/`  `
/// bullet so a row is identical live or frozen.
pub fn render_markdown(md: &str, width: usize) -> Vec<Line<'static>> {
    let inner = width.max(20);
    let mut out: Vec<Line<'static>> = Vec::new();
    let blocks = parse_blocks(md);
    for b in &blocks {
        render_block(&mut out, b, inner);
    }
    // trim leading blanks
    while out.first().is_some_and(is_blank) {
        out.remove(0);
    }
    // trim trailing blanks (whole-message render)
    while out.last().is_some_and(is_blank) {
        out.pop();
    }
    if out.is_empty() {
        out.push(Line::from(md.to_string()));
    }
    out
}

fn is_blank(l: &Line<'static>) -> bool {
    l.spans.iter().all(|s| s.content.is_empty())
}

/// Byte length of the "stable" prefix of `text`: everything up to and including
/// the last block boundary (a blank line). The block AFTER it may still be
/// streaming and is excluded. Mirrors TS `stableMarkdownPrefix` (blank-line
/// variant) — used by the streaming freeze so the answer commits block-by-block
/// into scrollback. Returns 0 when no complete block exists yet.
pub fn stable_prefix(text: &str) -> usize {
    match text.rfind("\n\n") {
        Some(i) => i + 2,
        None => 0,
    }
}

// ─── block model ───────────────────────────────────────────────────────────

#[derive(Debug)]
enum Block {
    /// blank separator
    Space,
    /// heading (level is unused for styling — §6: bold only, no `#`, no color)
    Heading(String),
    Paragraph(String),
    Hr,
    /// fenced code block: (language, raw lines joined by `\n`)
    Code { lang: String, text: String },
    /// blockquote inner text (recursively parsed)
    Quote(String),
    /// list: ordered start (None = unordered), item raw texts
    List {
        start: Option<u64>,
        items: Vec<String>,
    },
    /// table: header cells, alignments, body rows
    Table {
        header: Vec<String>,
        align: Vec<Align>,
        rows: Vec<Vec<String>>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Align {
    Left,
    Right,
    Center,
}

// ─── block parsing ───────────────────────────────────────────────────────────

fn parse_blocks(md: &str) -> Vec<Block> {
    let lines: Vec<&str> = md.split('\n').collect();
    let mut blocks: Vec<Block> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim_start();

        // blank line → space separator
        if line.trim().is_empty() {
            blocks.push(Block::Space);
            i += 1;
            continue;
        }

        // fenced code block ``` or ~~~
        if let Some(fence) = fence_marker(trimmed) {
            let lang = trimmed[fence.len()..].trim().to_string();
            let mut body: Vec<&str> = Vec::new();
            i += 1;
            while i < lines.len() {
                let l = lines[i].trim_start();
                if l.starts_with(fence) && l.trim_end() == fence {
                    i += 1;
                    break;
                }
                body.push(lines[i]);
                i += 1;
            }
            blocks.push(Block::Code {
                lang,
                text: body.join("\n"),
            });
            continue;
        }

        // horizontal rule: --- *** ___ (>=3, only those chars + spaces)
        if is_hr(trimmed) {
            blocks.push(Block::Hr);
            i += 1;
            continue;
        }

        // ATX heading: 1-6 `#` then space
        if let Some(h) = atx_heading(trimmed) {
            blocks.push(Block::Heading(h));
            i += 1;
            continue;
        }

        // blockquote: lines starting with `>`
        if trimmed.starts_with('>') {
            let mut inner: Vec<String> = Vec::new();
            while i < lines.len() {
                let t = lines[i].trim_start();
                if !t.starts_with('>') {
                    break;
                }
                // strip one `>` and an optional following space
                let rest = &t[1..];
                inner.push(rest.strip_prefix(' ').unwrap_or(rest).to_string());
                i += 1;
            }
            blocks.push(Block::Quote(inner.join("\n")));
            continue;
        }

        // table: a header row containing `|` followed by a separator row
        if line.contains('|') && i + 1 < lines.len() && is_table_separator(lines[i + 1]) {
            let header = split_table_row(line);
            let align = parse_table_align(lines[i + 1]);
            i += 2;
            let mut rows: Vec<Vec<String>> = Vec::new();
            while i < lines.len() && lines[i].contains('|') && !lines[i].trim().is_empty() {
                rows.push(split_table_row(lines[i]));
                i += 1;
            }
            blocks.push(Block::Table {
                header,
                align,
                rows,
            });
            continue;
        }

        // list: bullet (-,*,+) or ordered (N. / N))
        if let Some((ordered_start, _)) = list_marker(trimmed) {
            let mut items: Vec<String> = Vec::new();
            let mut start: Option<u64> = ordered_start;
            while i < lines.len() {
                let t = lines[i].trim_start();
                if lines[i].trim().is_empty() {
                    // blank inside list: peek — if next is a list item, treat as
                    // loose list (skip blank); otherwise end the list.
                    if i + 1 < lines.len() && list_marker(lines[i + 1].trim_start()).is_some() {
                        i += 1;
                        continue;
                    }
                    break;
                }
                if let Some((ord, content)) = list_marker(t) {
                    if start.is_none() {
                        start = ord;
                    }
                    items.push(content);
                    i += 1;
                } else {
                    // continuation line of the current item (lazy)
                    if let Some(last) = items.last_mut() {
                        last.push('\n');
                        last.push_str(t);
                        i += 1;
                    } else {
                        break;
                    }
                }
            }
            blocks.push(Block::List { start, items });
            continue;
        }

        // paragraph: gather until blank / block-start
        let mut para: Vec<&str> = Vec::new();
        while i < lines.len() {
            let l = lines[i];
            let t = l.trim_start();
            if l.trim().is_empty()
                || fence_marker(t).is_some()
                || is_hr(t)
                || atx_heading(t).is_some()
                || t.starts_with('>')
                || list_marker(t).is_some()
            {
                break;
            }
            para.push(l);
            i += 1;
        }
        blocks.push(Block::Paragraph(para.join("\n")));
    }
    blocks
}

fn fence_marker(s: &str) -> Option<&'static str> {
    if s.starts_with("```") {
        Some("```")
    } else if s.starts_with("~~~") {
        Some("~~~")
    } else {
        None
    }
}

fn is_hr(s: &str) -> bool {
    let s = s.trim();
    if s.len() < 3 {
        return false;
    }
    let c = s.chars().next().unwrap();
    if c != '-' && c != '*' && c != '_' {
        return false;
    }
    let mut count = 0;
    for ch in s.chars() {
        if ch == c {
            count += 1;
        } else if ch != ' ' {
            return false;
        }
    }
    count >= 3
}

fn atx_heading(s: &str) -> Option<String> {
    let hashes = s.chars().take_while(|&c| c == '#').count();
    if (1..=6).contains(&hashes) {
        let rest = &s[hashes..];
        if rest.is_empty() || rest.starts_with(' ') {
            // strip trailing closing hashes (`## foo ##`)
            let body = rest.trim().trim_end_matches('#').trim_end();
            return Some(body.to_string());
        }
    }
    None
}

/// Return `(ordered_start, item_content)` if `s` (already left-trimmed) starts a
/// list item. `ordered_start` is `Some(n)` for `n.`/`n)`, `None` for bullets.
fn list_marker(s: &str) -> Option<(Option<u64>, String)> {
    // unordered: -, *, + followed by space
    if let Some(rest) = s
        .strip_prefix("- ")
        .or_else(|| s.strip_prefix("* "))
        .or_else(|| s.strip_prefix("+ "))
    {
        return Some((None, rest.to_string()));
    }
    // ordered: digits then `.` or `)` then space
    let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    if !digits.is_empty() && digits.len() <= 9 {
        let after = &s[digits.len()..];
        if let Some(rest) = after.strip_prefix(". ").or_else(|| after.strip_prefix(") ")) {
            return Some((digits.parse::<u64>().ok(), rest.to_string()));
        }
    }
    None
}

fn is_table_separator(s: &str) -> bool {
    let s = s.trim();
    if !s.contains('-') {
        return false;
    }
    let inner = s.trim_matches('|');
    inner
        .split('|')
        .all(|c| {
            let c = c.trim();
            !c.is_empty() && c.chars().all(|ch| ch == '-' || ch == ':' || ch == ' ')
        })
}

fn split_table_row(s: &str) -> Vec<String> {
    let t = s.trim();
    let t = t.strip_prefix('|').unwrap_or(t);
    let t = t.strip_suffix('|').unwrap_or(t);
    t.split('|').map(|c| c.trim().to_string()).collect()
}

fn parse_table_align(s: &str) -> Vec<Align> {
    let t = s.trim();
    let t = t.strip_prefix('|').unwrap_or(t);
    let t = t.strip_suffix('|').unwrap_or(t);
    t.split('|')
        .map(|c| {
            let c = c.trim();
            let left = c.starts_with(':');
            let right = c.ends_with(':');
            match (left, right) {
                (true, true) => Align::Center,
                (false, true) => Align::Right,
                _ => Align::Left,
            }
        })
        .collect()
}

// ─── block rendering ───────────────────────────────────────────────────────

fn render_block(out: &mut Vec<Line<'static>>, block: &Block, width: usize) {
    match block {
        Block::Space => {
            // collapse consecutive blanks (mirrors marked's "space" handling)
            if out.last().is_some_and(|l| !is_blank(l)) {
                out.push(Line::from(""));
            }
        }
        Block::Paragraph(text) => {
            let spans = inline_spans(text, Style::default());
            for line in wrap_spans(&spans, width) {
                out.push(spans_to_line(line));
            }
        }
        Block::Heading(text) => {
            // §6: headings are bold only — no `#`, no color, no underline.
            let mut spans = inline_spans(text, Style::default());
            for s in &mut spans {
                s.style = s.style.add_modifier(Modifier::BOLD);
            }
            for line in wrap_spans(&spans, width) {
                out.push(spans_to_line(line));
            }
        }
        Block::Hr => {
            out.push(Line::from("─".repeat(width)));
        }
        Block::Code { lang, text } => push_code_block(out, lang, text, width),
        Block::Quote(inner) => {
            let inner_w = width.saturating_sub(2).max(10);
            let mut inner_lines: Vec<Line<'static>> = Vec::new();
            for b in parse_blocks(inner) {
                render_block(&mut inner_lines, &b, inner_w);
            }
            for line in inner_lines {
                if is_blank(&line) {
                    out.push(Line::from(""));
                    continue;
                }
                // prefix `▏ ` THINKING, body dim
                let mut spans: Vec<Span<'static>> =
                    vec![Span::styled("\u{258f} ", Style::default().fg(THINKING))];
                for s in line.spans {
                    spans.push(Span::styled(
                        s.content.into_owned(),
                        s.style.add_modifier(Modifier::DIM),
                    ));
                }
                out.push(Line::from(spans));
            }
        }
        Block::List { start, items } => {
            let ordered = start.is_some();
            let base = start.unwrap_or(1);
            for (idx, item) in items.iter().enumerate() {
                let marker = if ordered {
                    format!("{}. ", base + idx as u64)
                } else {
                    "\u{2022} ".to_string()
                };
                let marker_w = text_width(&marker);
                let indent = " ".repeat(marker_w);
                let item_w = width.saturating_sub(marker_w).max(5);

                // Render the item content (may include nested blocks).
                let mut inner_lines: Vec<Line<'static>> = Vec::new();
                for b in parse_blocks(item) {
                    render_block(&mut inner_lines, &b, item_w);
                }
                // trim leading/trailing blanks of an item
                while inner_lines.first().is_some_and(is_blank) {
                    inner_lines.remove(0);
                }
                while inner_lines.last().is_some_and(is_blank) {
                    inner_lines.pop();
                }
                if inner_lines.is_empty() {
                    inner_lines.push(Line::from(""));
                }
                for (j, line) in inner_lines.into_iter().enumerate() {
                    if is_blank(&line) {
                        out.push(Line::from(""));
                        continue;
                    }
                    let prefix = if j == 0 { marker.clone() } else { indent.clone() };
                    let mut spans: Vec<Span<'static>> = vec![Span::raw(prefix)];
                    spans.extend(line.spans);
                    out.push(Line::from(spans));
                }
            }
        }
        Block::Table {
            header,
            align,
            rows,
        } => push_table(out, header, align, rows, width),
    }
}

fn push_code_block(out: &mut Vec<Line<'static>>, lang: &str, text: &str, width: usize) {
    let inner = width.max(4);
    if !lang.is_empty() {
        out.push(Line::from(Span::styled(lang.to_string(), dim_style())));
    }
    // Highlight the whole body (so block comments spanning lines keep their
    // color), then split the colored runs into terminal rows on the embedded
    // newlines — mirrors `highlightLines`/`pushCodeBlock` in Markdown.tsx.
    let body = text.trim_end_matches('\n');
    let segs = highlight_code_spans(body, lang);
    let mut rows: Vec<Vec<Span<'static>>> = vec![Vec::new()];
    for (chunk, color) in segs {
        for (idx, part) in chunk.split('\n').enumerate() {
            if idx > 0 {
                rows.push(Vec::new());
            }
            if !part.is_empty() {
                let style = color.map(|c| Style::default().fg(c)).unwrap_or_default();
                rows.last_mut().unwrap().push(Span::styled(part.to_string(), style));
            }
        }
    }
    for row in rows {
        out.push(truncate_spans(row, inner));
    }
}

/// Approximate highlight.js with a heuristic, language-agnostic lexer.
///
/// This is deliberately NOT a real grammar-based highlighter — porting the whole
/// of highlight.js is out of scope. Instead we recognize the lexical tokens
/// shared by most C-family / scripting languages and color them per the
/// `HL_COLORS` map in Markdown.tsx (comment→THINKING, keyword/literal→COST,
/// string→SUCCESS, number→APPROVAL, `name(`→ACCENT). It aims for "reasonable and
/// close-looking" over exact per-token parity; types/built-ins/tags are left as
/// default foreground (we don't detect them to avoid false positives such as
/// `Vec<T>` generics reading as HTML tags). Returns `(text, color)` runs whose
/// text may contain `\n` (the caller splits them into rows).
fn highlight_code_spans(text: &str, lang: &str) -> Vec<(String, Option<Color>)> {
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    // '#' is a line comment in shell/python/ruby/yaml/… but means preprocessor /
    // attribute in C-family/rust/js/…, so only treat it as a comment when the
    // language isn't one of those (unknown language → assume `#` is a comment).
    let hash_comment = hash_is_comment(lang);
    let mut segs: Vec<(String, Option<Color>)> = Vec::new();
    let mut plain = String::new();
    let mut i = 0;

    macro_rules! flush_plain {
        () => {
            if !plain.is_empty() {
                segs.push((std::mem::take(&mut plain), None));
            }
        };
    }

    while i < n {
        let c = chars[i];

        // block comment /* … */ (may span lines) → THINKING
        if c == '/' && i + 1 < n && chars[i + 1] == '*' {
            flush_plain!();
            let start = i;
            i += 2;
            while i < n && !(chars[i] == '*' && i + 1 < n && chars[i + 1] == '/') {
                i += 1;
            }
            if i < n {
                i += 2; // consume the closing */
            }
            segs.push((chars[start..i].iter().collect(), Some(THINKING)));
            continue;
        }

        // line comment `//` or (language-dependent) `#` → THINKING, to EOL
        if (c == '/' && i + 1 < n && chars[i + 1] == '/') || (c == '#' && hash_comment) {
            flush_plain!();
            let start = i;
            while i < n && chars[i] != '\n' {
                i += 1;
            }
            segs.push((chars[start..i].iter().collect(), Some(THINKING)));
            continue;
        }

        // string literal "…" '…' `…` (honors backslash escapes) → SUCCESS.
        // A string is closed at its delimiter; an unterminated one ends at the
        // line break (we never cross a newline) so a stray quote can't swallow
        // the rest of the block.
        if c == '"' || c == '\'' || c == '`' {
            flush_plain!();
            let start = i;
            let delim = c;
            i += 1;
            while i < n {
                let ch = chars[i];
                if ch == '\\' && i + 1 < n {
                    i += 2;
                    continue;
                }
                if ch == '\n' {
                    break;
                }
                i += 1;
                if ch == delim {
                    break;
                }
            }
            segs.push((chars[start..i].iter().collect(), Some(SUCCESS)));
            continue;
        }

        // number (int / float / 0x-hex) → APPROVAL. Because identifiers are
        // consumed as whole words below, a digit reached here always begins a
        // number (never the tail of an identifier like `x2`).
        if c.is_ascii_digit() {
            flush_plain!();
            let start = i;
            if c == '0' && i + 1 < n && (chars[i + 1] == 'x' || chars[i + 1] == 'X') {
                i += 2;
                while i < n && (chars[i].is_ascii_hexdigit() || chars[i] == '_') {
                    i += 1;
                }
            } else {
                while i < n && (chars[i].is_ascii_digit() || chars[i] == '.' || chars[i] == '_') {
                    i += 1;
                }
            }
            segs.push((chars[start..i].iter().collect(), Some(APPROVAL)));
            continue;
        }

        // identifier: keyword/literal → COST; `name(` call head → ACCENT; else
        // default foreground (merged back into the plain buffer).
        if is_ident_start(c) {
            let start = i;
            i += 1;
            while i < n && is_ident_continue(chars[i]) {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            let color = if is_keyword(&word) {
                Some(COST)
            } else if i < n && chars[i] == '(' {
                Some(ACCENT) // identifier immediately followed by `(` ≈ function call
            } else {
                None
            };
            match color {
                Some(col) => {
                    flush_plain!();
                    segs.push((word, Some(col)));
                }
                None => plain.push_str(&word),
            }
            continue;
        }

        plain.push(c);
        i += 1;
    }
    flush_plain!();
    segs
}

fn is_ident_start(c: char) -> bool {
    c.is_alphabetic() || c == '_' || c == '$'
}

fn is_ident_continue(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

/// Whether `#` starts a line comment for `lang`. C-family / rust / js-ish use it
/// for preprocessor directives or attributes, so exclude those; everything else
/// (including an unknown/empty language) treats `#` as a comment.
fn hash_is_comment(lang: &str) -> bool {
    let l = lang.trim().to_ascii_lowercase();
    !matches!(
        l.as_str(),
        "rust" | "rs" | "c" | "h" | "cpp" | "cc" | "cxx" | "c++" | "hpp" | "cs" | "csharp" | "c#"
            | "js" | "jsx" | "ts" | "tsx" | "javascript" | "typescript" | "json" | "json5"
            | "go" | "golang" | "java" | "kotlin" | "kt" | "swift" | "scala"
    )
}

/// Cross-language union of common keywords + literals (mapped to COST, matching
/// highlight.js `keyword`/`literal`). Intentionally broad and language-agnostic;
/// a real highlighter would scope these per grammar (e.g. `int`/`void` would be a
/// `type`), but a single union reads well enough for a preview.
fn is_keyword(w: &str) -> bool {
    matches!(
        w,
        // declarations / storage
        "fn" | "let" | "const" | "var" | "function" | "def" | "lambda" | "class" | "struct"
            | "enum" | "interface" | "trait" | "impl" | "type" | "typedef" | "namespace"
            | "module" | "mod" | "package" | "pub" | "priv" | "private" | "public"
            | "protected" | "static" | "final" | "abstract" | "override" | "virtual"
            | "extern" | "unsafe" | "inline" | "extends" | "implements"
            // imports
            | "import" | "from" | "export" | "use" | "using" | "include" | "require"
            // control flow
            | "return" | "if" | "else" | "elif" | "elsif" | "for" | "while" | "do" | "loop"
            | "match" | "switch" | "case" | "default" | "break" | "continue" | "goto"
            | "try" | "catch" | "except" | "finally" | "throw" | "throws" | "raise"
            | "with" | "yield" | "defer" | "select" | "when" | "where" | "then"
            // operators-as-words / misc
            | "async" | "await" | "go" | "chan" | "in" | "of" | "as" | "is" | "not"
            | "and" | "or" | "new" | "delete" | "this" | "self" | "super" | "base"
            // common primitive types (highlight.js would scope as `type`)
            | "int" | "long" | "short" | "char" | "float" | "double" | "bool" | "boolean"
            | "byte" | "void" | "string" | "str" | "usize" | "isize"
            // literals
            | "true" | "false" | "null" | "nil" | "none" | "None" | "True" | "False"
            | "undefined"
    )
}

fn push_table(
    out: &mut Vec<Line<'static>>,
    header: &[String],
    align: &[Align],
    rows: &[Vec<String>],
    width: usize,
) {
    // Each cell's text is parsed through the shared inline parser so bold /
    // inline-code (ACCENT) / links (ACTION) render inside the box, mirroring TS
    // `pushTable` (which runs `inlineSpans` per cell). The box lines, proportional
    // column scaling, remainder rotation and alignment are unchanged.
    let ncols = header.len();
    if ncols == 0 {
        return;
    }
    let header_cells: Vec<Vec<InlineSpan>> = header
        .iter()
        .map(|c| inline_spans(c, Style::default()))
        .collect();
    let row_cells: Vec<Vec<Vec<InlineSpan>>> = rows
        .iter()
        .map(|r| r.iter().map(|c| inline_spans(c, Style::default())).collect())
        .collect();

    // Plain display width of a parsed cell (sum of its runs' widths).
    let cell_width = |cell: &[InlineSpan]| -> usize { cell.iter().map(|s| text_width(&s.text)).sum() };

    // initial column widths from content
    let mut col_w: Vec<usize> = (0..ncols)
        .map(|c| {
            let mut m = header_cells.get(c).map(|h| cell_width(h)).unwrap_or(0);
            for r in &row_cells {
                if let Some(cell) = r.get(c) {
                    m = m.max(cell_width(cell));
                }
            }
            m
        })
        .collect();

    // clamp to width: overhead = 3*ncols + 1
    let avail = width.saturating_sub(3 * ncols + 1).max(ncols);
    let total: usize = col_w.iter().sum();
    if total > avail {
        for w in &mut col_w {
            *w = ((*w as f64 / total as f64) * avail as f64).floor() as usize;
            *w = (*w).max(1);
        }
        let mut diff = avail as isize - col_w.iter().sum::<usize>() as isize;
        let mut i = 0usize;
        while diff != 0 && ncols > 0 {
            if diff > 0 {
                col_w[i] += 1;
                diff -= 1;
            } else if col_w[i] > 1 {
                col_w[i] -= 1;
                diff += 1;
            }
            i = (i + 1) % ncols;
        }
    }

    let sep = |l: &str, m: &str, r: &str| -> Line<'static> {
        let mut s = String::from(l);
        for (k, w) in col_w.iter().enumerate() {
            if k > 0 {
                s.push_str(m);
            }
            s.push_str(&"─".repeat(w + 2));
        }
        s.push_str(r);
        Line::from(s)
    };

    let render_row = |cells: &[Vec<InlineSpan>]| -> Line<'static> {
        let mut spans: Vec<Span<'static>> = vec![Span::raw("│ ")];
        for (k, w) in col_w.iter().enumerate() {
            if k > 0 {
                spans.push(Span::raw(" │ "));
            }
            let empty: Vec<InlineSpan> = Vec::new();
            let cell = cells.get(k).unwrap_or(&empty);
            // Style-aware clip to the (possibly shrunk) column width, keeping the
            // per-run styles (bold / ACCENT code / ACTION link) intact.
            let raw: Vec<Span<'static>> = cell
                .iter()
                .map(|s| Span::styled(s.text.clone(), s.style))
                .collect();
            let clipped = truncate_spans(raw, *w).spans;
            let cw: usize = clipped.iter().map(|s| text_width(&s.content)).sum();
            let gap = w.saturating_sub(cw);
            let a = align.get(k).copied().unwrap_or(Align::Left);
            let (before, after) = match a {
                Align::Right => (gap, 0),
                Align::Center => (gap / 2, gap - gap / 2),
                Align::Left => (0, gap),
            };
            if before > 0 {
                spans.push(Span::raw(" ".repeat(before)));
            }
            spans.extend(clipped);
            if after > 0 {
                spans.push(Span::raw(" ".repeat(after)));
            }
        }
        spans.push(Span::raw(" │"));
        Line::from(spans)
    };

    out.push(sep("┌", "┬", "┐"));
    out.push(render_row(&header_cells));
    out.push(sep("├", "┼", "┤"));
    for r in &row_cells {
        out.push(render_row(r));
    }
    out.push(sep("└", "┴", "┘"));
}

// ─── inline parsing ───────────────────────────────────────────────────────

/// A styled inline run. `code`/`href` carry extra semantics for wrapping/color.
#[derive(Clone)]
struct InlineSpan {
    text: String,
    style: Style,
    code: bool,
    href: Option<String>,
}

/// Parse inline markdown (`**`, `*`/`_`, `~~`, `` ` ``, `[t](u)`) into styled
/// runs. `base` is the inherited style (e.g. heading bold). Mirrors `inlineSpans`.
fn inline_spans(text: &str, base: Style) -> Vec<InlineSpan> {
    let chars: Vec<char> = text.chars().collect();
    let mut out: Vec<InlineSpan> = Vec::new();
    let mut buf = String::new();
    let mut i = 0;

    macro_rules! flush {
        () => {
            if !buf.is_empty() {
                out.push(InlineSpan {
                    text: std::mem::take(&mut buf),
                    style: base,
                    code: false,
                    href: None,
                });
            }
        };
    }

    while i < chars.len() {
        let c = chars[i];

        // inline code `...`
        if c == '`' {
            // count run of backticks (fence length)
            let mut fence = 0;
            while i + fence < chars.len() && chars[i + fence] == '`' {
                fence += 1;
            }
            // find matching closing run of the same length
            if let Some(end) = find_code_close(&chars, i + fence, fence) {
                flush!();
                let inner: String = chars[i + fence..end].iter().collect();
                // markdown trims one leading/trailing space if both present
                let inner = trim_code_span(&inner);
                // Inline code is ACCENT — but only when it hasn't already
                // inherited a color (e.g. code inside a link keeps the link's
                // ACTION). Mirrors `s.code ? s.color ?? theme.accent` in TS.
                let style = if base.fg.is_some() {
                    base
                } else {
                    base.fg(ACCENT)
                };
                out.push(InlineSpan {
                    text: inner,
                    style,
                    code: true,
                    href: None,
                });
                i = end + fence;
                continue;
            }
        }

        // strong **...** or __...__
        if (c == '*' || c == '_') && i + 1 < chars.len() && chars[i + 1] == c {
            // `_` only opens/closes emphasis at a word boundary (GFM "flanking"),
            // so intra-word runs like `a__b__c` stay literal. `*` is exempt.
            let open_ok = c != '_' || i == 0 || !chars[i - 1].is_alphanumeric();
            if open_ok {
                let delim = [c, c];
                if let Some(end) = find_delim(&chars, i + 2, &delim) {
                    let close_ok =
                        c != '_' || end + 2 >= chars.len() || !chars[end + 2].is_alphanumeric();
                    if close_ok {
                        flush!();
                        let inner: String = chars[i + 2..end].iter().collect();
                        out.extend(inline_spans(&inner, base.add_modifier(Modifier::BOLD)));
                        i = end + 2;
                        continue;
                    }
                }
            }
        }

        // strikethrough ~~...~~
        if c == '~' && i + 1 < chars.len() && chars[i + 1] == '~' {
            let delim = ['~', '~'];
            if let Some(end) = find_delim(&chars, i + 2, &delim) {
                flush!();
                let inner: String = chars[i + 2..end].iter().collect();
                out.extend(inline_spans(&inner, base.add_modifier(Modifier::CROSSED_OUT)));
                i = end + 2;
                continue;
            }
        }

        // emphasis *...* or _..._
        if c == '*' || c == '_' {
            // Same `_` word-boundary flanking as strong above: `snake_case`'s
            // inner `_` must not turn `case` italic. `*` is exempt.
            let open_ok = c != '_' || i == 0 || !chars[i - 1].is_alphanumeric();
            if open_ok {
                if let Some(end) = find_single_em(&chars, i + 1, c) {
                    let close_ok =
                        c != '_' || end + 1 >= chars.len() || !chars[end + 1].is_alphanumeric();
                    if close_ok {
                        flush!();
                        let inner: String = chars[i + 1..end].iter().collect();
                        out.extend(inline_spans(&inner, base.add_modifier(Modifier::ITALIC)));
                        i = end + 1;
                        continue;
                    }
                }
            }
        }

        // link [text](url)
        if c == '[' {
            if let Some((text_end, url_start, url_end)) = parse_link(&chars, i) {
                flush!();
                let inner: String = chars[i + 1..text_end].iter().collect();
                let href: String = chars[url_start..url_end].iter().collect();
                let link_style = base.fg(ACTION).add_modifier(Modifier::UNDERLINED);
                let mut sub = inline_spans(&inner, link_style);
                for s in &mut sub {
                    if s.href.is_none() {
                        s.href = Some(href.clone());
                    }
                }
                out.extend(sub);
                i = url_end + 1; // skip past ')'
                continue;
            }
        }

        // bare URL autolink (GFM): a naked `http://`/`https://` becomes a link
        // (ACTION + underline), same as an explicit `[t](u)`. Only fires at a
        // boundary (previous char non-alphanumeric) so it can't start mid-word.
        if (c == 'h' || c == 'H') && url_scheme_len(&chars, i).is_some() {
            let boundary = i == 0 || !chars[i - 1].is_alphanumeric();
            if boundary {
                let end = scan_url_end(&chars, i);
                if end > i {
                    flush!();
                    let url: String = chars[i..end].iter().collect();
                    out.push(InlineSpan {
                        text: url.clone(),
                        style: base.fg(ACTION).add_modifier(Modifier::UNDERLINED),
                        code: false,
                        href: Some(url),
                    });
                    i = end;
                    continue;
                }
            }
        }

        // hard break: backslash at EOL or two trailing spaces are handled by
        // wrap via explicit `\n`; a literal `\n` becomes a break unit below.
        buf.push(c);
        i += 1;
    }
    flush!();
    out
}

fn find_code_close(chars: &[char], from: usize, fence: usize) -> Option<usize> {
    let mut i = from;
    while i < chars.len() {
        if chars[i] == '`' {
            let mut run = 0;
            while i + run < chars.len() && chars[i + run] == '`' {
                run += 1;
            }
            if run == fence {
                return Some(i);
            }
            i += run;
        } else {
            i += 1;
        }
    }
    None
}

fn trim_code_span(s: &str) -> String {
    if s.len() >= 2 && s.starts_with(' ') && s.ends_with(' ') && s.trim().len() != s.len() {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

/// Find a closing two-char `delim` starting at `from`. Returns index of the first
/// delim char. The run must not be immediately preceded by whitespace-only emptiness.
fn find_delim(chars: &[char], from: usize, delim: &[char; 2]) -> Option<usize> {
    let mut i = from;
    while i + 1 < chars.len() {
        if chars[i] == delim[0] && chars[i + 1] == delim[1] && i > from {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Find single-char emphasis close `c` at >= from, not part of a double-run.
fn find_single_em(chars: &[char], from: usize, c: char) -> Option<usize> {
    if from >= chars.len() || chars[from].is_whitespace() {
        return None; // opening delimiter must be followed by non-space
    }
    let mut i = from;
    while i < chars.len() {
        if chars[i] == c {
            // not a double-run (that would be strong/strike, handled earlier)
            let prev_ws = i == 0 || chars[i - 1].is_whitespace();
            if !prev_ws && i > from {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

/// Parse a `[text](url)` link starting at `[` (index `open`). Returns
/// `(text_end, url_start, url_end)` where `text_end` is index of `]`, url spans
/// `[url_start, url_end)` and `url_end` is index of `)`.
fn parse_link(chars: &[char], open: usize) -> Option<(usize, usize, usize)> {
    // find matching ] (no nested [] support — good enough)
    let mut depth = 0;
    let mut i = open;
    let mut text_end = None;
    while i < chars.len() {
        match chars[i] {
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    text_end = Some(i);
                    break;
                }
            }
            _ => {}
        }
        i += 1;
    }
    let text_end = text_end?;
    if text_end + 1 >= chars.len() || chars[text_end + 1] != '(' {
        return None;
    }
    let url_start = text_end + 2;
    let mut j = url_start;
    while j < chars.len() && chars[j] != ')' {
        j += 1;
    }
    if j >= chars.len() {
        return None;
    }
    Some((text_end, url_start, j))
}

/// Length of a `http://`/`https://` scheme at `i` (case-insensitive), or `None`.
fn url_scheme_len(chars: &[char], i: usize) -> Option<usize> {
    let head: String = chars[i..]
        .iter()
        .take(8)
        .collect::<String>()
        .to_ascii_lowercase();
    if head.starts_with("https://") {
        Some(8)
    } else if head.starts_with("http://") {
        Some(7)
    } else {
        None
    }
}

/// End index of a bare URL starting at `start`: consume non-whitespace, then trim
/// trailing punctuation that reads as sentence punctuation rather than URL (a
/// simplified GFM autolink tail rule — `.,;:!?'"` always, and `)` only when it is
/// unbalanced within the URL, so `…/wiki/Foo_(bar)` keeps its closing paren).
fn scan_url_end(chars: &[char], start: usize) -> usize {
    let mut j = start;
    while j < chars.len() {
        let ch = chars[j];
        if ch.is_whitespace() || ch == '<' || ch == '>' || ch == '`' || ch == '"' {
            break;
        }
        j += 1;
    }
    while j > start {
        let last = chars[j - 1];
        if matches!(last, '.' | ',' | ';' | ':' | '!' | '?' | '\'') {
            j -= 1;
        } else if last == ')' {
            let opens = chars[start..j].iter().filter(|&&c| c == '(').count();
            let closes = chars[start..j].iter().filter(|&&c| c == ')').count();
            if closes > opens {
                j -= 1;
            } else {
                break;
            }
        } else {
            break;
        }
    }
    j
}

// ─── soft wrapping ───────────────────────────────────────────────────────────

/// Wrap inline spans to `width` columns: greedy, never breaks mid-word, code
/// spans are atomic, `\n` forces a break. Mirrors `wrapSpans` in TS.
fn wrap_spans(spans: &[InlineSpan], width: usize) -> Vec<Vec<InlineSpan>> {
    if width == 0 {
        return vec![spans.to_vec()];
    }
    // tokenize into units: word | whitespace | break | atomic-code
    struct Unit {
        text: String,
        is_space: bool,
        is_break: bool,
        style: Style,
        code: bool,
        href: Option<String>,
    }
    let mut units: Vec<Unit> = Vec::new();
    for s in spans {
        if s.text.is_empty() {
            continue;
        }
        if s.code {
            units.push(Unit {
                text: s.text.clone(),
                is_space: false,
                is_break: false,
                style: s.style,
                code: true,
                href: s.href.clone(),
            });
            continue;
        }
        let segs: Vec<&str> = s.text.split('\n').collect();
        for (si, seg) in segs.iter().enumerate() {
            if si > 0 {
                units.push(Unit {
                    text: String::new(),
                    is_space: false,
                    is_break: true,
                    style: Style::default(),
                    code: false,
                    href: None,
                });
            }
            if seg.is_empty() {
                continue;
            }
            for part in split_keep_ws(seg) {
                let is_space = part.chars().all(|c| c.is_whitespace());
                units.push(Unit {
                    text: part,
                    is_space,
                    is_break: false,
                    style: s.style,
                    code: false,
                    href: s.href.clone(),
                });
            }
        }
    }

    let mut lines: Vec<Vec<InlineSpan>> = vec![Vec::new()];
    let mut cur_width = 0usize;
    let mut at_line_start = true;
    for u in units {
        if u.is_break {
            lines.push(Vec::new());
            cur_width = 0;
            at_line_start = true;
            continue;
        }
        if u.is_space && at_line_start {
            continue;
        }
        let w = text_width(&u.text);
        if cur_width + w > width && !at_line_start {
            lines.push(Vec::new());
            cur_width = 0;
            at_line_start = true;
            if u.is_space {
                continue;
            }
        }
        lines.last_mut().unwrap().push(InlineSpan {
            text: u.text,
            style: u.style,
            code: u.code,
            href: u.href,
        });
        cur_width += w;
        at_line_start = false;
    }
    if lines.len() > 1 && lines.last().unwrap().is_empty() {
        lines.pop();
    }
    lines
}

/// Split a segment keeping whitespace runs as their own parts (like `/(\s+)/`).
fn split_keep_ws(seg: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_ws: Option<bool> = None;
    for c in seg.chars() {
        let is_ws = c.is_whitespace();
        match in_ws {
            Some(prev) if prev == is_ws => cur.push(c),
            _ => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
                cur.push(c);
                in_ws = Some(is_ws);
            }
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

// ─── span → Line conversion ───────────────────────────────────────────────

fn spans_to_line(spans: Vec<InlineSpan>) -> Line<'static> {
    if spans.is_empty() {
        return Line::from("");
    }
    let rendered: Vec<Span<'static>> = spans
        .into_iter()
        .map(|s| Span::styled(s.text, s.style))
        .collect();
    Line::from(rendered)
}

// ─── width / truncation helpers ───────────────────────────────────────────

/// Truncate a run of already-styled spans to `max` columns, appending a
/// THINKING-colored `…` when it overflows (span-aware, keeping each run's style).
/// Mirrors `truncateLine` in Markdown.tsx — used by code blocks (highlighted
/// spans) and table cells (inline-styled spans).
fn truncate_spans(spans: Vec<Span<'static>>, max: usize) -> Line<'static> {
    let mut used = 0usize;
    let mut out: Vec<Span<'static>> = Vec::new();
    for s in spans {
        let w = text_width(&s.content);
        if used + w <= max {
            out.push(s);
            used += w;
            continue;
        }
        // This span overflows: keep as many chars as fit before the `…` (which
        // itself costs one column, hence `max - 1`), preserving the span style.
        let mut cut = String::new();
        let mut cw = 0usize;
        for ch in s.content.chars() {
            let chw = char_width(ch);
            if used + cw + chw > max.saturating_sub(1) {
                break;
            }
            cut.push(ch);
            cw += chw;
        }
        if !cut.is_empty() {
            out.push(Span::styled(cut, s.style));
        }
        out.push(Span::styled("…", Style::default().fg(THINKING)));
        return Line::from(out);
    }
    Line::from(out)
}

/// Truncate a plain code line to `max` columns, appending a THINKING-colored `…`.
fn truncate_plain(s: &str, max: usize) -> Line<'static> {
    if text_width(s) <= max {
        return Line::from(s.to_string());
    }
    let mut cut = String::new();
    let mut used = 0;
    for ch in s.chars() {
        let w = char_width(ch);
        if used + w > max.saturating_sub(1) {
            break;
        }
        cut.push(ch);
        used += w;
    }
    Line::from(vec![
        Span::raw(cut),
        Span::styled("…", Style::default().fg(THINKING)),
    ])
}

/// Clip a string to `max` columns (no ellipsis), for table cells.
fn clip_str(s: &str, max: usize) -> String {
    if text_width(s) <= max {
        return s.to_string();
    }
    if max == 0 {
        return String::new();
    }
    let mut cut = String::new();
    let mut used = 0;
    for ch in s.chars() {
        let w = char_width(ch);
        if used + w > max.saturating_sub(1) {
            break;
        }
        cut.push(ch);
        used += w;
    }
    cut.push('…');
    cut
}

/// Display width of a string (CJK / wide chars = 2). Mirrors `string-width`.
fn text_width(s: &str) -> usize {
    s.chars().map(char_width).sum()
}

/// Display columns occupied by a single char. Zero-width for combining marks,
/// 2 for East-Asian Wide/Fullwidth and most emoji, 1 otherwise. Hand-rolled (no
/// `unicode-width` crate per §0.1).
fn char_width(c: char) -> usize {
    let cp = c as u32;
    // C0/C1 controls (except handled elsewhere) contribute 0
    if cp == 0 {
        return 0;
    }
    // zero-width: combining marks, ZWJ/ZWNJ, variation selectors
    if matches!(cp,
        0x0300..=0x036F | 0x200B..=0x200F | 0xFE00..=0xFE0F | 0x1AB0..=0x1AFF |
        0x1DC0..=0x1DFF | 0x20D0..=0x20FF | 0xFE20..=0xFE2F)
    {
        return 0;
    }
    if is_wide(cp) {
        2
    } else {
        1
    }
}

/// East-Asian Wide / Fullwidth ranges (approximation sufficient for CJK + emoji).
fn is_wide(cp: u32) -> bool {
    matches!(cp,
        0x1100..=0x115F |   // Hangul Jamo
        0x2329..=0x232A |   // angle brackets
        0x2E80..=0x303E |   // CJK radicals, Kangxi, CJK symbols/punct
        0x3041..=0x33FF |   // Hiragana..CJK compat
        0x3400..=0x4DBF |   // CJK Ext A
        0x4E00..=0x9FFF |   // CJK Unified
        0xA000..=0xA4CF |   // Yi
        0xAC00..=0xD7A3 |   // Hangul Syllables
        0xF900..=0xFAFF |   // CJK Compat Ideographs
        0xFE10..=0xFE19 |   // vertical forms
        0xFE30..=0xFE6F |   // CJK compat forms / small forms
        0xFF00..=0xFF60 |   // Fullwidth forms
        0xFFE0..=0xFFE6 |   // Fullwidth signs
        0x1F300..=0x1F64F | // Misc symbols & pictographs + emoticons
        0x1F900..=0x1F9FF | // Supplemental symbols & pictographs
        0x20000..=0x3FFFD)  // CJK Ext B+ (supplementary ideographic)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(lines: &[Line<'static>]) -> Vec<String> {
        lines
            .iter()
            .map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect::<String>())
            .collect()
    }

    #[test]
    fn heading_is_bold_no_hashes() {
        let out = render_markdown("# Hello World", 40);
        assert_eq!(plain(&out), vec!["Hello World".to_string()]);
        assert!(out[0].spans.iter().any(|s| s.style.add_modifier.contains(Modifier::BOLD)));
    }

    #[test]
    fn paragraph_soft_wraps() {
        // width is clamped to a 20-col floor (mirrors TS markdownRows max(20,..)).
        let out = render_markdown("alpha beta gamma delta epsilon zeta", 20);
        let p = plain(&out);
        assert!(p.len() >= 2, "should wrap: {p:?}");
        assert!(p.iter().all(|l| text_width(l) <= 20), "{p:?}");
    }

    #[test]
    fn bullet_list_marker() {
        let out = render_markdown("- one\n- two", 40);
        let p = plain(&out);
        assert_eq!(p[0], "\u{2022} one");
        assert_eq!(p[1], "\u{2022} two");
    }

    #[test]
    fn ordered_list_marker() {
        let out = render_markdown("1. one\n2. two", 40);
        let p = plain(&out);
        assert_eq!(p[0], "1. one");
        assert_eq!(p[1], "2. two");
    }

    #[test]
    fn hr_is_full_width() {
        // width clamped to 20-col floor (mirrors TS markdownRows max(20,..)).
        let out = render_markdown("---", 24);
        assert_eq!(plain(&out)[0], "─".repeat(24));
    }

    #[test]
    fn inline_code_is_accent() {
        let out = render_markdown("use `code` here", 40);
        let span = out[0]
            .spans
            .iter()
            .find(|s| s.content == "code")
            .expect("code span");
        assert_eq!(span.style.fg, Some(ACCENT));
    }

    #[test]
    fn blockquote_prefix_and_dim() {
        let out = render_markdown("> quoted", 40);
        let line = &out[0];
        assert_eq!(line.spans[0].content, "\u{258f} ");
        assert_eq!(line.spans[0].style.fg, Some(THINKING));
        assert!(line.spans[1].style.add_modifier.contains(Modifier::DIM));
    }

    #[test]
    fn code_block_lang_dim_and_body() {
        let out = render_markdown("```rust\nlet x = 1;\n```", 40);
        let p = plain(&out);
        assert_eq!(p[0], "rust");
        assert!(out[0].spans[0].style.add_modifier.contains(Modifier::DIM));
        assert_eq!(p[1], "let x = 1;");
    }

    #[test]
    fn link_is_action_underlined() {
        let out = render_markdown("[text](http://x)", 40);
        let span = &out[0].spans[0];
        assert_eq!(span.content, "text");
        assert_eq!(span.style.fg, Some(ACTION));
        assert!(span.style.add_modifier.contains(Modifier::UNDERLINED));
    }

    #[test]
    fn cjk_width_is_two() {
        assert_eq!(char_width('中'), 2);
        assert_eq!(char_width('a'), 1);
        assert_eq!(text_width("中a"), 3);
    }

    #[test]
    fn cjk_no_interchar_space() {
        // The rendered Line content must NOT have spaces inserted between CJK
        // glyphs (the bug seen in the terminal: `看 起 来 ...`).
        let out = render_markdown("看起来你还在打字中—不着急", 80);
        let s: String = out
            .iter()
            .flat_map(|l| l.spans.iter())
            .map(|x| x.content.as_ref())
            .collect();
        assert_eq!(s, "看起来你还在打字中—不着急", "got: {s:?}");
    }

    #[test]
    fn bold_and_italic_and_strike() {
        let out = render_markdown("**b** *i* ~~s~~", 40);
        let line = &out[0];
        let find = |t: &str| line.spans.iter().find(|s| s.content == t).unwrap().style;
        assert!(find("b").add_modifier.contains(Modifier::BOLD));
        assert!(find("i").add_modifier.contains(Modifier::ITALIC));
        assert!(find("s").add_modifier.contains(Modifier::CROSSED_OUT));
    }

    // Collect every span across all rendered rows (helper for the new tests).
    fn all_spans(lines: &[Line<'static>]) -> Vec<Span<'static>> {
        lines.iter().flat_map(|l| l.spans.iter().cloned()).collect()
    }

    #[test]
    fn underscore_intraword_is_literal() {
        // `some_var_name` must stay literal — the inner `_var_` is NOT italic.
        let out = render_markdown("some_var_name here", 40);
        let joined: String = plain(&out).join("");
        assert_eq!(joined, "some_var_name here");
        for s in all_spans(&out) {
            assert!(
                !s.style.add_modifier.contains(Modifier::ITALIC),
                "no italic: {:?}",
                s.content
            );
        }
    }

    #[test]
    fn underscore_emphasis_at_word_boundary() {
        // `_italic_` flanked by spaces DOES emphasize.
        let out = render_markdown("an _italic_ word", 40);
        let span = all_spans(&out)
            .into_iter()
            .find(|s| s.content == "italic")
            .expect("italic span");
        assert!(span.style.add_modifier.contains(Modifier::ITALIC));
    }

    #[test]
    fn star_emphasis_still_intraword() {
        // `*` is exempt from the flanking rule (kept as-is).
        let out = render_markdown("a*b*c", 40);
        let span = all_spans(&out)
            .into_iter()
            .find(|s| s.content == "b")
            .expect("b span");
        assert!(span.style.add_modifier.contains(Modifier::ITALIC));
    }

    #[test]
    fn bare_url_is_autolinked() {
        let out = render_markdown("see http://example.com now", 40);
        let span = all_spans(&out)
            .into_iter()
            .find(|s| s.content == "http://example.com")
            .expect("url span");
        assert_eq!(span.style.fg, Some(ACTION));
        assert!(span.style.add_modifier.contains(Modifier::UNDERLINED));
    }

    #[test]
    fn bare_url_trailing_punctuation_trimmed() {
        let out = render_markdown("go to https://a.com.", 40);
        let s: String = plain(&out).join("");
        assert!(s.ends_with("https://a.com."), "{s:?}");
        // the URL span excludes the trailing period
        let span = all_spans(&out)
            .into_iter()
            .find(|s| s.style.fg == Some(ACTION))
            .expect("url span");
        assert_eq!(span.content, "https://a.com");
    }

    #[test]
    fn code_in_link_keeps_link_color() {
        // Inline code inside a link keeps ACTION (link color), not ACCENT.
        let out = render_markdown("[`x`](http://y)", 40);
        let span = all_spans(&out)
            .into_iter()
            .find(|s| s.content == "x")
            .expect("code span");
        assert_eq!(span.style.fg, Some(ACTION));
    }

    #[test]
    fn code_outside_link_is_accent() {
        let out = render_markdown("plain `x` code", 40);
        let span = all_spans(&out)
            .into_iter()
            .find(|s| s.content == "x")
            .expect("code span");
        assert_eq!(span.style.fg, Some(ACCENT));
    }

    #[test]
    fn code_block_syntax_highlight() {
        let out = render_markdown("```rust\nfn main() { let x = 42; }\n```", 60);
        let spans = all_spans(&out);
        let fg_of = |t: &str| {
            spans
                .iter()
                .find(|s| s.content == t)
                .unwrap_or_else(|| panic!("span {t:?} not found"))
                .style
                .fg
        };
        assert_eq!(fg_of("fn"), Some(COST), "keyword");
        assert_eq!(fg_of("let"), Some(COST), "keyword");
        assert_eq!(fg_of("main"), Some(ACCENT), "call head");
        assert_eq!(fg_of("42"), Some(APPROVAL), "number");
    }

    #[test]
    fn code_block_comment_and_string() {
        let out = render_markdown("```js\nconst s = \"hi\"; // note\n```", 60);
        let spans = all_spans(&out);
        let has = |t: &str, c: Color| {
            spans
                .iter()
                .any(|s| s.content.contains(t) && s.style.fg == Some(c))
        };
        assert!(has("\"hi\"", SUCCESS), "string green");
        assert!(has("// note", THINKING), "comment thinking");
        // `#` is NOT a comment in js, so it wouldn't be colored (sanity: keyword)
        assert!(has("const", COST), "keyword cost");
    }

    #[test]
    fn table_cell_inline_styles() {
        let md = "| a | b |\n| --- | --- |\n| `code` | **bold** |";
        let out = render_markdown(md, 40);
        let spans = all_spans(&out);
        // inline code cell → ACCENT; bold cell → BOLD modifier
        assert!(
            spans.iter().any(|s| s.content == "code" && s.style.fg == Some(ACCENT)),
            "code cell accent"
        );
        assert!(
            spans
                .iter()
                .any(|s| s.content == "bold" && s.style.add_modifier.contains(Modifier::BOLD)),
            "bold cell"
        );
    }
}
