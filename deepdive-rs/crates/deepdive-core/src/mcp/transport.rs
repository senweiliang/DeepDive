//! MCP transports: stdio (subprocess, newline-delimited JSON-RPC), streamable
//! HTTP (POST + optional SSE response), and legacy SSE (persistent GET stream +
//! POST endpoint). All three speak the same [`Transport`] request/notify API;
//! stdio and legacy-SSE share an id→response [`Correlator`].
//!
//! Zero new dependencies: `tokio::process` (stdio), `reqwest` streaming (http/
//! sse), `serde_json` (framing). The subprocess spawn/kill mirrors `tools/bash.rs`.

use super::config::McpTransportConfig;
use super::protocol::{self, response_id, response_result};
use async_trait::async_trait;
use futures_util::StreamExt;
use serde_json::Value;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

/// Per-request wait cap. A hung server surfaces as an error rather than blocking
/// the agent loop forever.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Cap on captured stderr (bytes) surfaced in connect diagnostics.
const STDERR_CAP: usize = 4096;

/// A live MCP connection. `request` awaits the correlated JSON-RPC result;
/// `notify` fires a notification; `close` tears the connection down.
#[async_trait]
pub trait Transport: Send + Sync {
    async fn request(&self, method: &str, params: Value) -> Result<Value, String>;
    async fn notify(&self, method: &str, params: Value) -> Result<(), String>;
    async fn close(&self);
}

/// Shared id→response correlation for stream transports (stdio, legacy SSE).
#[derive(Default)]
struct Correlator {
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    next_id: AtomicU64,
}

impl Correlator {
    fn alloc(&self) -> (u64, oneshot::Receiver<Value>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        (id, rx)
    }

    fn cancel(&self, id: u64) {
        self.pending.lock().unwrap().remove(&id);
    }

    /// Route a parsed message with an `id` to its waiter. Server→client requests
    /// / notifications (no matching pending id) are dropped.
    fn resolve(&self, msg: Value) {
        if let Some(id) = response_id(&msg) {
            if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
                let _ = tx.send(msg);
            }
        }
    }

    /// Fail every outstanding waiter (connection died).
    fn fail_all(&self) {
        self.pending.lock().unwrap().clear();
    }
}

/// Await a correlated response with the shared timeout, then unwrap the JSON-RPC
/// envelope. `send` performs the actual write.
async fn await_response(
    corr: &Correlator,
    id: u64,
    rx: oneshot::Receiver<Value>,
) -> Result<Value, String> {
    match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
        Ok(Ok(msg)) => response_result(&msg),
        Ok(Err(_)) => {
            corr.cancel(id);
            Err("connection closed before response".to_string())
        }
        Err(_) => {
            corr.cancel(id);
            Err(format!("request timed out after {}s", REQUEST_TIMEOUT.as_secs()))
        }
    }
}

// ── stdio ────────────────────────────────────────────────────────────────────

/// Kill a process tree (Unix: negative-PID group SIGKILL after `process_group(0)`;
/// Windows: `taskkill /F /T`). Mirrors `tools::bash::kill_tree`.
fn kill_tree(pid: u32) {
    #[cfg(unix)]
    unsafe {
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

pub struct StdioTransport {
    corr: Arc<Correlator>,
    stdin: tokio::sync::Mutex<ChildStdin>,
    child: Mutex<Option<Child>>,
    pid: Option<u32>,
    reader: Mutex<Option<JoinHandle<()>>>,
    stderr: Arc<Mutex<String>>,
}

impl StdioTransport {
    pub fn spawn(
        command: &str,
        args: &[String],
        env: &HashMap<String, String>,
    ) -> Result<Self, String> {
        let mut cmd = Command::new(command);
        cmd.args(args)
            .envs(env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        cmd.process_group(0);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn `{command}`: {e}"))?;
        let pid = child.id();
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr_pipe = child.stderr.take();

        let corr = Arc::new(Correlator::default());
        let stderr_buf = Arc::new(Mutex::new(String::new()));

        // Reader: newline-delimited JSON-RPC → correlator.
        let reader = {
            let corr = corr.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if let Ok(msg) = serde_json::from_str::<Value>(trimmed) {
                        corr.resolve(msg);
                    }
                }
                corr.fail_all(); // stdout closed → child gone
            })
        };

        // Drain stderr into a capped buffer for connect diagnostics.
        if let Some(err) = stderr_pipe {
            let buf = stderr_buf.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(err).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let mut b = buf.lock().unwrap();
                    if b.len() < STDERR_CAP {
                        b.push_str(&line);
                        b.push('\n');
                    }
                }
            });
        }

        Ok(StdioTransport {
            corr,
            stdin: tokio::sync::Mutex::new(stdin),
            child: Mutex::new(Some(child)),
            pid,
            reader: Mutex::new(Some(reader)),
            stderr: stderr_buf,
        })
    }

    /// Recent stderr text (for surfacing why a handshake failed).
    pub fn stderr_tail(&self) -> String {
        self.stderr.lock().unwrap().trim().to_string()
    }

    async fn write_line(&self, value: &Value) -> Result<(), String> {
        let mut line = serde_json::to_string(value).map_err(|e| e.to_string())?;
        line.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("write failed: {e}"))?;
        stdin.flush().await.map_err(|e| e.to_string())
    }
}

#[async_trait]
impl Transport for StdioTransport {
    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let (id, rx) = self.corr.alloc();
        if let Err(e) = self.write_line(&protocol::request(id, method, params)).await {
            self.corr.cancel(id);
            let tail = self.stderr_tail();
            return Err(if tail.is_empty() { e } else { format!("{e}\n{tail}") });
        }
        await_response(&self.corr, id, rx).await.map_err(|e| {
            let tail = self.stderr_tail();
            if tail.is_empty() { e } else { format!("{e}\n{tail}") }
        })
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.write_line(&protocol::notification(method, params)).await
    }

    async fn close(&self) {
        if let Some(r) = self.reader.lock().unwrap().take() {
            r.abort();
        }
        if let Some(pid) = self.pid {
            kill_tree(pid);
        }
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.start_kill();
        }
    }
}

impl Drop for StdioTransport {
    /// Safety net: if the manager is dropped without an explicit `close()`, still
    /// kill the subprocess tree so no MCP server is orphaned on exit.
    fn drop(&mut self) {
        if let Some(r) = self.reader.lock().unwrap().take() {
            r.abort();
        }
        if let Some(pid) = self.pid {
            kill_tree(pid);
        }
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.start_kill();
        }
    }
}

// ── streamable HTTP ──────────────────────────────────────────────────────────

pub struct HttpTransport {
    client: reqwest::Client,
    url: String,
    headers: HashMap<String, String>,
    next_id: AtomicU64,
    session_id: Mutex<Option<String>>,
}

impl HttpTransport {
    pub fn new(client: reqwest::Client, url: String, headers: HashMap<String, String>) -> Self {
        HttpTransport {
            client,
            url,
            headers,
            next_id: AtomicU64::new(0),
            session_id: Mutex::new(None),
        }
    }

    fn build(&self, body: &Value) -> reqwest::RequestBuilder {
        let mut req = self
            .client
            .post(&self.url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .header("mcp-protocol-version", protocol::PROTOCOL_VERSION);
        for (k, v) in &self.headers {
            req = req.header(k, v);
        }
        if let Some(sid) = self.session_id.lock().unwrap().clone() {
            req = req.header("mcp-session-id", sid);
        }
        req.json(body)
    }
}

/// Pull the JSON-RPC response with `want_id` out of a response body that is
/// either `application/json` (single object) or `text/event-stream` (find the
/// matching `data:` event).
fn extract_response(is_sse: bool, body: &str, want_id: u64) -> Result<Value, String> {
    if is_sse {
        for data in sse_data_payloads(body) {
            if let Ok(msg) = serde_json::from_str::<Value>(&data) {
                if response_id(&msg) == Some(want_id) {
                    return response_result(&msg);
                }
            }
        }
        return Err("no matching response in event stream".to_string());
    }
    let msg: Value = serde_json::from_str(body).map_err(|e| format!("bad response: {e}"))?;
    response_result(&msg)
}

/// Collect the `data:` payloads from an SSE text blob (events separated by blank
/// lines; multi-line data joined with `\n`).
fn sse_data_payloads(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur: Vec<String> = Vec::new();
    for line in text.lines() {
        if line.is_empty() {
            if !cur.is_empty() {
                out.push(cur.join("\n"));
                cur.clear();
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("data:") {
            cur.push(rest.strip_prefix(' ').unwrap_or(rest).to_string());
        }
    }
    if !cur.is_empty() {
        out.push(cur.join("\n"));
    }
    out
}

#[async_trait]
impl Transport for HttpTransport {
    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let body = protocol::request(id, method, params);
        let resp = tokio::time::timeout(REQUEST_TIMEOUT, self.build(&body).send())
            .await
            .map_err(|_| "request timed out".to_string())?
            .map_err(|e| format!("http error: {e}"))?;
        // Capture the session id from the first response (initialize).
        if let Some(sid) = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
        {
            *self.session_id.lock().unwrap() = Some(sid.to_string());
        }
        let is_sse = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .map(|c| c.contains("text/event-stream"))
            .unwrap_or(false);
        if !resp.status().is_success() {
            return Err(format!("http {}", resp.status()));
        }
        let text = resp.text().await.map_err(|e| e.to_string())?;
        extract_response(is_sse, &text, id)
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let body = protocol::notification(method, params);
        let resp = self
            .build(&body)
            .send()
            .await
            .map_err(|e| format!("http error: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("http {}", resp.status()));
        }
        Ok(())
    }

    async fn close(&self) {}
}

// ── legacy SSE ───────────────────────────────────────────────────────────────

pub struct SseTransport {
    client: reqwest::Client,
    endpoint: String,
    headers: HashMap<String, String>,
    corr: Arc<Correlator>,
    reader: Mutex<Option<JoinHandle<()>>>,
}

impl SseTransport {
    /// Open the persistent GET stream, wait for the server's `endpoint` event
    /// (the POST URL), then start routing responses to the correlator.
    pub async fn connect(
        client: reqwest::Client,
        url: String,
        headers: HashMap<String, String>,
    ) -> Result<Self, String> {
        let mut req = client.get(&url).header("accept", "text/event-stream");
        for (k, v) in &headers {
            req = req.header(k, v);
        }
        let resp = req.send().await.map_err(|e| format!("sse connect: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("sse connect: http {}", resp.status()));
        }
        let mut stream = resp.bytes_stream();
        let corr = Arc::new(Correlator::default());

        // Read events until we see the `endpoint` event; keep the stream for the
        // reader task. We accumulate raw text and parse SSE events incrementally.
        let mut buf = String::new();
        let mut endpoint: Option<String> = None;
        let base = reqwest::Url::parse(&url).map_err(|e| e.to_string())?;

        'outer: while endpoint.is_none() {
            let chunk = tokio::time::timeout(REQUEST_TIMEOUT, stream.next())
                .await
                .map_err(|_| "sse connect: timed out waiting for endpoint".to_string())?;
            let Some(chunk) = chunk else {
                return Err("sse connect: stream closed before endpoint".to_string());
            };
            let bytes = chunk.map_err(|e| e.to_string())?;
            buf.push_str(&String::from_utf8_lossy(&bytes));
            for (event, data) in drain_sse_events(&mut buf) {
                if event.as_deref() == Some("endpoint") {
                    let resolved = base.join(data.trim()).map_err(|e| e.to_string())?;
                    endpoint = Some(resolved.to_string());
                    break 'outer;
                }
            }
        }
        let endpoint = endpoint.ok_or("sse connect: no endpoint")?;

        // Reader task: route the rest of the stream's messages to the correlator.
        let reader = {
            let corr = corr.clone();
            tokio::spawn(async move {
                while let Some(Ok(bytes)) = stream.next().await {
                    buf.push_str(&String::from_utf8_lossy(&bytes));
                    for (_event, data) in drain_sse_events(&mut buf) {
                        if let Ok(msg) = serde_json::from_str::<Value>(data.trim()) {
                            corr.resolve(msg);
                        }
                    }
                }
                corr.fail_all();
            })
        };

        Ok(SseTransport {
            client,
            endpoint,
            headers,
            corr,
            reader: Mutex::new(Some(reader)),
        })
    }

    async fn post(&self, body: &Value) -> Result<(), String> {
        let mut req = self
            .client
            .post(&self.endpoint)
            .header("content-type", "application/json");
        for (k, v) in &self.headers {
            req = req.header(k, v);
        }
        let resp = req
            .json(body)
            .send()
            .await
            .map_err(|e| format!("sse post: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("sse post: http {}", resp.status()));
        }
        Ok(())
    }
}

/// Pull complete SSE events (`event:`/`data:` blocks terminated by a blank line)
/// out of `buf`, leaving any trailing partial event behind.
fn drain_sse_events(buf: &mut String) -> Vec<(Option<String>, String)> {
    let mut out = Vec::new();
    loop {
        let Some(sep) = buf.find("\n\n").map(|i| (i, 2)).or_else(|| buf.find("\r\n\r\n").map(|i| (i, 4))) else {
            break;
        };
        let (idx, len) = sep;
        let block: String = buf.drain(..idx + len).collect();
        let mut event = None;
        let mut data: Vec<String> = Vec::new();
        for line in block.lines() {
            if let Some(rest) = line.strip_prefix("event:") {
                event = Some(rest.trim().to_string());
            } else if let Some(rest) = line.strip_prefix("data:") {
                data.push(rest.strip_prefix(' ').unwrap_or(rest).to_string());
            }
        }
        if !data.is_empty() || event.is_some() {
            out.push((event, data.join("\n")));
        }
    }
    out
}

#[async_trait]
impl Transport for SseTransport {
    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let (id, rx) = self.corr.alloc();
        if let Err(e) = self.post(&protocol::request(id, method, params)).await {
            self.corr.cancel(id);
            return Err(e);
        }
        await_response(&self.corr, id, rx).await
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.post(&protocol::notification(method, params)).await
    }

    async fn close(&self) {
        if let Some(r) = self.reader.lock().unwrap().take() {
            r.abort();
        }
    }
}

// ── factory ──────────────────────────────────────────────────────────────────

/// Establish the transport described by `cfg`. For stdio this spawns the
/// subprocess; for SSE it opens the stream and resolves the POST endpoint; for
/// HTTP it is stateless until the first request.
pub async fn connect(
    client: &reqwest::Client,
    cfg: &McpTransportConfig,
) -> Result<Box<dyn Transport>, String> {
    match cfg {
        McpTransportConfig::Stdio { command, args, env } => {
            Ok(Box::new(StdioTransport::spawn(command, args, env)?))
        }
        McpTransportConfig::Http { url, headers } => Ok(Box::new(HttpTransport::new(
            client.clone(),
            url.clone(),
            headers.clone(),
        ))),
        McpTransportConfig::Sse { url, headers } => Ok(Box::new(
            SseTransport::connect(client.clone(), url.clone(), headers.clone()).await?,
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_data_payloads_splits_events() {
        let text = "event: message\ndata: {\"a\":1}\n\ndata: {\"b\":2}\n\n";
        let payloads = sse_data_payloads(text);
        assert_eq!(payloads, vec!["{\"a\":1}".to_string(), "{\"b\":2}".to_string()]);
    }

    #[test]
    fn extract_response_matches_id_in_sse() {
        let body = "data: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"ok\":true}}\n\n";
        let r = extract_response(true, body, 2).unwrap();
        assert_eq!(r, serde_json::json!({ "ok": true }));
        assert!(extract_response(true, body, 99).is_err());
    }

    #[test]
    fn extract_response_parses_plain_json() {
        let body = r#"{"jsonrpc":"2.0","id":1,"result":{"x":1}}"#;
        assert_eq!(
            extract_response(false, body, 1).unwrap(),
            serde_json::json!({ "x": 1 })
        );
    }

    #[test]
    fn drain_sse_events_keeps_partial_tail() {
        let mut buf = String::from("event: endpoint\ndata: /messages\n\ndata: partial");
        let events = drain_sse_events(&mut buf);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0.as_deref(), Some("endpoint"));
        assert_eq!(events[0].1, "/messages");
        assert_eq!(buf, "data: partial"); // partial retained
    }
}
