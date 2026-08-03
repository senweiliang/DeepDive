//! deepdive-tui (Rust) — crossterm frontend for the DeepDive engine.
//!
//! Architecture (§2 of PARITY_SPEC): the TUI does NOT enter the alternate screen.
//! Committed transcript blocks are printed into the terminal's native scrollback
//! (mouse-wheel scrollback, the moral equivalent of Ink's `<Static>`); the bottom
//! live region — streaming preview + Running + modal/input + footer — is repainted
//! in place at the exact height of its content by [`region::LiveRegion`], so the
//! input box hugs the last history line with no reserved blank padding. (ratatui's
//! `Viewport::Inline` can't be cheaply resized — `resize`/recreate both issue a
//! DSR query that times out under streaming — so we drive the region ourselves.)
//!
//! An engine task owns the [`Session`] + the [`UiToCore`] receiver and runs one
//! [`run_turn_loop`] per submission; the UI task runs a `tokio::select!` over the
//! crossterm event stream + the [`AgentEvent`] stream, folding events into the
//! tested [`app::AppState`] render model, committing newly-finished rows to
//! scrollback, and repainting the live region each iteration.

mod app;
mod region;
mod render;
mod terminal_title;
mod theme;
mod ui;

use anyhow::Result;
use app::{AppState, Modal, ResumePick, Row, SessionEntry, Status};
use region::LiveRegion;
use render::input::InputAction;
use crossterm::event::{Event, EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use crossterm::terminal::{disable_raw_mode, enable_raw_mode};
use deepdive_core::engine::{
    add_session_dir, compact_now, connect_mcp, drain_background, reload_agent_listing,
    run_turn_loop, Session,
};
use deepdive_core::{AgentEvent, ApprovalDecision, ApprovalMode, Config, UiToCore};
use futures_util::StreamExt;
use std::collections::HashMap;
use std::io::{BufWriter, Stdout};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

/// Buffered stdout we paint the live region into (one flush per frame).
type Out = BufWriter<Stdout>;

type Reply = Option<oneshot::Sender<ApprovalDecision>>;
type QReply = Option<oneshot::Sender<Option<HashMap<String, String>>>>;

/// The running turn's cancel token, shared engine↔UI. The engine stores whichever
/// token drives the current turn (start_tx turns AND idle-`UserInput` turns); the
/// UI reads it for Ctrl+C / Esc. Held only for the brief store/read (no await).
type SharedCancel = Arc<Mutex<Option<CancellationToken>>>;

/// Startup resume intent, parsed from argv (mirrors `cli.tsx` `ResumeMode`).
#[derive(Debug, Clone, PartialEq, Eq)]
enum ResumeMode {
    /// Fresh session.
    Off,
    /// Open the session picker at startup (`-r` with no id).
    Picker,
    /// Resume a specific id (or the `"last"` sentinel for `-c`).
    Id(String),
}

struct Startup {
    resume: ResumeMode,
}

/// Parse `-r/--resume [id]`, `-c/--continue`, `-h/--help` (port of `cli.tsx`
/// `parseArgs`). `-r` followed by a non-flag token resumes that id; bare `-r`
/// opens the picker; `-c` resumes the most recent session.
fn parse_args(argv: &[String]) -> (Startup, bool) {
    let mut resume = ResumeMode::Off;
    let mut help = false;
    let mut i = 0;
    while i < argv.len() {
        let a = argv[i].as_str();
        match a {
            "-r" | "--resume" => {
                // A following token is the id only when non-empty and not a flag
                // (TS `next && !next.startsWith("-")`); otherwise open the picker.
                if let Some(next) = argv.get(i + 1).filter(|n| !n.is_empty() && !n.starts_with('-')) {
                    resume = ResumeMode::Id(next.clone());
                    i += 1;
                } else {
                    resume = ResumeMode::Picker;
                }
            }
            "-c" | "--continue" => resume = ResumeMode::Id("last".to_string()),
            "-h" | "--help" => help = true,
            _ => {}
        }
        i += 1;
    }
    (Startup { resume }, help)
}

fn print_help() {
    print!(
        "{}",
        [
            "deepdive — DeepSeek terminal coding agent (TUI)",
            "",
            "Usage:",
            "  deepdive-tui               start a new session",
            "  deepdive-tui -r            pick a previous session to resume",
            "  deepdive-tui -r <id>       resume a specific session by id",
            "  deepdive-tui -c            resume the most recent session",
            "  deepdive-tui -h            show this help",
            "",
        ]
        .join("\n"),
    );
}

#[tokio::main]
async fn main() -> Result<()> {
    if let Ok(cwd) = std::env::current_dir() {
        deepdive_core::workspace::set_original_cwd(cwd);
    }

    let argv: Vec<String> = std::env::args().skip(1).collect();
    let (mut startup, help) = parse_args(&argv);
    if help {
        print_help();
        return Ok(());
    }

    let config = Config::load();

    // Resolve an explicit id resume before entering raw mode, so a "not found"
    // is a clean stderr error + exit (mirrors cli.tsx resumeById).
    if let ResumeMode::Id(id) = &startup.resume {
        // Two distinct failures, like cli.tsx resumeById: nothing to resume
        // (`-c` with no history), vs. an id that resolved but failed to load.
        let real = if id == "last" {
            deepdive_core::session::latest_session_id()
        } else {
            Some(id.clone())
        };
        match real {
            None => {
                eprintln!("No previous session found.");
                std::process::exit(1);
            }
            Some(r) if deepdive_core::session::load_session(&r).is_some() => {
                startup.resume = ResumeMode::Id(r);
            }
            Some(r) => {
                eprintln!("Session {r} not found.");
                std::process::exit(1);
            }
        }
    }

    let http = deepdive_core::client::http_client();

    enable_raw_mode()?;
    install_panic_hook();
    // Buffered, so a whole frame's escape sequences land in one write (no tearing).
    let mut out: Out = BufWriter::with_capacity(64 * 1024, std::io::stdout());
    // Disable autowrap: the region renderer positions every row itself, and
    // width-filling lines (rules, padded user rows) must not wrap to a 2nd row.
    // Bracketed paste: a multi-line paste arrives as ONE Event::Paste, so its
    // embedded newlines don't submit the buffer at the first one.
    let _ = crossterm::queue!(
        out,
        crossterm::terminal::DisableLineWrap,
        crossterm::event::EnableBracketedPaste
    );
    let mut region = LiveRegion::new();
    // First run with no key anywhere: take one interactively, persist it, and
    // start the session with the reloaded config (cli.tsx `if (!config.apiKey)`).
    let res = match run_setup(&mut out, &mut region, config).await {
        Ok(Some(config)) => run(&mut out, &mut region, http, config, startup).await,
        // Quit at the key prompt: no session was ever started, so there is no
        // resume id to print below.
        Ok(None) => Ok(None),
        Err(e) => Err(e),
    };
    let _ = region.leave(&mut out);
    // Clear the terminal title so the tab doesn't show stale session info on
    // exit (no-op under DEEPDIVE_DISABLE_TERMINAL_TITLE; parity with the TS
    // clearTerminalTitle() and Claude Code's graceful-shutdown clear).
    terminal_title::clear_title();
    let _ = crossterm::execute!(
        out,
        crossterm::event::DisableBracketedPaste,
        crossterm::terminal::EnableLineWrap
    );
    let _ = disable_raw_mode();
    // Now that raw mode is off and the cursor is below the live region, print a
    // copyable resume command — the user can continue this session with
    // `deepdive-tui -r <id>` and skip the session picker (parity with the TS
    // exit hint in App.tsx). Only when the JSONL actually exists: a fresh
    // session with no messages is never flushed, so resuming would fail with
    // "Session not found".
    if let Ok(Some(id)) = &res {
        if deepdive_core::session::session_path(id).exists() {
            println!("deepdive-tui -r {id}");
        }
    }
    res.map(|_| ())
}

/// The first-run API-key gate (SetupScreen.tsx): returns the config to start the
/// session with — reloaded from disk once the key is saved — or `None` when the
/// user quits. A config that already carries a key passes straight through.
async fn run_setup(out: &mut Out, region: &mut LiveRegion, config: Config) -> Result<Option<Config>> {
    if !config.api_key.is_empty() {
        return Ok(Some(config));
    }

    let mut value = String::new();
    let mut error = String::new();
    let mut reader = EventStream::new();
    let mut force = true;
    loop {
        let (cols, _) = crossterm::terminal::size().unwrap_or((80, 24));
        let lines = render::setup::setup_lines(&value, &error, cols as usize);
        // No cursor: the key line is masked, so there is no cell to point at.
        region.render(out, &[], lines, None, force)?;
        force = false;

        match reader.next().await {
            Some(Ok(Event::Key(key))) if key.kind == KeyEventKind::Press => {
                let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
                match key.code {
                    KeyCode::Esc => return Ok(None),
                    KeyCode::Char('c') if ctrl => return Ok(None),
                    KeyCode::Enter => {
                        let trimmed = value.trim();
                        if trimmed.is_empty() {
                            error = render::setup::EMPTY_ERROR.to_string();
                        } else {
                            deepdive_core::config::save_api_key(trimmed);
                            return Ok(Some(Config::load()));
                        }
                    }
                    KeyCode::Backspace | KeyCode::Delete => {
                        value.pop();
                        error.clear();
                    }
                    // Typed text only, mirroring Ink's `input && !key.ctrl && !key.meta`.
                    KeyCode::Char(c)
                        if !key.modifiers.intersects(
                            KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER,
                        ) =>
                    {
                        value.push(c);
                        error.clear();
                    }
                    _ => {}
                }
            }
            // A pasted key arrives whole; drop every whitespace char so a trailing
            // newline or a line-wrapped copy can't corrupt it (SetupScreen usePaste).
            Some(Ok(Event::Paste(text))) => {
                value.extend(text.chars().filter(|c| !c.is_whitespace()));
                error.clear();
            }
            Some(Ok(Event::Resize(_, _))) => {
                let _ = region.reset_for_resize(out);
                force = true;
            }
            Some(Ok(_)) => {}
            // stdin closed or unreadable: there is no key coming.
            Some(Err(_)) | None => return Ok(None),
        }
    }
}

async fn run(
    out: &mut Out,
    region: &mut LiveRegion,
    http: reqwest::Client,
    config: Config,
    startup: Startup,
) -> Result<Option<String>> {
    let mut app = AppState::new(config.approval_mode);
    app.model = config.model.clone();
    // Feed the footer ctx gauge (TS `<Footer contextWindow={config.contextWindow}>`).
    app.context_window = Some(config.context_window);
    // Seed the live settings mirror that `/model` & `/settings` read/write.
    app.reasoning_effort = config.reasoning_effort.clone();
    app.tavily_api_key = config.tavily_api_key.clone();
    app.response_language = config.response_language.clone();
    app.turn_summary_strategy = config.turn_summary_strategy;

    // Startup resume: an explicit id loads its transcript into the model for
    // display (the engine builds a resumed Session below); the picker opens the
    // Resume modal so the first frame lets the user choose.
    let initial_resume: Option<String> = match &startup.resume {
        ResumeMode::Id(id) => Some(id.clone()),
        ResumeMode::Off | ResumeMode::Picker => None,
    };
    if let Some(id) = &initial_resume {
        app.load_history(rows_from_session(id));
        if let Some(ls) = deepdive_core::session::load_session(id) {
            app.usage = ls.usage;
            // Restored `/rename` title → terminal tab title on resume.
            app.session_title = ls.meta.and_then(|m| m.title);
        }
        // Resumed sessions are never AI-re-titled from mid-conversation context.
        app.ai_title_attempted = true;
    }

    let (events_tx, mut events_rx) = mpsc::channel::<AgentEvent>(256);
    let (commands_tx, commands_rx) = mpsc::channel::<UiToCore>(64);
    let (start_tx, mut start_rx) = mpsc::channel::<(String, CancellationToken)>(8);
    let (resume_tx, resume_rx) = mpsc::channel::<String>(4);
    let cur_cancel: SharedCancel = Arc::new(Mutex::new(None));
    // Engine → UI: the current session id (minted on new, swapped on resume,
    // re-minted on /clear). The UI prints `deepdive-tui -r <id>` on quit so
    // the user can resume this session without the picker (parity with the TS
    // exit hint in App.tsx).
    let (sid_tx, mut sid_rx) = mpsc::channel::<String>(8);

    // Engine task: owns the Session + the UiToCore receiver. `config` is owned
    // (mutable) here so `ApplySettings` can update the live model/reasoning/etc.
    let engine = {
        let http = http.clone();
        let mut config = config.clone();
        let initial_resume = initial_resume.clone();
        let cur_cancel = cur_cancel.clone();
        let mcp_status = app.mcp_status.clone();
        let sid_tx = sid_tx.clone();
        tokio::spawn(async move {
            let mut session = match initial_resume
                .and_then(|id| deepdive_core::session::load_session(&id).map(|ls| (id, ls)))
            {
                Some((id, ls)) => Session::resume(&config, id, ls.messages, ls.usage),
                None => Session::new(&config),
            };
            let _ = sid_tx.send(session.session_id.clone()).await;
            // Connect configured MCP servers: freezes tool schemas into `config`
            // and stores the live manager on the session. Publish statuses for /mcp.
            connect_mcp(&http, &mut config, &mut session).await;
            *mcp_status.lock().unwrap() = session.mcp.statuses();
            let mut commands_rx = commands_rx;
            let mut resume_rx = resume_rx;
            let mut notify = session.tasks.completion_notify();
            let bg_cancel = CancellationToken::new();
            loop {
                tokio::select! {
                    biased;
                    maybe = start_rx.recv() => {
                        let Some((input, cancel)) = maybe else { break };
                        run_turn_loop(
                            &http, &config, &mut session, input,
                            &events_tx, &mut commands_rx, &cancel,
                        )
                        .await;
                        drain_background(&http, &config, &mut session, &events_tx, &mut commands_rx, &bg_cancel).await;
                    }
                    _ = notify.notified() => {
                        drain_background(&http, &config, &mut session, &events_tx, &mut commands_rx, &bg_cancel).await;
                    }
                    Some(id) = resume_rx.recv() => {
                        if let Some(ls) = deepdive_core::session::load_session(&id) {
                            // Abort the old session's background tasks before
                            // swapping it out, else they run on detached.
                            session.tasks.abort_all();
                            let mcp = session.mcp.clone(); // keep MCP connections
                            session = Session::resume(&config, id, ls.messages, ls.usage);
                            session.mcp = mcp;
                            notify = session.tasks.completion_notify();
                            let _ = sid_tx.send(session.session_id.clone()).await;
                        }
                    }
                    cmd = commands_rx.recv() => {
                        match cmd {
                            // A submission that reached the engine while it had just
                            // gone idle (the UI still thought it was busy): start a
                            // turn here instead of dropping it (#10 race window).
                            Some(UiToCore::UserInput(input)) => {
                                let cancel = CancellationToken::new();
                                *cur_cancel.lock().unwrap() = Some(cancel.clone());
                                run_turn_loop(
                                    &http, &config, &mut session, input,
                                    &events_tx, &mut commands_rx, &cancel,
                                )
                                .await;
                                drain_background(&http, &config, &mut session, &events_tx, &mut commands_rx, &bg_cancel).await;
                            }
                            Some(UiToCore::ModeChange(m)) => session.mode = m,
                            Some(UiToCore::Compact) => { let _ = compact_now(&http, &config, &mut session).await; }
                            Some(UiToCore::Clear) => {
                                session.tasks.abort_all();
                                let mcp = session.mcp.clone(); // keep MCP connections
                                session = Session::new(&config);
                                session.mcp = mcp;
                                notify = session.tasks.completion_notify();
                                let _ = sid_tx.send(session.session_id.clone()).await;
                            }
                            // While idle these would otherwise be dropped (the
                            // run_turn_loop drain only sees them mid-turn).
                            Some(UiToCore::AddDir(d)) => add_session_dir(&mut session, &d),
                            Some(UiToCore::Rename(t)) => {
                                deepdive_core::session::update_session_title(&session.session_id, &t)
                            }
                            Some(UiToCore::ReloadAgents) => reload_agent_listing(&mut session),
                            // Idle /btw: same detached-fork helper the busy-path
                            // drain uses, off whatever history exists right now.
                            Some(UiToCore::AskSideQuestion { question, prior_exchanges }) => {
                                deepdive_core::engine::spawn_side_question(
                                    &http, &config, &session.history, prior_exchanges, question,
                                    &events_tx,
                                )
                            }
                            // Apply settings live to the engine config (idle-only,
                            // guarded busy in the frontend so it never races a turn).
                            Some(UiToCore::ApplySettings {
                                model,
                                reasoning_effort,
                                tavily_api_key,
                                turn_summary_strategy,
                            }) => {
                                config.context_window =
                                    deepdive_core::config::model_context_window(&model);
                                config.model = model;
                                config.reasoning_effort = reasoning_effort;
                                config.tavily_api_key = tavily_api_key;
                                config.turn_summary_strategy = turn_summary_strategy;
                            }
                            _ => {}
                        }
                    }
                }
            }
            // UI is shutting down (start_tx dropped) — abort any background tasks.
            session.tasks.abort_all();
        })
    };

    // Picker startup (`-r` with no id): open the Resume modal on the first frame.
    if startup.resume == ResumeMode::Picker {
        let sessions = session_entries();
        if !sessions.is_empty() {
            app.show_resume(sessions);
        }
    }

    let mut approval_reply: Reply = None;
    let mut question_reply: QReply = None;

    // One-shot account-balance fetch for the footer (best-effort, off the hot path).
    let (balance_tx, mut balance_rx) = mpsc::channel::<Option<String>>(1);
    {
        let http = http.clone();
        let config = config.clone();
        tokio::spawn(async move {
            let b = deepdive_core::balance::fetch_balance(&http, &config)
                .await
                .map(|b| b.total_balance); // footer shows ¥{number}, no currency (TS balance.totalBalance)
            let _ = balance_tx.send(b).await;
        });
    }
    let mut balance_done = false;

    let mut reader = EventStream::new();
    let mut tick = tokio::time::interval(Duration::from_millis(render::running::TICK_MS));
    let mut anim = ui::Anim::default();
    let mut turn_start: Option<Instant> = None;
    // Double-Ctrl-C-to-quit window.
    let mut last_ctrl_c: Option<Instant> = None;
    // Terminal tab title: the animated ⠂/⠐ prefix flips every 960ms while busy
    // (port of Claude Code's AnimatedTerminalTitle); written only on change so
    // the 90ms frame tick doesn't spam the OSC sequence.
    let mut title_frame = 0usize;
    let mut title_flip_at = Instant::now();
    let mut last_written_title: Option<String> = None;
    // AI session title (port of Claude Code's Haiku title): fire-and-forget a
    // flash call after the first real user message of a fresh session; the
    // result comes back on title_rx and lands in both JSONL meta and the
    // terminal title. Gate lives in `app.ai_title_attempted` (reset on /clear).
    let (title_tx, mut title_rx) = mpsc::channel::<String>(2);
    // The current session id, mirrored from the engine (fresh sessions mint
    // their id inside the engine task, so this can't be seeded up front).
    let mut current_session_id: Option<String> = None;
    // Repaint the whole live region next frame (first frame + after a resize).
    let mut force_redraw = true;
    // Whether the Ctrl+O overlay currently owns the alternate screen.
    let mut alt_active = false;

    loop {
        let (cols, rows) = crossterm::terminal::size().unwrap_or((80, 24));

        // Ctrl+O overlay: enter the alternate screen and hand the terminal to the
        // transcript pager. Rows committed while it is open deliberately stay
        // pending — they land in scrollback on close, which is simpler (and more
        // robust) than TS's replay of the <Static> bytes written to the alt
        // buffer. The live region's geometry is untouched, so closing resumes the
        // frame loop in place; `?1049l` restores the cursor `?1049h` saved.
        if app.transcript_open {
            if !alt_active {
                crossterm::queue!(out, crossterm::terminal::EnterAlternateScreen)?;
                alt_active = true;
            }
            let all = render::fullscreen::transcript_lines(&app.rows, cols as usize);
            let viewport = render::fullscreen::viewport_rows(rows as usize);
            app.set_transcript_geometry(all.len().saturating_sub(viewport), viewport);
            let frame = render::fullscreen::render(&all, app.transcript_offset, rows as usize);
            region::paint_fullscreen(out, &frame)?;
        } else {
            if alt_active {
                crossterm::queue!(out, crossterm::terminal::LeaveAlternateScreen)?;
                alt_active = false;
                // The main buffer is back byte-for-byte, but repaint the region
                // once rather than trusting the idle-skip cache across the switch.
                force_redraw = true;
            }

            // Newly-committed transcript rows (banner once, then each pending row)
            // get printed above the live region and scroll into native scrollback.
            let mut history: Vec<ratatui::text::Line<'static>> = Vec::new();
            if !app.banner_shown {
                history.extend(render::banner::banner_lines(
                    env!("CARGO_PKG_VERSION"),
                    &display_cwd(),
                ));
                app.banner_shown = true;
            }
            let pending: Vec<Row> = app.pending_rows().to_vec();
            for row in &pending {
                history.extend(render::transcript::row_lines(row, cols as usize));
            }
            app.mark_committed();

            // Drive the Running animation clock, then build + paint the live region
            // at its exact content height.
            anim.elapsed_ms = turn_start.map(|t| t.elapsed().as_millis() as u64).unwrap_or(0);
            // Cap the live region to one less than the screen height: the streaming
            // preview + footer is always shown in full (history scrolls up into
            // scrollback behind it, Ink-style), only trimmed if it alone would
            // exceed the screen (a non-<Static> region taller than the terminal
            // makes the renderer thrash the scrollback).
            let max_inline = (rows as usize).saturating_sub(1).max(1);
            let (live, cursor) = ui::build(&app, cols as usize, max_inline, anim);
            region.render(out, &history, live, cursor, force_redraw)?;
            force_redraw = false;
        }

        // Terminal tab/window title (OSC 0 / SetConsoleTitleW). Flip the
        // animated prefix every 960ms while busy; write only when the string
        // changes so the 90ms frame tick doesn't resend the sequence. Sits
        // outside the overlay branch: the title tracks the session, not which
        // screen is currently on top.
        if app.is_busy()
            && title_flip_at.elapsed()
                >= Duration::from_millis(terminal_title::TITLE_ANIMATION_INTERVAL_MS)
        {
            title_frame = (title_frame + 1) % terminal_title::TITLE_ANIMATION_FRAMES.len();
            title_flip_at = Instant::now();
        }
        let title = terminal_title::title_string(
            app.is_busy(),
            title_frame,
            app.session_title.as_deref(),
        );
        if last_written_title.as_ref() != Some(&title) {
            terminal_title::set_title(&title);
            last_written_title = Some(title);
        }

        // Fire-and-forget AI session title on the first real user message of a
        // fresh session (port of App.tsx's effect). Failures are silent — the
        // session keeps its default `/rename` title.
        if !app.ai_title_attempted && app.session_title.is_none() {
            if let Some(text) = first_real_user_row(&app.rows) {
                app.ai_title_attempted = true;
                let http = http.clone();
                let config = config.clone();
                let tx = title_tx.clone();
                let cancel = CancellationToken::new();
                tokio::spawn(async move {
                    let gen = deepdive_core::session_title::generate_session_title(
                        &http, &config, &text, &cancel,
                    );
                    if let Ok(Ok(Some(title))) = tokio::time::timeout(
                        deepdive_core::session_title::SESSION_TITLE_TIMEOUT,
                        gen,
                    )
                    .await
                    {
                        let _ = tx.send(title).await;
                    }
                });
            }
        }

        if app.should_quit {
            break;
        }

        tokio::select! {
            maybe_term = reader.next() => {
                match maybe_term {
                    Some(Ok(Event::Key(key))) if key.kind == KeyEventKind::Press => {
                        handle_key(
                            key, &mut app, &mut approval_reply, &mut question_reply,
                            &start_tx, &commands_tx, &resume_tx, &cur_cancel,
                            &mut last_ctrl_c, &mut turn_start, &config,
                        ).await;
                    }
                    // A resize reflows the terminal under us. Wipe the screen and
                    // replay the whole transcript (banner + every row) so the next
                    // frame repaints cleanly at the new width.
                    Some(Ok(Event::Resize(_, _))) => {
                        // While the overlay owns the alt screen the region isn't
                        // on screen: resetting it here would wipe its geometry and
                        // force a full transcript replay on close. The overlay
                        // repaints itself from scratch every frame anyway.
                        if !app.transcript_open {
                            let _ = region.reset_for_resize(out);
                            app.committed = 0;
                            app.banner_shown = false;
                        }
                        force_redraw = true;
                    }
                    // Bracketed paste into the Settings panel: a revealed secret
                    // row takes the whole payload as its Tavily key (SettingsPanel
                    // pastes the key wholesale rather than typing it).
                    Some(Ok(Event::Paste(text))) if matches!(app.modal, Modal::Settings { .. }) => {
                        app.settings_secret_paste(&text);
                    }
                    // Bracketed paste: insert the whole payload at once (embedded
                    // newlines become literal newlines, not a premature submit).
                    // Only into the main input — a modal owns the frame otherwise.
                    Some(Ok(Event::Paste(text))) if !app.has_modal() => {
                        let commands = render::input::builtin_commands();
                        app.input.insert_paste(&text, &commands);
                    }
                    _ => {}
                }
            }
            maybe_ev = events_rx.recv() => {
                match maybe_ev {
                    Some(ev) => {
                        if matches!(ev, AgentEvent::TurnStarted { .. }) {
                            turn_start = Some(Instant::now());
                        }
                        let completing = matches!(ev, AgentEvent::TurnComplete { .. } | AgentEvent::Error(_));
                        fold_event(ev, &mut app, &mut approval_reply, &mut question_reply);
                        if completing { turn_start = None; }
                    }
                    None => app.should_quit = true,
                }
            }
            b = balance_rx.recv(), if !balance_done => {
                balance_done = true;
                if let Some(val) = b { app.set_balance(val); }
            }
            Some(id) = sid_rx.recv() => current_session_id = Some(id),
            Some(title) = title_rx.recv() => {
                // AI-generated session title: persist to JSONL (session picker
                // shows it) and surface in the terminal tab title.
                if let Some(sid) = &current_session_id {
                    deepdive_core::session::update_session_title(sid, &title);
                }
                app.session_title = Some(title);
            }
            _ = tick.tick() => { anim.frame = anim.frame.wrapping_add(1); }
        }
    }

    // Never leave the shell holding the alternate screen (Ctrl+C inside the
    // overlay quits straight from here).
    if alt_active {
        let _ = crossterm::execute!(out, crossterm::terminal::LeaveAlternateScreen);
    }

    // Shut the engine down.
    drop(start_tx);
    if let Some(c) = cur_cancel.lock().unwrap().as_ref() {
        c.cancel();
    }
    let _ = engine.await;
    Ok(current_session_id)
}

/// Rows the resume picker jumps per PgUp/PgDn (SessionPicker.tsx pages by the
/// dynamic visible count; without a height budget at key time we use a constant).
const RESUME_PAGE: usize = 10;

fn display_cwd() -> String {
    let cwd = deepdive_core::workspace::original_cwd();
    let cwd = cwd.to_string_lossy().to_string();
    if let Some(home) = std::env::var_os("HOME") {
        let home = home.to_string_lossy().to_string();
        if cwd == home {
            return "~".to_string();
        }
        if let Some(rest) = cwd.strip_prefix(&format!("{home}/")) {
            return format!("~/{rest}");
        }
    }
    cwd
}

/// Fold an engine event into the render model. The reply oneshots for blocking
/// modals are stashed here (the model only renders the modal).
fn fold_event(ev: AgentEvent, app: &mut AppState, approval_reply: &mut Reply, question_reply: &mut QReply) {
    match ev {
        AgentEvent::TurnStarted { .. } => app.turn_started(),
        AgentEvent::ModelRouted { model } => app.active_model = Some(model),
        AgentEvent::ThinkingDelta(s) => app.on_thinking(s),
        AgentEvent::ContentDelta(s) => app.on_content(s),
        AgentEvent::AssistantMessage(m) => app.commit_assistant(&m.content),
        AgentEvent::ToolStarted { call_id, name, summary } => app.tool_started(&call_id, &name, &summary),
        AgentEvent::ToolFinished { call_id, result } => {
            // Show the real result body in the `⎿` block (not just the one-line
            // tag), and drive the tone from is_error so failed tools render red.
            let output = if result.content.trim().is_empty() {
                None
            } else {
                Some(result.content)
            };
            app.tool_finished(&call_id, output, !result.is_error)
        }
        AgentEvent::ApprovalRequest { req, reply } => {
            // Tool-aware summary (bash → command, file tools → path), matching
            // ConfirmBox.tsx's `summarizeArgs(toolName, args)` — not raw JSON.
            let summary = deepdive_core::tools::format::summarize_args(&req.tool_name, &req.args);
            app.show_approval(req.tool_name, summary, req.warning, req.save_patterns);
            *approval_reply = Some(reply);
        }
        AgentEvent::AskQuestion { items, reply } => {
            if items.is_empty() {
                let _ = reply.send(None);
            } else {
                app.show_question(items);
                *question_reply = Some(reply);
            }
        }
        AgentEvent::BashOutput { chunk, .. } => {
            // Show live bash output in the streaming area.
            let mut s = std::mem::take(&mut app.live_content);
            s.push_str(&chunk);
            app.on_content(s);
        }
        AgentEvent::Usage {
            usage,
            turn_cache_pct,
        } => app.set_usage(usage, turn_cache_pct),
        AgentEvent::BackgroundCount(n) => app.set_bg_tasks(n),
        AgentEvent::SubagentStep { name, summary, result, .. } => {
            app.push_subagent_step(&name, &summary, &result)
        }
        AgentEvent::SubagentProgress { agent_type, turn, tool_calls, .. } => {
            app.subagent_progress(&agent_type, turn, tool_calls)
        }
        AgentEvent::Recall(text) => {
            app.input.set_value(text);
            app.turn_complete();
        }
        AgentEvent::MemoryRecalled { count } => {
            let unit = if count == 1 { "memory" } else { "memories" };
            // MARKER = "  ⎿ " (2 spaces + U+23BF + single space).
            app.push_note(format!("  \u{23bf} Recalled {count} {unit}"));
        }
        AgentEvent::TurnComplete { .. } => app.turn_complete(),
        AgentEvent::Error(e) => {
            app.push_error(e);
            app.turn_complete();
        }
        AgentEvent::SideQuestion { question, result } => {
            app.set_side_question_result(&question, result)
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_key(
    key: KeyEvent,
    app: &mut AppState,
    approval_reply: &mut Reply,
    question_reply: &mut QReply,
    start_tx: &mpsc::Sender<(String, CancellationToken)>,
    commands_tx: &mpsc::Sender<UiToCore>,
    resume_tx: &mpsc::Sender<String>,
    cur_cancel: &SharedCancel,
    last_ctrl_c: &mut Option<Instant>,
    turn_start: &mut Option<Instant>,
    config: &Config,
) {
    // ── Ctrl+C while a modal is open (§15b) ──────────────────────────────────────
    // A blocking Approval/Question modal means a turn is parked on the user's
    // reply — Ctrl+C interrupts it (reject + cancel the turn). A transient user
    // modal (Model/Settings/Resume/AddDir) is simply dismissed, like Esc.
    if key.modifiers.contains(KeyModifiers::CONTROL)
        && matches!(key.code, KeyCode::Char('c'))
        && app.has_modal()
    {
        match &app.modal {
            Modal::Approval { .. } | Modal::Question { .. } => {
                reject_pending(approval_reply, question_reply);
                if let Some(c) = cur_cancel.lock().unwrap().as_ref() {
                    c.cancel();
                }
                app.dismiss_all_modals();
                app.footer_hint = Some("Press Ctrl-C again to exit".to_string());
                *last_ctrl_c = Some(Instant::now());
            }
            _ => app.dismiss_all_modals(),
        }
        return;
    }

    // ── Ctrl+O full-screen transcript (§12, App.tsx) ─────────────────────────────
    // Toggles from anywhere. While the overlay owns the screen it swallows every
    // other key except its own navigation — App.tsx returns early on
    // `transcriptOpen`, and TranscriptView's own useInput does the scrolling.
    if key.modifiers.contains(KeyModifiers::CONTROL) && matches!(key.code, KeyCode::Char('o')) {
        app.toggle_transcript();
        return;
    }
    if app.transcript_open {
        let page = app.transcript_page();
        match key.code {
            KeyCode::Esc => app.transcript_open = false,
            KeyCode::Up | KeyCode::Char('k') => app.transcript_scroll(-1),
            KeyCode::Down | KeyCode::Char('j') => app.transcript_scroll(1),
            KeyCode::PageUp => app.transcript_scroll(-page),
            KeyCode::PageDown => app.transcript_scroll(page),
            KeyCode::Char('g') => app.transcript_top(),
            KeyCode::Char('G') => app.transcript_bottom(),
            _ => {}
        }
        return;
    }

    // ── Modal keys take priority (§12 mutual-exclusion). ─────────────────────────
    if let Modal::Approval {
        tool_name,
        save_patterns,
        selected,
        ..
    } = &app.modal
    {
        // The option list order must mirror render::modals::render_approval so the
        // ↑↓ highlight and the resolved decision line up (§11 ConfirmBox).
        let decisions = approval_decisions(tool_name, save_patterns);
        let n = decisions.len();
        // ↑↓ navigates the rendered selection; Enter executes the highlighted one;
        // y/a/n keep the hotkey fast-path; Esc denies (§11/§178).
        let chosen = match key.code {
            KeyCode::Up => {
                app.approval_move(-1, n);
                None
            }
            KeyCode::Down => {
                app.approval_move(1, n);
                None
            }
            KeyCode::Enter => decisions.get(*selected).cloned(),
            KeyCode::Char('y') | KeyCode::Char('Y') => Some(ApprovalDecision::Approve),
            KeyCode::Char('a') | KeyCode::Char('A') => {
                Some(ApprovalDecision::AllowAlways(save_patterns.clone()))
            }
            KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc => Some(ApprovalDecision::Deny),
            _ => None,
        };
        if let Some(d) = chosen {
            if let Some(tx) = approval_reply.take() {
                let _ = tx.send(d);
            }
            app.clear_modal();
        }
        return;
    }
    if matches!(app.modal, Modal::Question { .. }) {
        // Full AskQuestion.tsx interaction: ←→ switch tabs (incl. the Submit tab),
        // ↑↓ move within a question, Space toggles a checkbox (multi-select), the
        // Other row is a live text field, Enter commits/advances/submits.
        match key.code {
            KeyCode::Esc => {
                if let Some(tx) = question_reply.take() {
                    let _ = tx.send(None);
                }
                app.clear_modal();
            }
            KeyCode::Left => app.question_left(),
            KeyCode::Right => app.question_right(),
            KeyCode::Up => app.question_up(),
            KeyCode::Down => app.question_down(),
            KeyCode::Enter => {
                if let Some(ans) = app.question_enter() {
                    if let Some(tx) = question_reply.take() {
                        let _ = tx.send(Some(ans));
                    }
                    app.clear_modal();
                }
            }
            KeyCode::Backspace => app.question_backspace(),
            // Space toggles a checkbox unless the Other field has focus (then it's
            // a literal space); any other char feeds the Other field when focused.
            KeyCode::Char(' ') if !app.question_on_other() => app.question_toggle(),
            KeyCode::Char(c) if app.question_on_other() => app.question_type(c),
            _ => {}
        }
        return;
    }
    if matches!(app.modal, Modal::Resume { .. }) {
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => app.resume_move(-1),
            KeyCode::Down | KeyCode::Char('j') => app.resume_move(1),
            // Page by a fixed span (SessionPicker.tsx moves by the dynamic visible
            // count; the key handler has no height budget, so a constant page).
            KeyCode::PageUp => app.resume_move(-(RESUME_PAGE as i32)),
            KeyCode::PageDown => app.resume_move(RESUME_PAGE as i32),
            KeyCode::Char('g') => app.resume_jump(true),
            KeyCode::Char('G') => app.resume_jump(false),
            KeyCode::Enter => match app.resume_pick() {
                // "+ New session" (SessionPicker onSelect(null)): start a fresh
                // conversation, exactly like /clear (clears UI + engine session).
                Some(ResumePick::New) => {
                    app.clear_modal();
                    app.clear_conversation();
                    let _ = commands_tx.send(UiToCore::Clear).await;
                }
                Some(ResumePick::Session(id)) => {
                    // Only mutate the UI once the load is known to succeed, so the
                    // engine's session swap (resume_rx, also load-guarded) can't
                    // desync from the displayed transcript.
                    if let Some(ls) = deepdive_core::session::load_session(&id) {
                        app.clear_modal();
                        app.clear_conversation();
                        app.load_history(rows_from_session(&id));
                        app.usage = ls.usage; // seed the footer ctx gauge
                        let _ = resume_tx.send(id).await; // engine swaps its session
                    } else {
                        app.clear_modal();
                        app.push_error("无法加载该会话");
                    }
                }
                None => {}
            },
            KeyCode::Esc => app.clear_modal(),
            _ => {}
        }
        return;
    }
    // ── /model picker (ModelPanel) ───────────────────────────────────────────────
    if matches!(app.modal, Modal::Model { .. }) {
        match key.code {
            KeyCode::Up => app.model_move(-1),
            KeyCode::Down => app.model_move(1),
            KeyCode::Char(c) if c.is_ascii_digit() => {
                if let Some(d) = c.to_digit(10) {
                    app.model_jump(d as usize);
                }
            }
            KeyCode::Enter => {
                if let Some(model) = app.model_commit() {
                    deepdive_core::config::save_model(&model);
                    app.push_user("/model");
                    // ApplySettings is idle-only; if a background turn started
                    // while the modal was open, persist only (don't send a command
                    // the busy drain would silently drop).
                    if app.is_busy() {
                        app.rows.push(Row::Assistant(format!(
                            "已保存模型：`{model}`（写入设置文件）。运行中暂不热切换，将于本轮结束后的新请求/下次会话生效。"
                        )));
                    } else {
                        let _ = commands_tx.send(apply_settings_cmd(app)).await;
                        app.rows.push(Row::Assistant(format!(
                            "已保存模型：`{model}`（写入 ~/.deepdive/settings.json，下一轮请求起生效）。"
                        )));
                    }
                }
            }
            KeyCode::Esc => app.clear_modal(),
            _ => {}
        }
        return;
    }
    // ── /settings panel (SettingsPanel) ──────────────────────────────────────────
    if matches!(app.modal, Modal::Settings { .. }) {
        match key.code {
            KeyCode::Up => app.settings_row_move(-1),
            KeyCode::Down => app.settings_row_move(1),
            KeyCode::Left => app.settings_value_move(-1),
            KeyCode::Right => app.settings_value_move(1),
            KeyCode::Backspace | KeyCode::Delete => app.settings_secret_clear(),
            KeyCode::Enter => {
                if let Some(v) = app.settings_commit() {
                    deepdive_core::config::save_model(&v.model);
                    deepdive_core::config::save_reasoning_effort(&v.reasoning_effort);
                    deepdive_core::config::save_tavily_key(&v.tavily_api_key);
                    deepdive_core::config::save_response_language(&v.response_language);
                    deepdive_core::config::save_turn_summary_strategy(v.turn_summary);
                    app.push_user("/settings");
                    let tavily = if v.tavily_api_key.is_empty() { "未设置" } else { "已设置" };
                    let summary = format!(
                        "已保存：模型 `{}`，推理强度 `{}`，Tavily key `{}`，上一轮摘要 `{}`",
                        v.model,
                        v.reasoning_effort,
                        tavily,
                        turn_summary_label(v.turn_summary),
                    );
                    // ApplySettings is idle-only; persist-only when a background
                    // turn started while the panel was open (don't silently drop).
                    if app.is_busy() {
                        app.rows.push(Row::Assistant(format!(
                            "{summary}（写入设置文件；运行中暂不热切换，将于本轮结束后/下次会话生效）。回复语言 `{}` 已保存，**仅对新会话生效**。",
                            v.response_language,
                        )));
                    } else {
                        let _ = commands_tx.send(apply_settings_cmd(app)).await;
                        app.rows.push(Row::Assistant(format!(
                            "{summary}（写入 ~/.deepdive/settings.json，下一轮起生效）。回复语言 `{}` 已保存，**仅对新会话生效**——当前会话维持原语言。",
                            v.response_language,
                        )));
                    }
                }
            }
            // The Tavily key is paste-only (SettingsPanel.tsx has no char-typing
            // branch): regular keys are ignored while the panel is open.
            KeyCode::Esc => app.clear_modal(),
            _ => {}
        }
        return;
    }
    // ── /add-dir grant-scope confirm (AddDirConfirm) ─────────────────────────────
    if matches!(app.modal, Modal::AddDir { .. }) {
        match key.code {
            KeyCode::Up => app.adddir_move(-1),
            KeyCode::Down => app.adddir_move(1),
            KeyCode::Enter => {
                if let Some((path, sel)) = app.adddir_selected() {
                    app.clear_modal();
                    app.push_user(format!("/add-dir {path}"));
                    match sel {
                        0 => {
                            let _ = commands_tx.send(UiToCore::AddDir(path.clone())).await;
                            app.rows.push(Row::Assistant(format!(
                                "已添加额外工作区目录：`{path}`\n（仅本会话有效）"
                            )));
                        }
                        1 => {
                            deepdive_core::config::save_additional_directory(&path);
                            let _ = commands_tx.send(UiToCore::AddDir(path.clone())).await;
                            app.rows.push(Row::Assistant(format!(
                                "已添加额外工作区目录：`{path}`\n（已写入 ~/.deepdive/settings.json，下次启动自动加载）"
                            )));
                        }
                        _ => {
                            app.rows.push(Row::Assistant(format!(
                                "未将 `{path}` 添加为工作区目录。"
                            )));
                        }
                    }
                }
            }
            KeyCode::Esc => app.clear_modal(),
            _ => {}
        }
        return;
    }
    // ── /btw side question (BtwPanel) ────────────────────────────────────────────
    // Dismissing only clears this modal — it never touches cur_cancel, so the
    // main turn (if any is running) is completely unaffected (§ /btw contract).
    // While the last exchange is loading there's nothing to edit yet, so only
    // Esc/Ctrl-C/Ctrl-D (dismiss) do anything; once it settles, typing/
    // backspace/Enter drive the follow-up draft (Enter sends if non-empty,
    // else dismisses — mirrors the TS TextInput wiring in BtwPanel.tsx).
    if matches!(app.modal, Modal::Btw { .. }) {
        let btw_ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        if key.code == KeyCode::Esc || (btw_ctrl && matches!(key.code, KeyCode::Char('c') | KeyCode::Char('d')))
        {
            app.clear_modal();
            return;
        }
        if app.btw_loading() {
            return;
        }
        match key.code {
            KeyCode::Enter => {
                let q = app.btw_take_draft();
                if q.is_empty() {
                    app.clear_modal();
                } else {
                    let prior_exchanges = app.btw_prior_exchange_messages();
                    app.btw_push_pending(q.clone());
                    let _ = commands_tx
                        .send(UiToCore::AskSideQuestion { question: q, prior_exchanges })
                        .await;
                }
            }
            KeyCode::Backspace => app.btw_draft_backspace(),
            KeyCode::Char(c)
                if !btw_ctrl && !key.modifiers.contains(KeyModifiers::ALT) =>
            {
                app.btw_draft_push(c)
            }
            _ => {}
        }
        return;
    }

    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    // ── Global keys handled by main.rs (not the editor). ─────────────────────────
    match key.code {
        KeyCode::Char('c') if ctrl => {
            if app.is_busy() {
                // Interrupt the current turn + reject pending modals.
                if let Some(c) = cur_cancel.lock().unwrap().as_ref() {
                    c.cancel();
                }
                reject_pending(approval_reply, question_reply);
                app.footer_hint = Some("Press Ctrl-C again to exit".to_string());
                *last_ctrl_c = Some(Instant::now());
            } else if last_ctrl_c.map(|t| t.elapsed() < Duration::from_secs(1)).unwrap_or(false) {
                app.should_quit = true;
            } else if !app.input.is_empty() {
                app.input.take();
                *last_ctrl_c = Some(Instant::now());
                app.footer_hint = Some("Press Ctrl-C again to exit".to_string());
            } else {
                app.footer_hint = Some("Press Ctrl-C again to exit".to_string());
                *last_ctrl_c = Some(Instant::now());
            }
            return;
        }
        KeyCode::Char('d') if ctrl && app.input.is_empty() => {
            app.should_quit = true;
            return;
        }
        KeyCode::Esc => {
            app.footer_hint = None;
            if app.is_busy() {
                if let Some(c) = cur_cancel.lock().unwrap().as_ref() {
                    c.cancel();
                }
            }
            return;
        }
        KeyCode::BackTab => {
            let next = next_mode(app.mode);
            app.mode = next;
            let _ = commands_tx.send(UiToCore::ModeChange(next)).await;
            return;
        }
        _ => {}
    }

    // ── Everything else goes through the InputState editor (§7). ─────────────────
    app.footer_hint = None;
    let commands = render::input::builtin_commands();
    match app.input.handle_key(key, &commands) {
        InputAction::None => {}
        InputAction::Submit(line) => {
            if line.trim().is_empty() {
                return;
            }
            if line.trim_start().starts_with('/') {
                handle_slash(line.trim(), app, commands_tx, config).await;
                return;
            }
            if let Some(cmd) = line.strip_prefix('!') {
                // Inline bash: record as a bash user row, submit the command.
                let cmd = cmd.to_string();
                app.push_user_bash(cmd.clone());
                submit_turn(app, &cmd, start_tx, commands_tx, cur_cancel, turn_start).await;
                return;
            }
            app.push_user(line.clone());
            submit_turn(app, &line, start_tx, commands_tx, cur_cancel, turn_start).await;
        }
    }
}

/// The approval-modal options, in the SAME order they are rendered by
/// `render::modals::render_approval` (Allow once / [edit] Accept all edits /
/// [non-edit+savePattern] Allow always / Deny). Keeps ↑↓ highlight in sync with
/// the executed decision (§11).
fn approval_decisions(tool_name: &str, save_patterns: &[String]) -> Vec<ApprovalDecision> {
    let is_edit = tool_name == "write_file" || tool_name == "edit_file";
    let mut out = vec![ApprovalDecision::Approve];
    if is_edit {
        out.push(ApprovalDecision::AllowAlways(save_patterns.to_vec()));
    }
    if !is_edit && !save_patterns.is_empty() {
        out.push(ApprovalDecision::AllowAlways(save_patterns.to_vec()));
    }
    out.push(ApprovalDecision::Deny);
    out
}

/// Reject any pending approval/question modal (used on Ctrl+C interrupt).
fn reject_pending(approval_reply: &mut Reply, question_reply: &mut QReply) {
    if let Some(tx) = approval_reply.take() {
        let _ = tx.send(ApprovalDecision::Deny);
    }
    if let Some(tx) = question_reply.take() {
        let _ = tx.send(None);
    }
}

/// Submit a user turn: either start a fresh turn (idle) or queue it (busy). When
/// idle we mint the cancel token and publish it to the shared slot before sending
/// (so Ctrl+C/Esc can interrupt this turn); when busy the input is appended to
/// history by the running turn's command-drain. If the UI merely *thought* it was
/// busy (engine already idle), the engine's idle `UserInput` arm starts the turn
/// and publishes its own token — either way nothing is dropped (#10).
async fn submit_turn(
    app: &mut AppState,
    line: &str,
    start_tx: &mpsc::Sender<(String, CancellationToken)>,
    commands_tx: &mpsc::Sender<UiToCore>,
    cur_cancel: &SharedCancel,
    turn_start: &mut Option<Instant>,
) {
    if app.is_busy() {
        let _ = commands_tx.send(UiToCore::UserInput(line.to_string())).await;
    } else {
        app.status = Status::Busy;
        *turn_start = Some(Instant::now());
        let cancel = CancellationToken::new();
        *cur_cancel.lock().unwrap() = Some(cancel.clone());
        let _ = start_tx.send((line.to_string(), cancel)).await;
    }
}

/// Front-end slash commands for the TUI (mirrors the CLI/GUI set).
async fn handle_slash(
    line: &str,
    app: &mut AppState,
    commands_tx: &mpsc::Sender<UiToCore>,
    config: &Config,
) {
    let mut parts = line[1..].splitn(2, char::is_whitespace);
    let name = parts.next().unwrap_or("").to_lowercase();
    let arg = parts.next().unwrap_or("").trim();
    // Commands that reset/rebuild/swap the session or mutate the live config are
    // forbidden mid-turn (they'd clobber the streaming transcript or be dropped
    // by the busy command-drain). TS queues all slash input while streaming; we
    // reject these and let the user retry once idle.
    if app.is_busy()
        && matches!(
            name.as_str(),
            "clear" | "compact" | "model" | "settings" | "resume"
        )
    {
        app.push_error("运行中，无法执行该命令（先 Esc 中断）");
        return;
    }
    match name.as_str() {
        "clear" => {
            app.clear_conversation();
            let _ = commands_tx.send(UiToCore::Clear).await;
        }
        "compact" => {
            app.push_note("正在压缩对话…");
            let _ = commands_tx.send(UiToCore::Compact).await;
        }
        "resume" => {
            let sessions = session_entries();
            if sessions.is_empty() {
                app.push_note("没有可恢复的会话");
            } else {
                app.show_resume(sessions);
            }
        }
        "model" => {
            // TS model.ts rejects an argument: the picker is the only entry point.
            if arg.is_empty() {
                app.show_model();
            } else {
                app.push_error("输入 /model 后直接回车以选择 pro 或 flash。");
            }
        }
        "settings" => app.show_settings(),
        "rename" => {
            let title = arg.trim();
            if title.is_empty() {
                app.push_error("用法：/rename <会话标题>");
            } else {
                let _ = commands_tx.send(UiToCore::Rename(title.to_string())).await;
                app.push_user(format!("/rename {title}"));
                app.rows
                    .push(Row::Assistant(format!("已重命名会话为：「{title}」")));
                // Live terminal tab title (session title wins over the default).
                app.session_title = Some(title.to_string());
            }
        }
        "add-dir" => match validate_add_dir(arg, config) {
            AddDirResult::Empty => app.push_error("用法：/add-dir <路径>"),
            AddDirResult::NotFound(p) => app.push_error(format!("路径 `{p}` 不存在。")),
            AddDirResult::NotDir(p) => app.push_error(format!("`{p}` 不是目录。")),
            AddDirResult::Already { abs, wd } => {
                app.push_user(format!("/add-dir {arg}"));
                app.rows
                    .push(Row::Assistant(format!("`{abs}` 已经在 `{wd}` 范围内。")));
            }
            AddDirResult::Ok(abs) => app.show_add_dir(abs),
        },
        "agents" => {
            deepdive_core::agents::registry::reload_agents();
            let agents = deepdive_core::agents::registry::get_registered_agents();
            let body = if agents.is_empty() {
                "No agents found.".to_string()
            } else {
                agents
                    .iter()
                    .map(|ra| {
                        let src = match ra.source {
                            deepdive_core::agents::registry::AgentSource::BuiltIn => "built-in",
                            deepdive_core::agents::registry::AgentSource::User => "user",
                            deepdive_core::agents::registry::AgentSource::Project => "project",
                        };
                        let tools = match &ra.def.tools {
                            None => "all tools".to_string(),
                            Some(t) if t.is_empty() => "no tools".to_string(),
                            Some(t) => t.join(", "),
                        };
                        let model = ra
                            .def
                            .model
                            .as_ref()
                            .map(|m| format!(" · model {m}"))
                            .unwrap_or_default();
                        format!(
                            "**{}** _({})_ — {}{}\n  {}",
                            ra.def.agent_type, src, tools, model, ra.def.when_to_use
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n\n")
            };
            let note = format!(
                "可用 subagent（共 {} 个，自定义 agent 来自 `.deepdive/agents/*.md`，项目目录与 `~` 均扫描）：\n\n{}",
                agents.len(),
                body
            );
            app.push_user("/agents");
            app.rows.push(Row::Assistant(note));
            // Rebuild the in-session listing so a freshly-edited agent becomes
            // dispatchable this session (not just visible in the output above).
            let _ = commands_tx.send(UiToCore::ReloadAgents).await;
        }
        "btw" => {
            if arg.is_empty() {
                app.push_error("用法：/btw <问题>");
            } else {
                // Runs even mid-turn: show the panel immediately and let the
                // engine answer it off a snapshot, independent of any running
                // turn (see UiToCore::AskSideQuestion).
                app.show_btw(arg.to_string());
                let _ = commands_tx
                    .send(UiToCore::AskSideQuestion {
                        question: arg.to_string(),
                        prior_exchanges: Vec::new(),
                    })
                    .await;
            }
        }
        "mcp" => {
            let statuses = app.mcp_status.lock().unwrap().clone();
            app.push_user("/mcp");
            if statuses.is_empty() {
                app.rows.push(Row::Assistant(
                    "未配置 MCP 服务器（用 `deepdive mcp add <name> -- <命令> [参数...]` 添加，或编辑 settings.json / .mcp.json）".to_string(),
                ));
            } else {
                let mut lines = vec!["MCP 服务器".to_string()];
                for s in &statuses {
                    if s.connected {
                        lines.push(format!("● {} ({}, {} 个工具)", s.name, s.transport, s.tool_count));
                    } else {
                        let err = s.error.clone().unwrap_or_default();
                        lines.push(format!("● {} ({}) — 连接失败：{err}", s.name, s.transport));
                    }
                }
                app.rows.push(Row::Assistant(lines.join("\n")));
            }
        }
        "help" => app.push_note(
            "命令：/add-dir 加目录 · /agents 子代理 · /btw 侧问 · /clear 清空 · /compact 压缩 · /mcp MCP 状态 · /model 模型 · /rename 重命名 · /resume 恢复 · /settings 设置 · /mode <default|acceptEdits|plan|yolo|auto> · /help",
        ),
        "mode" => match parse_mode_name(arg) {
            Some(m) => {
                app.mode = m;
                let _ = commands_tx.send(UiToCore::ModeChange(m)).await;
                app.push_note(format!("审批模式 → {arg}"));
            }
            None => app.push_error("用法：/mode default|acceptEdits|plan|yolo|auto"),
        },
        other => app.push_error(format!("未知命令：/{other}")),
    }
}

/// Build the live-settings command from the app's settings mirror (sent after a
/// `/model` or `/settings` save). `response_language` is intentionally omitted —
/// it is frozen per session, persisted only (parity with App.tsx).
fn apply_settings_cmd(app: &AppState) -> UiToCore {
    UiToCore::ApplySettings {
        model: app.model.clone(),
        reasoning_effort: app.reasoning_effort.clone(),
        tavily_api_key: app.tavily_api_key.clone(),
        turn_summary_strategy: app.turn_summary_strategy,
    }
}

/// Human label for a turn-summary strategy, shown in the `/settings` save note.
fn turn_summary_label(t: deepdive_core::types::TurnSummaryStrategy) -> &'static str {
    use deepdive_core::types::TurnSummaryStrategy::*;
    match t {
        Off => "off",
        WholeTurn => "whole_turn",
        ToolOnly => "tool_only",
    }
}

/// Result of validating a `/add-dir` argument (port of `commands/adddir.ts`).
enum AddDirResult {
    Empty,
    NotFound(String),
    NotDir(String),
    Already { abs: String, wd: String },
    Ok(String),
}

/// Canonicalize for stable comparison; fall back to the raw path on error.
fn canon(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// Validate a `/add-dir` path: resolve against the frozen cwd, require an
/// existing directory, and report when it is already inside a working dir.
fn validate_add_dir(arg: &str, config: &Config) -> AddDirResult {
    let raw = arg.trim();
    if raw.is_empty() {
        return AddDirResult::Empty;
    }
    let cwd = deepdive_core::workspace::original_cwd();
    let expanded = deepdive_core::workspace::expand_tilde(raw);
    let joined = {
        let p = Path::new(&expanded);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            cwd.join(p)
        }
    };
    match std::fs::metadata(&joined) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => return AddDirResult::NotDir(joined.display().to_string()),
        Err(_) => return AddDirResult::NotFound(joined.display().to_string()),
    }
    let abs = canon(&joined);
    // Working dirs: frozen cwd + persisted additional directories.
    let mut working: Vec<PathBuf> = vec![canon(&cwd)];
    for d in &config.additional_directories {
        working.push(canon(Path::new(&deepdive_core::workspace::expand_tilde(d))));
    }
    for wd in &working {
        if &abs == wd || abs.starts_with(wd) {
            return AddDirResult::Already {
                abs: abs.display().to_string(),
                wd: wd.display().to_string(),
            };
        }
    }
    AddDirResult::Ok(abs.display().to_string())
}

/// Recent sessions for the `/resume` picker (id + a first-message title).
fn session_entries() -> Vec<SessionEntry> {
    deepdive_core::session::list_sessions()
        .into_iter()
        .take(30)
        .map(|s| {
            let title = deepdive_core::session::load_session(&s.id)
                .and_then(|ls| {
                    ls.messages.into_iter().find(|m| {
                        m.role == deepdive_core::Role::User && !m.meta && !m.content.trim().is_empty()
                    })
                })
                .map(|m| m.content.trim().chars().take(48).collect::<String>())
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| s.id.chars().take(8).collect());
            SessionEntry {
                id: s.id,
                title,
                when: None,
                msgs: None,
            }
        })
        .collect()
}

/// First real user row text: skips slash commands, inline bash and inputs
/// shorter than `MIN_DESCRIPTION_LENGTH` chars (port of TS `firstRealUserText`
/// — a user row can only be prose, `!bash` or `/slash`).
fn first_real_user_row(rows: &[Row]) -> Option<String> {
    rows.iter().find_map(|r| match r {
        Row::User(c) => {
            let t = c.trim();
            if t.is_empty() || t.starts_with('/') || t.starts_with('!') {
                None
            } else if t.chars().count() < deepdive_core::session_title::MIN_DESCRIPTION_LENGTH {
                None
            } else {
                Some(t.chars().take(1000).collect())
            }
        }
        _ => None,
    })
}

/// Fold a loaded session into transcript rows for display after `/resume`.
fn rows_from_session(id: &str) -> Vec<Row> {
    let Some(ls) = deepdive_core::session::load_session(id) else {
        return Vec::new();
    };
    rows_from_messages(&ls.messages)
}

/// The message→row mapping behind [`rows_from_session`], split out so it can be
/// unit-tested without touching the session store.
fn rows_from_messages(messages: &[deepdive_core::Message]) -> Vec<Row> {
    use deepdive_core::session::{is_compact_summary_message, COMPACT_SUMMARY_PREFIX, COMPACT_SUMMARY_SUFFIX};
    use deepdive_core::Role;

    let mut rows = Vec::new();
    // call_id → (tool name, args), harvested from each assistant turn's
    // tool_calls and consumed when the matching result message arrives. A tool
    // result is emitted as one card carrying its own call line, so a turn's
    // several calls interleave (call→result, call→result) rather than clumping.
    let mut calls: HashMap<String, (String, serde_json::Value)> = HashMap::new();

    for m in messages {
        if m.meta {
            // Memory recall gets a one-line marker; other reminders stay hidden.
            if deepdive_core::memory::recall::is_memory_recall_message(m) {
                let n = deepdive_core::memory::recall::memory_recall_count(&m.content);
                let unit = if n == 1 { "memory" } else { "memories" };
                rows.push(Row::Note(format!(
                    "{}Recalled {n} {unit}",
                    render::transcript::MARKER
                )));
            }
            continue;
        }
        if m.error {
            rows.push(Row::Error(m.content.clone()));
            continue;
        }
        if is_compact_summary_message(m) {
            let s = m.content.strip_prefix(COMPACT_SUMMARY_PREFIX).unwrap_or(&m.content);
            let body = s.strip_suffix(COMPACT_SUMMARY_SUFFIX).unwrap_or(s);
            rows.push(Row::Compaction(body.to_string()));
            continue;
        }
        if let Some(r) = &m.reasoning_content {
            if !r.trim().is_empty() {
                // Folded, like a freshly-committed thinking row — Ctrl+O expands it.
                rows.push(Row::Thinking {
                    content: r.clone(),
                    expanded: false,
                });
            }
        }
        for c in &m.tool_calls {
            let args = serde_json::from_str(&c.function.arguments).unwrap_or(serde_json::Value::Null);
            calls.insert(c.id.clone(), (c.function.name.clone(), args));
        }
        if m.role != Role::Tool && !m.content.trim().is_empty() {
            match m.role {
                Role::User if m.bash => rows.push(Row::UserBash {
                    command: m.content.clone(),
                    output: m.bash_output.clone(),
                }),
                Role::User => rows.push(Row::User(m.content.clone())),
                _ => rows.push(Row::Assistant(m.content.clone())),
            }
        }
        if m.role != Role::Tool && m.interrupted {
            rows.push(Row::Note(format!(
                "{}Interrupted by user",
                render::transcript::MARKER
            )));
        }
        if m.role == Role::Tool && !m.content.is_empty() {
            // An unknown call id (truncated history) still renders its result —
            // `tool_lines` drops the call line when the name is empty, matching
            // TS's `if (originatingCall)` guard.
            let (name, args) = m
                .tool_call_id
                .as_ref()
                .and_then(|id| calls.get(id))
                .cloned()
                .unwrap_or_else(|| (String::new(), serde_json::Value::Null));
            // Chat.tsx `isError`: the dot goes red for an "Error:" body or an
            // explicit abort, not merely for a non-success exit.
            let ok = !(m.content.starts_with("Error:") || m.content == "Aborted by user.");
            rows.push(Row::Tool {
                summary: deepdive_core::tools::format::summarize_args(&name, &args),
                name,
                output: Some(m.content.clone()),
                ok,
            });
        }
    }
    rows
}

fn next_mode(m: ApprovalMode) -> ApprovalMode {
    use ApprovalMode::*;
    // Order mirrors the TS Shift+Tab cycle: default→acceptEdits→plan→yolo→auto.
    match m {
        Default => AcceptEdits,
        AcceptEdits => Plan,
        Plan => Yolo,
        Yolo => Auto,
        Auto => Default,
    }
}

fn parse_mode_name(s: &str) -> Option<ApprovalMode> {
    use ApprovalMode::*;
    match s.trim() {
        "default" => Some(Default),
        "acceptEdits" | "accept-edits" | "acceptedits" => Some(AcceptEdits),
        "plan" => Some(Plan),
        "yolo" => Some(Yolo),
        "auto" => Some(Auto),
        _ => None,
    }
}

// ── terminal lifecycle ───────────────────────────────────────────────────────

/// Restore the terminal even on panic, so a crash doesn't leave a broken TTY.
/// The session proper never enters the alternate screen (§2), but the Ctrl+O
/// overlay does — leaving it unconditionally is a no-op when we're already on
/// the main buffer, and the difference between a usable shell and a blank one
/// when we're not.
fn install_panic_hook() {
    let hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = disable_raw_mode();
        let _ = crossterm::execute!(
            std::io::stdout(),
            crossterm::terminal::LeaveAlternateScreen,
            crossterm::event::DisableBracketedPaste,
            crossterm::terminal::EnableLineWrap,
            crossterm::cursor::Show
        );
        hook(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(v: &[&str]) -> (Startup, bool) {
        parse_args(&v.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn parse_args_matches_cli_tsx() {
        assert_eq!(parse(&[]).0.resume, ResumeMode::Off);
        assert!(!parse(&[]).1);
        // bare -r / --resume → picker
        assert_eq!(parse(&["-r"]).0.resume, ResumeMode::Picker);
        assert_eq!(parse(&["--resume"]).0.resume, ResumeMode::Picker);
        // -r <id> → resume that id
        assert_eq!(parse(&["-r", "abc123"]).0.resume, ResumeMode::Id("abc123".into()));
        // -r followed by a flag → picker (the flag token is not taken as the id)
        assert_eq!(parse(&["-r", "--unknown"]).0.resume, ResumeMode::Picker);
        // -r "" (empty token) → picker, not an empty id (TS `next && ...`)
        assert_eq!(parse(&["-r", ""]).0.resume, ResumeMode::Picker);
        // -c / --continue → most recent
        assert_eq!(parse(&["-c"]).0.resume, ResumeMode::Id("last".into()));
        assert_eq!(parse(&["--continue"]).0.resume, ResumeMode::Id("last".into()));
        // -h / --help
        assert!(parse(&["-h"]).1);
        assert!(parse(&["--help"]).1);
    }

    #[test]
    fn footer_shows_the_reasoning_tier() {
        let mut app = AppState::new(ApprovalMode::Default);
        app.model = "deepseek-v4-pro".to_string();
        app.reasoning_effort = "max".to_string();
        let text: String = render::footer::render_footer(&app, 200)
            .iter()
            .flat_map(|l| l.spans.iter().map(|s| s.content.to_string()))
            .collect();
        assert!(text.contains("think: max"), "footer was: {text}");
    }

    #[test]
    fn mode_cycle_matches_ts_order() {
        use ApprovalMode::*;
        // default → acceptEdits → plan → yolo → auto → default
        assert_eq!(next_mode(Default), AcceptEdits);
        assert_eq!(next_mode(AcceptEdits), Plan);
        assert_eq!(next_mode(Plan), Yolo);
        assert_eq!(next_mode(Yolo), Auto);
        assert_eq!(next_mode(Auto), Default);
    }

    #[test]
    fn parse_mode_name_accepts_known_and_rejects_unknown() {
        assert_eq!(parse_mode_name("plan"), Some(ApprovalMode::Plan));
        assert_eq!(parse_mode_name("acceptEdits"), Some(ApprovalMode::AcceptEdits));
        assert_eq!(parse_mode_name("auto"), Some(ApprovalMode::Auto));
        assert!(parse_mode_name("nope").is_none());
        assert!(parse_mode_name("").is_none());
    }

    #[test]
    fn resume_rebuilds_thinking_and_tool_cards() {
        use deepdive_core::types::{FunctionCall, Message, ToolCall};
        use deepdive_core::Role;

        let mut assistant = Message::assistant("");
        assistant.reasoning_content = Some("pondering".to_string());
        assistant.tool_calls = vec![ToolCall {
            id: "call_1".to_string(),
            kind: "function".to_string(),
            function: FunctionCall {
                name: "bash".to_string(),
                arguments: r#"{"command":"ls -la"}"#.to_string(),
            },
        }];
        let rows = rows_from_messages(&[
            Message::user("do it"),
            assistant,
            Message::tool("call_1", "total 0\nfile.txt"),
            Message::assistant("done"),
        ]);

        // User, thinking, the tool card (call + result fused), answer — the
        // reasoning and the tool call used to be dropped entirely on resume.
        assert_eq!(rows.len(), 4);
        assert!(matches!(&rows[0], Row::User(t) if t == "do it"));
        assert!(matches!(&rows[1], Row::Thinking { content, .. } if content == "pondering"));
        match &rows[2] {
            Row::Tool { name, summary, output, ok } => {
                assert_eq!(name, "bash");
                // Args come back through summarize_args, not the raw JSON.
                assert_eq!(summary, "ls -la");
                assert_eq!(output.as_deref(), Some("total 0\nfile.txt"));
                assert!(ok);
            }
            other => panic!("expected a tool card, got {other:?}"),
        }
        assert!(matches!(&rows[3], Row::Assistant(t) if t == "done"));
        // An empty assistant message must not leave a stray blank row.
        assert!(!rows.iter().any(|r| matches!(r, Row::Assistant(t) if t.is_empty())));
        // A result whose call line was trimmed out of history still renders.
        let orphan = rows_from_messages(&[Message::tool("gone", "orphan")]);
        assert_eq!(orphan.len(), 1);
        assert!(matches!(&orphan[0], Row::Tool { name, .. } if name.is_empty()));
        let _ = Role::Tool;
    }

    #[test]
    fn resume_marks_errors_and_bash_turns() {
        use deepdive_core::types::Message;

        let mut err = Message::assistant("boom");
        err.error = true;
        let mut bash = Message::user("ls");
        bash.bash = true;
        bash.bash_output = Some("file.txt".to_string());

        let rows = rows_from_messages(&[bash, err]);
        assert!(matches!(&rows[0], Row::UserBash { command, output }
            if command == "ls" && output.as_deref() == Some("file.txt")));
        assert!(matches!(&rows[1], Row::Error(t) if t == "boom"));
    }

    #[test]
    fn approval_decisions_order_matches_modal_render() {
        // Non-edit, no save patterns: just Allow once + Deny.
        assert_eq!(
            approval_decisions("bash", &[]),
            vec![ApprovalDecision::Approve, ApprovalDecision::Deny]
        );
        // Edit tool: Allow once / Allow all edits / Deny (no separate save-pattern row).
        let pats = vec!["**/*.rs".to_string()];
        assert_eq!(
            approval_decisions("edit_file", &pats),
            vec![
                ApprovalDecision::Approve,
                ApprovalDecision::AllowAlways(pats.clone()),
                ApprovalDecision::Deny,
            ]
        );
        // Non-edit with save patterns: Allow once / Allow always / Deny.
        assert_eq!(
            approval_decisions("bash", &pats),
            vec![
                ApprovalDecision::Approve,
                ApprovalDecision::AllowAlways(pats),
                ApprovalDecision::Deny,
            ]
        );
    }

    #[test]
    fn first_real_user_row_skips_slash_bash_and_too_short() {
        let user = |s: &str| Row::User(s.to_string());
        assert_eq!(first_real_user_row(&[user("/model")]), None);
        assert_eq!(first_real_user_row(&[user("!pnpm build")]), None);
        // greetings / shorter than MIN_DESCRIPTION_LENGTH(4) → skipped
        assert_eq!(first_real_user_row(&[user("HI")]), None);
        assert_eq!(first_real_user_row(&[user("你好")]), None);
        // boundary: 4 chars == MIN_DESCRIPTION_LENGTH → kept
        assert_eq!(
            first_real_user_row(&[user("跑个测试")]),
            Some("跑个测试".to_string())
        );
        // waits for a later real message
        assert_eq!(
            first_real_user_row(&[user("HI"), user("修复一下登录 bug")]),
            Some("修复一下登录 bug".to_string())
        );
    }
}
