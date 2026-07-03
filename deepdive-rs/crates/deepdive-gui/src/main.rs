//! deepdive-gui (Rust) — Tauri v2 desktop shell for the DeepDive engine (P4).
//!
//! NO Node sidecar: `deepdive-core` is a plain Rust dependency compiled into the
//! Tauri backend. The webview frontend is static (vanilla JS, `withGlobalTauri`)
//! and talks to the backend over Tauri commands + events:
//!
//!   - an **engine task** owns the `Session` + the `UiToCore` receiver and runs
//!     one `run_turn_loop` per submission (identical to the CLI/TUI plumbing);
//!   - a **forwarder task** drains `AgentEvent`s, converts them through the
//!     tested [`deepdive_core::Bridge`] into serializable `UiEvent`s, and emits
//!     them to the window as `"agent-event"`;
//!   - commands (`submit`/`approve`/`answer`/`abort`/`set_mode`) flow UI→engine.
//!
//! The GUI itself needs a windowing environment; build/run with
//! `cargo run -p deepdive-gui` (or `cargo tauri dev`) on a desktop.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use deepdive_core::bridge::Bridge;
use deepdive_core::engine::{add_session_dir, compact_now, drain_background, run_turn_loop, Session};
use deepdive_core::{AgentEvent, ApprovalMode, Config, Role, UiToCore};
use serde::Serialize;
use tauri::{Emitter, State};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Shared state handed to Tauri commands.
struct AppState {
    /// Starts a new submission when idle.
    start_tx: mpsc::Sender<(String, CancellationToken)>,
    /// Mid-turn input / mode change / abort.
    commands_tx: mpsc::Sender<UiToCore>,
    /// Pending approval/question reply channels (resolved by id).
    bridge: Arc<Mutex<Bridge>>,
    /// Cancel token of the in-flight submission.
    cur_cancel: Mutex<Option<CancellationToken>>,
    /// Whether a submission is currently running.
    busy: Arc<AtomicBool>,
    /// Signals the engine task to start a fresh session (New chat).
    reset_tx: mpsc::Sender<()>,
    /// Signals the engine task to load + switch to an existing session by id.
    resume_tx: mpsc::Sender<String>,
    /// For one-shot queries (balance) and config display.
    client: reqwest::Client,
    /// Single source of truth for runtime config; the engine clones it per turn,
    /// so `/model` and `/settings` take effect on the next submission.
    config: Arc<Mutex<Config>>,
    /// Id of the active, persisted session (set after the first turn / on resume;
    /// None before the conversation is bootstrapped). Used by `/rename`.
    cur_session: Arc<Mutex<Option<String>>>,
}

#[tauri::command]
async fn submit(state: State<'_, AppState>, input: String) -> Result<(), String> {
    if input.trim().is_empty() {
        return Ok(());
    }
    if state.busy.load(Ordering::SeqCst) {
        // Queue mid-turn; the loop drains it after the current tool batch.
        let tx = state.commands_tx.clone();
        tx.send(UiToCore::UserInput(input)).await.map_err(|e| e.to_string())?;
    } else {
        state.busy.store(true, Ordering::SeqCst);
        let cancel = CancellationToken::new();
        *state.cur_cancel.lock().unwrap() = Some(cancel.clone());
        let tx = state.start_tx.clone();
        tx.send((input, cancel)).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn approve(state: State<'_, AppState>, id: u64, decision: String) {
    state.bridge.lock().unwrap().approve(id, &decision);
}

#[tauri::command]
fn answer(state: State<'_, AppState>, id: u64, answers: Option<HashMap<String, String>>) {
    state.bridge.lock().unwrap().answer(id, answers);
}

#[tauri::command]
fn abort(state: State<'_, AppState>) {
    if let Some(c) = state.cur_cancel.lock().unwrap().as_ref() {
        c.cancel();
    }
}

#[tauri::command]
async fn set_mode(state: State<'_, AppState>, mode: String) -> Result<(), String> {
    let tx = state.commands_tx.clone();
    tx.send(UiToCore::ModeChange(parse_mode(&mode)))
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn parse_mode(s: &str) -> ApprovalMode {
    match s {
        "plan" => ApprovalMode::Plan,
        "default" => ApprovalMode::Default,
        "acceptEdits" => ApprovalMode::AcceptEdits,
        "yolo" => ApprovalMode::Yolo,
        _ => ApprovalMode::Auto,
    }
}

#[derive(Serialize)]
struct SessionItem {
    id: String,
    title: String,
    /// Last-modified, unix seconds (for a relative-time label).
    mtime: u64,
}

#[derive(Serialize)]
struct RenderMsg {
    role: String,
    content: String,
    interrupted: bool,
    /// Persisted reasoning for assistant messages (null otherwise), so resumed
    /// transcripts can re-render the collapsible 思考过程 block.
    thinking: Option<String>,
}

fn short_id(id: &str) -> String {
    id.chars().take(8).collect()
}

/// First non-meta user message of a session, as a sidebar title.
fn session_title(id: &str) -> String {
    let Some(ls) = deepdive_core::session::load_session(id) else {
        return short_id(id);
    };
    // A `/rename` persists SessionMeta.title; prefer it over the message-derived
    // title so the sidebar reflects the rename.
    if let Some(t) = ls.meta.as_ref().and_then(|m| m.title.as_deref()) {
        let t: String = t.trim().chars().take(48).collect();
        if !t.is_empty() {
            return t;
        }
    }
    ls.messages
        .into_iter()
        .find(|m| m.role == Role::User && !m.meta)
        .map(|m| {
            let t: String = m.content.trim().chars().take(48).collect();
            if t.is_empty() {
                short_id(id)
            } else {
                t
            }
        })
        .unwrap_or_else(|| short_id(id))
}

/// Recent sessions for this project (for the sidebar).
#[tauri::command]
fn list_sessions() -> Vec<SessionItem> {
    deepdive_core::session::list_sessions()
        .into_iter()
        .take(30)
        .map(|s| {
            let title = session_title(&s.id);
            let mtime = s
                .modified
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            SessionItem { id: s.id, title, mtime }
        })
        .collect()
}

/// Start a fresh conversation (the previous one is already persisted).
#[tauri::command]
async fn new_session(state: State<'_, AppState>) -> Result<(), String> {
    state.reset_tx.clone().send(()).await.map_err(|e| e.to_string())
}

/// Switch to an existing session and return its displayable transcript.
#[tauri::command]
async fn resume_session(state: State<'_, AppState>, id: String) -> Result<Vec<RenderMsg>, String> {
    state
        .resume_tx
        .clone()
        .send(id.clone())
        .await
        .map_err(|e| e.to_string())?;
    use deepdive_core::session::{
        is_compact_summary_message, COMPACT_SUMMARY_PREFIX, COMPACT_SUMMARY_SUFFIX,
    };
    let ls = deepdive_core::session::load_session(&id).ok_or("session not found")?;
    Ok(ls
        .messages
        .iter()
        .filter_map(|m| {
            // Compaction summaries are stored as (non-meta) user messages wrapped
            // in <previous-conversation-summary>…</>. Surface them as a distinct
            // "summary" role (stripped) so the UI renders a divider instead of
            // leaking the raw wrapper as a plain user bubble.
            if is_compact_summary_message(m) {
                let s = m.content.strip_prefix(COMPACT_SUMMARY_PREFIX).unwrap_or(&m.content);
                let body = s.strip_suffix(COMPACT_SUMMARY_SUFFIX).unwrap_or(s).to_string();
                return Some(RenderMsg {
                    role: "summary".to_string(),
                    content: body,
                    interrupted: false,
                    thinking: None,
                });
            }
            if matches!(m.role, Role::User | Role::Assistant)
                && !m.meta
                && !m.content.trim().is_empty()
            {
                return Some(RenderMsg {
                    role: if m.role == Role::User { "user" } else { "assistant" }.to_string(),
                    content: m.content.clone(),
                    interrupted: m.interrupted,
                    // Only assistant turns carry reasoning; drop blank strings.
                    thinking: if m.role == Role::Assistant {
                        m.reasoning_content.clone().filter(|s| !s.trim().is_empty())
                    } else {
                        None
                    },
                });
            }
            None
        })
        .collect())
}

fn mode_str(m: ApprovalMode) -> String {
    match m {
        ApprovalMode::Plan => "plan",
        ApprovalMode::Default => "default",
        ApprovalMode::AcceptEdits => "acceptEdits",
        ApprovalMode::Yolo => "yolo",
        ApprovalMode::Auto => "auto",
    }
    .to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    model: String,
    mode: String,
    cwd: String,
    /// Token budget for the ctx-usage % in the footer.
    context_window: u64,
}

/// Static info for the sidebar header.
#[tauri::command]
fn app_info(state: State<'_, AppState>) -> AppInfo {
    let c = state.config.lock().unwrap();
    AppInfo {
        model: c.model.clone(),
        mode: mode_str(c.approval_mode),
        cwd: c.cwd.to_string_lossy().into_owned(),
        context_window: c.context_window,
    }
}

/// Whether the API key is unset (the GUI shows a setup gate if so).
#[tauri::command]
fn need_setup(state: State<'_, AppState>) -> bool {
    state.config.lock().unwrap().api_key.trim().is_empty()
}

/// Persist + live-apply the API key entered in the setup gate.
#[tauri::command]
fn save_api_key(state: State<'_, AppState>, key: String) {
    let key = key.trim().to_string();
    if key.is_empty() {
        return;
    }
    deepdive_core::config::save_api_key(&key);
    state.config.lock().unwrap().api_key = key;
}

/// Account balance, e.g. "5.92 CNY" (or null on failure).
#[tauri::command]
async fn balance(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let client = state.client.clone();
    let config = state.config.lock().unwrap().clone();
    Ok(deepdive_core::balance::fetch_balance(&client, &config)
        .await
        .map(|b| b.display()))
}

#[derive(Serialize)]
struct ModelItem {
    value: String,
    label: String,
    description: String,
    current: bool,
}

/// Available chat models for the `/model` picker.
#[tauri::command]
fn list_models(state: State<'_, AppState>) -> Vec<ModelItem> {
    let cur = state.config.lock().unwrap().model.clone();
    deepdive_core::config::CHAT_MODELS
        .iter()
        .map(|m| ModelItem {
            value: m.value.to_string(),
            label: m.label.to_string(),
            description: m.description.to_string(),
            current: m.value == cur,
        })
        .collect()
}

/// Switch the chat model (persists + updates the live config).
#[tauri::command]
fn set_model(state: State<'_, AppState>, model: String) {
    deepdive_core::config::save_model(&model);
    let mut c = state.config.lock().unwrap();
    c.context_window = deepdive_core::config::model_context_window(&model);
    c.model = model;
}

fn turn_summary_str(s: deepdive_core::TurnSummaryStrategy) -> String {
    use deepdive_core::TurnSummaryStrategy as T;
    match s {
        T::Off => "off",
        T::WholeTurn => "whole_turn",
        T::ToolOnly => "tool_only",
    }
    .to_string()
}
fn parse_turn_summary(s: &str) -> deepdive_core::TurnSummaryStrategy {
    use deepdive_core::TurnSummaryStrategy as T;
    match s {
        "whole_turn" => T::WholeTurn,
        "tool_only" => T::ToolOnly,
        _ => T::Off,
    }
}

#[derive(Serialize)]
struct SettingsView {
    model: String,
    reasoning_effort: String,
    response_language: String,
    turn_summary: String,
    tavily_set: bool,
    models: Vec<String>,
    reasoning_efforts: Vec<String>,
    response_languages: Vec<String>,
    turn_summaries: Vec<String>,
}

/// Current runtime settings for the `/settings` panel.
#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> SettingsView {
    let c = state.config.lock().unwrap();
    SettingsView {
        model: c.model.clone(),
        reasoning_effort: c.reasoning_effort.clone(),
        response_language: c.response_language.clone(),
        turn_summary: turn_summary_str(c.turn_summary_strategy),
        tavily_set: !c.tavily_api_key.is_empty(),
        models: deepdive_core::config::CHAT_MODELS.iter().map(|m| m.value.to_string()).collect(),
        reasoning_efforts: deepdive_core::config::REASONING_EFFORTS.iter().map(|s| s.to_string()).collect(),
        response_languages: deepdive_core::config::RESPONSE_LANGUAGES.iter().map(|s| s.to_string()).collect(),
        turn_summaries: vec!["off".into(), "whole_turn".into(), "tool_only".into()],
    }
}

/// Persist + live-apply settings from the `/settings` panel.
#[tauri::command]
fn save_settings(
    state: State<'_, AppState>,
    model: String,
    reasoning_effort: String,
    response_language: String,
    turn_summary: String,
    tavily_key: Option<String>,
) {
    use deepdive_core::config;
    let strategy = parse_turn_summary(&turn_summary);
    config::save_model(&model);
    config::save_reasoning_effort(&reasoning_effort);
    config::save_response_language(&response_language);
    config::save_turn_summary_strategy(strategy);
    if let Some(k) = &tavily_key {
        if !k.is_empty() {
            config::save_tavily_key(k);
        }
    }
    let mut c = state.config.lock().unwrap();
    c.context_window = config::model_context_window(&model);
    c.model = model;
    c.reasoning_effort = reasoning_effort;
    c.response_language = response_language;
    c.turn_summary_strategy = strategy;
    if let Some(k) = tavily_key {
        if !k.is_empty() {
            c.tavily_api_key = k;
        }
    }
}

#[derive(Serialize)]
struct AgentItem {
    name: String,
    source: String,
    tools: String,
    model: String,
    when_to_use: String,
}

/// Validate + add an extra working directory. `persist` also writes it to
/// settings.json (so it survives restarts); otherwise it is session-only.
#[tauri::command]
async fn add_dir(state: State<'_, AppState>, path: String, persist: bool) -> Result<String, String> {
    let expanded = deepdive_core::workspace::expand_tilde(path.trim());
    if expanded.is_empty() {
        return Err("用法：/add-dir <路径>".to_string());
    }
    let p = std::path::Path::new(&expanded);
    let canonical = std::fs::canonicalize(p).map_err(|_| format!("路径不存在：{expanded}"))?;
    if !canonical.is_dir() {
        return Err(format!("不是目录：{expanded}"));
    }
    let dir = canonical.to_string_lossy().to_string();
    // Already inside the workspace cwd? Nothing to grant.
    let cwd = state.config.lock().unwrap().cwd.clone();
    if canonical == cwd || canonical.starts_with(&cwd) {
        return Ok(format!("已在工作区内：{dir}"));
    }
    if persist {
        deepdive_core::config::save_additional_directory(&dir);
        let mut c = state.config.lock().unwrap();
        if !c.additional_directories.iter().any(|d| d == &dir) {
            c.additional_directories.push(dir.clone());
        }
    }
    state
        .commands_tx
        .clone()
        .send(UiToCore::AddDir(dir.clone()))
        .await
        .map_err(|e| e.to_string())?;
    Ok(if persist {
        format!("已添加（工作区所有会话）：{dir}")
    } else {
        format!("已添加（仅本会话）：{dir}")
    })
}

/// Rename the active session (persists a title meta patch). Errors if no session
/// has been bootstrapped yet (send a message first).
#[tauri::command]
fn rename_session(state: State<'_, AppState>, title: String) -> Result<(), String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("用法：/rename <新标题>".to_string());
    }
    let id = state.cur_session.lock().unwrap().clone();
    match id {
        Some(id) => {
            deepdive_core::session::update_session_title(&id, &title);
            Ok(())
        }
        None => Err("请先发送一条消息后再重命名".to_string()),
    }
}

/// All registered subagents (built-in + custom) for the `/agents` listing.
#[tauri::command]
fn list_agents() -> Vec<AgentItem> {
    deepdive_core::agents::registry::reload_agents();
    deepdive_core::agents::registry::get_registered_agents()
        .into_iter()
        .map(|ra| {
            let source = match ra.source {
                deepdive_core::agents::registry::AgentSource::BuiltIn => "内置",
                deepdive_core::agents::registry::AgentSource::User => "用户",
                deepdive_core::agents::registry::AgentSource::Project => "项目",
            }
            .to_string();
            let tools = match &ra.def.tools {
                None => "全部工具".to_string(),
                Some(v) if v.is_empty() => "无工具".to_string(),
                Some(v) => v.join(", "),
            };
            AgentItem {
                name: ra.def.agent_type.clone(),
                source,
                tools,
                model: ra.def.model.clone().unwrap_or_else(|| "继承".to_string()),
                when_to_use: ra.def.when_to_use.clone(),
            }
        })
        .collect()
}

/// Compact the conversation now (idle-only; processed by the engine task).
#[tauri::command]
async fn compact(state: State<'_, AppState>) -> Result<(), String> {
    state
        .commands_tx
        .clone()
        .send(UiToCore::Compact)
        .await
        .map_err(|e| e.to_string())
}

fn main() {
    if let Ok(cwd) = std::env::current_dir() {
        deepdive_core::workspace::set_original_cwd(cwd);
    }
    let config = Arc::new(Mutex::new(Config::load()));
    let http = deepdive_core::client::http_client();

    let (events_tx, events_rx) = mpsc::channel::<AgentEvent>(256);
    let (commands_tx, commands_rx) = mpsc::channel::<UiToCore>(64);
    let (start_tx, start_rx) = mpsc::channel::<(String, CancellationToken)>(8);
    let (reset_tx, reset_rx) = mpsc::channel::<()>(4);
    let (resume_tx, resume_rx) = mpsc::channel::<String>(4);
    let bridge = Arc::new(Mutex::new(Bridge::new()));
    let busy = Arc::new(AtomicBool::new(false));
    let cur_session = Arc::new(Mutex::new(None::<String>));

    let state = AppState {
        start_tx,
        commands_tx,
        bridge: bridge.clone(),
        cur_cancel: Mutex::new(None),
        busy: busy.clone(),
        reset_tx,
        resume_tx,
        client: http.clone(),
        config: config.clone(),
        cur_session: cur_session.clone(),
    };

    // Move the receivers / event sender into setup so the two tasks can own them.
    let mut start_rx = Some(start_rx);
    let mut commands_rx = Some(commands_rx);
    let mut events_rx = Some(events_rx);
    let mut events_tx = Some(events_tx);
    let mut reset_rx = Some(reset_rx);
    let mut resume_rx = Some(resume_rx);

    tauri::Builder::default()
        .manage(state)
        .setup(move |app| {
            let handle = app.handle().clone();
            let http = http.clone();
            let config = config.clone();
            let cur_session = cur_session.clone();
            let start_rx = start_rx.take().unwrap();
            let commands_rx = commands_rx.take().unwrap();
            let events_tx = events_tx.take().unwrap();
            let events_rx = events_rx.take().unwrap();
            let reset_rx = reset_rx.take().unwrap();
            let resume_rx = resume_rx.take().unwrap();

            // Engine task: owns the Session; runs one run_turn_loop per
            // submission, auto-resumes on background-task completion, and swaps
            // the session on New chat / resume. It re-reads `config` (the shared
            // source of truth) at each use, so /model and /settings apply live.
            tauri::async_runtime::spawn(async move {
                // Snapshot the current Config without holding the lock across await.
                let snap = |c: &Arc<Mutex<Config>>| c.lock().unwrap().clone();
                let mut session = Session::new(&snap(&config));
                let mut commands_rx = commands_rx;
                let mut start_rx = start_rx;
                let mut reset_rx = reset_rx;
                let mut resume_rx = resume_rx;
                let mut notify = session.tasks.completion_notify();
                let bg_cancel = CancellationToken::new();
                loop {
                    tokio::select! {
                        biased;
                        maybe = start_rx.recv() => {
                            let Some((input, cancel)) = maybe else { break };
                            let cfg = snap(&config);
                            run_turn_loop(
                                &http, &cfg, &mut session, input,
                                &events_tx, &mut commands_rx, &cancel,
                            )
                            .await;
                            drain_background(&http, &cfg, &mut session, &events_tx, &mut commands_rx, &bg_cancel).await;
                            // The session is now persisted — expose its id for /rename.
                            *cur_session.lock().unwrap() = Some(session.session_id.clone());
                        }
                        _ = notify.notified() => {
                            let cfg = snap(&config);
                            drain_background(&http, &cfg, &mut session, &events_tx, &mut commands_rx, &bg_cancel).await;
                        }
                        Some(()) = reset_rx.recv() => {
                            session = Session::new(&snap(&config));
                            notify = session.tasks.completion_notify();
                            *cur_session.lock().unwrap() = None; // fresh, not yet persisted
                        }
                        Some(id) = resume_rx.recv() => {
                            if let Some(ls) = deepdive_core::session::load_session(&id) {
                                session = Session::resume(&snap(&config), id.clone(), ls.messages, ls.usage);
                                notify = session.tasks.completion_notify();
                                *cur_session.lock().unwrap() = Some(id); // already on disk
                            }
                        }
                        // Commands issued while idle (mode change / compact).
                        cmd = commands_rx.recv() => {
                            match cmd {
                                Some(UiToCore::ModeChange(m)) => session.mode = m,
                                Some(UiToCore::Compact) => {
                                    let cfg = snap(&config);
                                    let _ = compact_now(&http, &cfg, &mut session).await;
                                }
                                Some(UiToCore::Clear) => {
                                    session = Session::new(&snap(&config));
                                    notify = session.tasks.completion_notify();
                                    *cur_session.lock().unwrap() = None;
                                }
                                Some(UiToCore::AddDir(d)) => add_session_dir(&mut session, &d),
                                _ => {}
                            }
                        }
                    }
                }
                session.tasks.abort_all(); // best-effort cleanup on shutdown
            });

            // Forwarder task: AgentEvent → Bridge → emit("agent-event").
            let bridge = bridge.clone();
            let busy = busy.clone();
            tauri::async_runtime::spawn(async move {
                let mut events_rx = events_rx;
                while let Some(ev) = events_rx.recv().await {
                    match &ev {
                        AgentEvent::TurnStarted { .. } => busy.store(true, Ordering::SeqCst),
                        AgentEvent::TurnComplete { .. }
                        | AgentEvent::Recall(_)
                        | AgentEvent::Error(_) => busy.store(false, Ordering::SeqCst),
                        _ => {}
                    }
                    let ui = bridge.lock().unwrap().ingest(ev);
                    let _ = handle.emit("agent-event", ui);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            submit, approve, answer, abort, set_mode, list_sessions, new_session,
            resume_session, app_info, balance, compact,
            list_models, set_model, get_settings, save_settings, list_agents,
            need_setup, save_api_key, rename_session, add_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
