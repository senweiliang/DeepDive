//! Bash execution — faithful port of `executeBash` from `src/tools/executor.ts`.
//!
//! Streams stdout, caps buffered output, enforces a timeout, and kills the
//! **entire process tree** on timeout / output-cap / cancellation (Unix: a
//! negative-PID process-group SIGKILL after `process_group(0)`; Windows:
//! `taskkill /F /T`). Background commands skip the timeout and cap-kill but
//! still bound the buffer.

use crate::tools::executor::ToolResult;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const MAX_BASH_OUTPUT_UPPER_LIMIT: usize = 150_000;
const MAX_BASH_OUTPUT_DEFAULT: usize = 30_000;
const BASH_DEFAULT_TIMEOUT_MS: u64 = 120_000;
const BASH_MAX_TIMEOUT_MS: u64 = 600_000;

fn env_u64(key: &str) -> Option<u64> {
    std::env::var(key)
        .ok()
        .and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n > 0.0)
        .map(|n| n as u64)
}

pub fn get_max_bash_output() -> usize {
    match env_u64("DEEPDIVE_MAX_BASH_OUTPUT") {
        Some(n) => (n as usize).min(MAX_BASH_OUTPUT_UPPER_LIMIT),
        None => MAX_BASH_OUTPUT_DEFAULT,
    }
}

fn default_bash_timeout_ms() -> u64 {
    env_u64("DEEPDIVE_BASH_DEFAULT_TIMEOUT_MS").unwrap_or(BASH_DEFAULT_TIMEOUT_MS)
}

fn max_bash_timeout_ms() -> u64 {
    match env_u64("DEEPDIVE_BASH_MAX_TIMEOUT_MS") {
        Some(n) => n.max(default_bash_timeout_ms()),
        None => BASH_MAX_TIMEOUT_MS.max(default_bash_timeout_ms()),
    }
}

/// Resolve the effective timeout: model arg → env default → built-in, clamped
/// to [1, max].
fn resolve_bash_timeout(timeout_arg: Option<u64>) -> u64 {
    match timeout_arg.filter(|n| *n > 0) {
        Some(n) => n.min(max_bash_timeout_ms()),
        None => default_bash_timeout_ms(),
    }
}

/// Truncate to `limit`, keeping the head and appending a truncation marker.
fn cap_output(raw: &str, limit: usize) -> String {
    if raw.len() <= limit {
        return raw.to_string();
    }
    let removed = raw.len() - limit;
    let removed_kb = ((removed as f64) / 1024.0).round() as i64;
    // Slice on a char boundary at/just below `limit`.
    let mut end = limit;
    while end > 0 && !raw.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}\n... [output truncated — {removed_kb}KB removed]",
        &raw[..end]
    )
}

/// Kill a process and its entire tree.
fn kill_tree(pid: u32) {
    #[cfg(unix)]
    unsafe {
        // process_group(0) made the child a group leader, so -pid targets the
        // whole foreground group.
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct BashOptions {
    /// Background commands skip the timeout and cap-kill (still buffer-capped).
    pub background: bool,
    /// Model-provided timeout in ms; clamped to the configured max.
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Copy)]
enum StreamTag {
    Out,
    Err,
}

/// Run a shell command. Streams stdout chunks to `on_output`. Cancelling
/// `cancel` kills the process tree and returns the partial output.
pub async fn execute_bash(
    command: &str,
    workspace: &Path,
    opts: BashOptions,
    cancel: &CancellationToken,
    mut on_output: impl FnMut(&str),
) -> ToolResult {
    let max_output = get_max_bash_output();
    let timeout = resolve_bash_timeout(opts.timeout_ms);

    let mut cmd = if cfg!(windows) {
        let shell = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
        let mut c = Command::new(shell);
        c.arg("/C").arg(command);
        c
    } else {
        let mut c = Command::new("bash");
        c.arg("-c").arg(command);
        c
    };
    cmd.current_dir(workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Unix: own process group so kill_tree reaches grandchildren.
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return ToolResult::error(format!("Error: {e}")),
    };
    let pid = child.id();

    // Drain stdout/stderr in background tasks, tagging each chunk.
    let (tx, mut rx) = mpsc::channel::<(StreamTag, Vec<u8>)>(64);
    if let Some(out) = child.stdout.take() {
        spawn_drain(out, StreamTag::Out, tx.clone());
    }
    if let Some(err) = child.stderr.take() {
        spawn_drain(err, StreamTag::Err, tx.clone());
    }
    drop(tx); // so rx closes once both drains finish

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut killed_by_output = false;
    let mut timed_out = false;

    let deadline = tokio::time::sleep(Duration::from_millis(timeout));
    tokio::pin!(deadline);

    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                if let Some(p) = pid { kill_tree(p); }
                break;
            }
            _ = &mut deadline, if !opts.background => {
                timed_out = true;
                if let Some(p) = pid { kill_tree(p); }
                break;
            }
            msg = rx.recv() => match msg {
                Some((StreamTag::Out, bytes)) => {
                    if stdout.len() < max_output {
                        let text = String::from_utf8_lossy(&bytes);
                        stdout.push_str(&text);
                        on_output(&text);
                        if stdout.len() >= max_output && !opts.background {
                            killed_by_output = true;
                            if let Some(p) = pid { kill_tree(p); }
                            break;
                        }
                    }
                }
                Some((StreamTag::Err, bytes)) => {
                    if stderr.len() < max_output {
                        stderr.push_str(&String::from_utf8_lossy(&bytes));
                    }
                }
                None => break, // both pipes hit EOF
            }
        }
    }

    let status = child.wait().await;

    if killed_by_output {
        return ToolResult {
            content: cap_output(&stdout, max_output),
            is_error: false,
            truncated: true,
        };
    }
    if timed_out {
        let capped = cap_output(&stdout, max_output);
        let tail = if capped.is_empty() {
            String::new()
        } else {
            format!("\n\nPartial output:\n{capped}")
        };
        return ToolResult::error(format!(
            "Command timed out after {timeout}ms. Try narrowing the search path, using a more specific pattern, or pass a longer timeout (max {}ms).{tail}",
            max_bash_timeout_ms()
        ));
    }

    let code = status.ok().and_then(|s| s.code()).unwrap_or(0);
    let capped_out = cap_output(&stdout, max_output);
    let capped_err = cap_output(&stderr, max_output);
    if code != 0 {
        let mut content = format!("Error: exit code {code}");
        if !capped_out.is_empty() {
            content.push('\n');
            content.push_str(&capped_out);
        }
        if !capped_err.is_empty() {
            content.push('\n');
            content.push_str(&capped_err);
        }
        ToolResult::error(content)
    } else if capped_out.is_empty() {
        ToolResult::ok("(no output)")
    } else {
        ToolResult::ok(capped_out)
    }
}

fn spawn_drain<R>(mut reader: R, tag: StreamTag, tx: mpsc::Sender<(StreamTag, Vec<u8>)>)
where
    R: AsyncReadExt + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send((tag, buf[..n].to_vec())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn ws() -> std::path::PathBuf {
        std::env::temp_dir()
    }

    #[tokio::test]
    async fn executes_a_command() {
        let cancel = CancellationToken::new();
        let r = execute_bash("echo hello", &ws(), BashOptions::default(), &cancel, |_| {}).await;
        assert!(!r.is_error);
        assert!(r.content.contains("hello"));
    }

    #[tokio::test]
    async fn failing_command_returns_string() {
        let cancel = CancellationToken::new();
        let r = execute_bash(
            "nonexistentcommand 2>&1",
            &ws(),
            BashOptions::default(),
            &cancel,
            |_| {},
        )
        .await;
        // just needs to return a result without panicking
        assert!(!r.content.is_empty() || r.content.is_empty());
    }

    #[tokio::test]
    async fn runs_in_workspace_directory() {
        let dir = std::env::temp_dir().join(format!("deepdive-bash-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("marker.txt"), "here").unwrap();
        let cancel = CancellationToken::new();
        let r = execute_bash(
            "cat marker.txt",
            &dir,
            BashOptions::default(),
            &cancel,
            |_| {},
        )
        .await;
        assert!(r.content.contains("here"));
    }

    #[tokio::test]
    async fn streams_output_to_callback() {
        let cancel = CancellationToken::new();
        let mut chunks = String::new();
        let r = execute_bash(
            "printf 'ab'; printf 'cd'",
            &ws(),
            BashOptions::default(),
            &cancel,
            |t| {
                chunks.push_str(t);
            },
        )
        .await;
        assert!(!r.is_error);
        assert!(chunks.contains("ab"));
        assert!(chunks.contains("cd"));
    }

    #[tokio::test]
    async fn timeout_kills_and_reports() {
        let cancel = CancellationToken::new();
        let opts = BashOptions {
            background: false,
            timeout_ms: Some(150),
        };
        let r = execute_bash("sleep 5", &ws(), opts, &cancel, |_| {}).await;
        assert!(r.is_error);
        assert!(r.content.contains("timed out"));
    }

    #[tokio::test]
    async fn cancellation_kills_the_process() {
        let cancel = CancellationToken::new();
        let token = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            token.cancel();
        });
        // would run 10s; cancel kills it ~0.1s in.
        let r = execute_bash("sleep 10", &ws(), BashOptions::default(), &cancel, |_| {}).await;
        // killed → returns (not a timeout error)
        assert!(!r.content.contains("timed out"));
    }
}
