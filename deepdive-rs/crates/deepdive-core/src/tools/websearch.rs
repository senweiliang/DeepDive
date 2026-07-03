//! WebSearch tool — Tavily provider. Faithful port of `src/tools/websearch.ts`.
//! Read-only + network-only: no workspace, no approval gate.

use crate::tools::executor::ToolResult;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

const CACHE_TTL: Duration = Duration::from_secs(15 * 60);
const DEFAULT_MAX: u64 = 10;
const REQUEST_TIMEOUT: Duration = Duration::from_millis(12_000);

static CACHE: LazyLock<Mutex<HashMap<String, (Instant, String)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static WS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());

struct SearchResult {
    title: String,
    url: String,
    snippet: String,
}

fn collapse_ws(s: &str) -> String {
    WS_RE.replace_all(s.trim(), " ").to_string()
}

fn format_results(query: &str, results: &[SearchResult]) -> String {
    let mut lines = vec![
        format!("Web search results for \"{query}\":"),
        String::new(),
    ];
    for (i, r) in results.iter().enumerate() {
        lines.push(format!("{}. {}", i + 1, r.title));
        if !r.url.is_empty() {
            lines.push(format!("   {}", r.url));
        }
        if !r.snippet.is_empty() {
            lines.push(format!("   {}", r.snippet));
        }
        lines.push(String::new());
    }
    lines.join("\n").trim_end().to_string()
}

async fn search_tavily(
    client: &reqwest::Client,
    query: &str,
    max_results: u64,
    api_key: &str,
) -> Result<Vec<SearchResult>, String> {
    let resp = client
        .post("https://api.tavily.com/search")
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {api_key}"))
        .timeout(REQUEST_TIMEOUT)
        .body(
            json!({ "query": query, "max_results": max_results, "search_depth": "basic" })
                .to_string(),
        )
        .send()
        .await
        .map_err(|_| "Tavily search request failed (network/timeout).".to_string())?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let detail = if status == 401 || status == 403 {
            " (check TAVILY_API_KEY)"
        } else {
            ""
        };
        return Err(format!("Tavily search failed (HTTP {status}){detail}."));
    }

    let data: Value = resp
        .json()
        .await
        .map_err(|_| "Tavily search request failed (network/timeout).".to_string())?;
    let results = data
        .get("results")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|r| SearchResult {
                    title: r
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    url: r
                        .get("url")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    snippet: collapse_ws(r.get("content").and_then(Value::as_str).unwrap_or("")),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(results)
}

/// Execute a web search via Tavily.
pub async fn execute_web_search(
    client: &reqwest::Client,
    args: &Value,
    tavily_api_key: &str,
) -> ToolResult {
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if query.is_empty() {
        return ToolResult::error("Error: query is required.");
    }
    let max_results = args
        .get("max_results")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n != 0.0)
        .map(|n| n as u64)
        .unwrap_or(DEFAULT_MAX)
        .clamp(1, 20);

    if tavily_api_key.is_empty() {
        return ToolResult::error(
            "Web search requires a Tavily API key. Set TAVILY_API_KEY in settings or environment.",
        );
    }

    let cache_key = format!("tavily:{query}");
    if let Some((at, content)) = CACHE.lock().unwrap().get(&cache_key) {
        if at.elapsed() < CACHE_TTL {
            return ToolResult::ok(content.clone());
        }
    }

    match search_tavily(client, &query, max_results, tavily_api_key).await {
        Err(msg) => ToolResult::error(msg),
        Ok(results) if results.is_empty() => {
            ToolResult::ok(format!("No web results found for \"{query}\"."))
        }
        Ok(results) => {
            let content = format_results(&query, &results);
            CACHE
                .lock()
                .unwrap()
                .insert(cache_key, (Instant::now(), content.clone()));
            ToolResult::ok(content)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_results_block() {
        let results = vec![
            SearchResult {
                title: "First".into(),
                url: "https://a.com".into(),
                snippet: "alpha".into(),
            },
            SearchResult {
                title: "Second".into(),
                url: "https://b.com".into(),
                snippet: String::new(),
            },
        ];
        let out = format_results("rust", &results);
        assert!(out.starts_with(
            "Web search results for \"rust\":\n\n1. First\n   https://a.com\n   alpha"
        ));
        assert!(out.contains("2. Second\n   https://b.com"));
        // trailing whitespace trimmed
        assert!(!out.ends_with('\n'));
    }

    #[test]
    fn collapse_whitespace() {
        assert_eq!(collapse_ws("  a\n\t b   c "), "a b c");
    }

    #[tokio::test]
    async fn empty_query_errors() {
        let client = reqwest::Client::new();
        let r = execute_web_search(&client, &json!({ "query": "  " }), "key").await;
        assert!(r.is_error);
        assert!(r.content.contains("query is required"));
    }

    #[tokio::test]
    async fn missing_api_key_errors() {
        let client = reqwest::Client::new();
        let r = execute_web_search(&client, &json!({ "query": "rust" }), "").await;
        assert!(r.is_error);
        assert!(r.content.contains("Tavily API key"));
    }
}
