//! deepdive (Rust) — agent runner.
//!
//! `deepdive` (no args) opens the interactive REPL (`engine::run_turn_loop`):
//! streaming, inline approvals/questions, mid-turn queueing, Ctrl-C interrupt.
//! `deepdive <prompt...>` runs the headless loop (`engine::run_exec`): streams
//! thinking + answers, executes tools to completion, honouring permission `deny`
//! rules. Both drive the same `deepdive-core` engine.

mod interactive;
mod mcp_cli;

use anyhow::Result;
use clap::Parser;
use deepdive_core::engine::{run_exec, ExecEvent, Session};
use deepdive_core::Config;
use std::io::Write;
use tokio_util::sync::CancellationToken;

#[derive(Parser)]
#[command(
    name = "deepdive",
    about = "DeepDive (Rust) — agent runner (interactive by default)",
    after_help = "MCP:\n  deepdive mcp add|list|get|remove   manage MCP servers (see `deepdive mcp --help`)"
)]
struct Args {
    /// Resume the most recent session in this directory (interactive mode).
    #[arg(short = 'r', long = "resume")]
    resume: bool,
    /// Continue the most recent session (alias for --resume).
    #[arg(short = 'c', long = "continue")]
    cont: bool,
    /// Resume a specific session by id.
    #[arg(long = "session", value_name = "ID")]
    session: Option<String>,
    /// The task prompt (all positional args are joined with spaces).
    #[arg(trailing_var_arg = true)]
    prompt: Vec<String>,
}

/// Build the REPL session. An explicit resume (`-r`/`-c`/`--session`) that can't
/// be resolved is a hard error (exit 1); with no resume flag, start fresh.
fn build_session(resume_latest: bool, session_id: Option<String>, config: &Config) -> Session {
    // Explicit by-id resume.
    if let Some(id) = session_id {
        return match deepdive_core::session::load_session(&id) {
            Some(ls) => {
                eprintln!("\x1b[2m↺ resumed session {} ({} messages)\x1b[0m", &id[..8.min(id.len())], ls.messages.len());
                Session::resume(config, id, ls.messages, ls.usage)
            }
            None => {
                eprintln!("\x1b[31merror: session not found: {id}\x1b[0m");
                std::process::exit(1);
            }
        };
    }
    if !resume_latest {
        return Session::new(config);
    }
    // Resume latest; nothing to resume is an error for an explicit request.
    match deepdive_core::session::latest_session_id().and_then(|id| {
        deepdive_core::session::load_session(&id).map(|ls| (id, ls))
    }) {
        Some((id, ls)) => {
            eprintln!("\x1b[2m↺ resumed session {} ({} messages)\x1b[0m", &id[..8.min(id.len())], ls.messages.len());
            Session::resume(config, id, ls.messages, ls.usage)
        }
        None => {
            eprintln!("\x1b[31merror: no previous session to resume in this directory\x1b[0m");
            std::process::exit(1);
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();

    // Freeze the working directory at startup (mirrors cli.tsx setOriginalCwd).
    // Done before the `mcp` subcommand so it resolves `.mcp.json` against it.
    if let Ok(cwd) = std::env::current_dir() {
        deepdive_core::workspace::set_original_cwd(cwd);
    }

    // `deepdive mcp <sub>` — config management only; no TUI, no API key needed.
    // Intercept before clap so its positional `prompt` never swallows the args.
    let raw: Vec<String> = std::env::args().collect();
    if raw.get(1).map(String::as_str) == Some("mcp") {
        std::process::exit(mcp_cli::run(&raw[2..]));
    }

    let args = Args::parse();
    let prompt = args.prompt.join(" ");

    let config = Config::load();
    if config.api_key.is_empty() {
        eprintln!("error: DEEPSEEK_API_KEY not set (env or ~/.deepdive/settings.json)");
        std::process::exit(1);
    }

    let http = deepdive_core::client::http_client();

    // No prompt → interactive REPL; otherwise headless one-shot exec.
    let want_resume = args.resume || args.cont;
    if prompt.trim().is_empty() {
        let session = build_session(want_resume, args.session.clone(), &config);
        return interactive::run_interactive(http, config, session).await;
    }
    if want_resume || args.session.is_some() {
        eprintln!("\x1b[2mnote: --resume/--continue/--session only apply to interactive mode\x1b[0m");
    }

    let cancel = CancellationToken::new();
    {
        let cancel = cancel.clone();
        tokio::spawn(async move {
            let _ = tokio::signal::ctrl_c().await;
            cancel.cancel();
        });
    }

    let mut stdout = std::io::stdout();
    let mut stderr = std::io::stderr();

    let result = run_exec(&http, &config, &prompt, &cancel, |event| match event {
        ExecEvent::TurnStarted(_) => {}
        ExecEvent::Thinking(text) => {
            // dimmed thinking → stderr
            let _ = writeln!(stderr, "\x1b[2m[thinking] {}\x1b[0m", text.trim());
        }
        ExecEvent::Assistant(text) => {
            let _ = writeln!(stdout, "{text}");
            let _ = stdout.flush();
        }
        ExecEvent::ToolStarted { name, summary } => {
            let _ = writeln!(stderr, "\x1b[36m● {name}\x1b[0m({summary})");
            let _ = stderr.flush();
        }
        ExecEvent::ToolFinished { name, ok } => {
            let mark = if ok { "✓" } else { "✗" };
            let _ = writeln!(stderr, "  \x1b[2m⎿ {mark} {name}\x1b[0m");
        }
    })
    .await;

    if cancel.is_cancelled() {
        eprintln!("[interrupted]");
    }
    if result.is_error {
        std::process::exit(1);
    }
    Ok(())
}
