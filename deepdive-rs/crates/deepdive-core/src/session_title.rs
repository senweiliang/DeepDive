//! AI session-title generation — port of TS `src/session-title.ts`, which
//! itself ports Claude Code's `src/utils/sessionTitle.ts` (Haiku → DeepSeek
//! flash, sentence-case → concise Chinese).
//!
//! One-shot, fire-and-forget: called once after the first real user message
//! of a FRESH session (never on resume). Any failure returns `Ok(None)`
//! silently — the session keeps its default `/rename` title.

use anyhow::Result;
use reqwest::Client;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

pub const SESSION_TITLE_PROMPT: &str = concat!(
    "为这个编码会话生成一个简洁的中文标题（3-10 字），准确概括会话的主要任务或目标。",
    "标题要足够清晰，让用户在会话列表中能一眼认出。\n\n",
    "只返回 JSON：{\"title\": \"...\"}\n\n",
    "好例子：\n",
    "{\"title\": \"修复移动端登录按钮\"}\n",
    "{\"title\": \"添加 OAuth 认证\"}\n",
    "{\"title\": \"排查 CI 测试失败\"}\n",
    "{\"title\": \"重构 API 客户端错误处理\"}\n\n",
    "坏例子（太笼统）：{\"title\": \"代码修改\"}\n",
    "坏例子（太长）：{\"title\": \"调查并修复移动设备上登录按钮无法响应的问题\"}\n",
    "坏例子（口语化）：{\"title\": \"帮我搞一下那个登录的 bug\"}",
);

/// Session-title generation timeout (port of TS `SESSION_TITLE_TIMEOUT_MS`).
pub const SESSION_TITLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

const MAX_DESCRIPTION_LENGTH: usize = 1000;
const MAX_TITLE_TOKENS: u64 = 100;

/// Tolerant `{"title":"..."}` extraction (survives markdown fences / stray text).
pub fn extract_title_json(text: &str) -> Option<String> {
    let start = text.find("\"title\"")?;
    let after_key = &text[start + "\"title\"".len()..];
    let colon = after_key.find(':')?;
    let rest = after_key[colon + 1..].trim_start();
    let rest = rest.strip_prefix('"')?;
    let end = rest.find('"')?;
    let title = rest[..end].trim();
    if title.is_empty() {
        None
    } else {
        Some(title.to_string())
    }
}

/// First real user-message text: skips meta messages, slash commands (`/…`)
/// and inline bash (`!…`), tail-capped.
pub fn first_real_user_text(messages: &[crate::types::Message]) -> Option<&str> {
    for msg in messages {
        if msg.role != crate::types::Role::User || msg.meta {
            continue;
        }
        let text = msg.content.trim();
        if text.is_empty() || text.starts_with('/') || text.starts_with('!') {
            continue;
        }
        // Char-boundary cut at MAX_DESCRIPTION_LENGTH chars.
        let end = text
            .char_indices()
            .nth(MAX_DESCRIPTION_LENGTH)
            .map(|(i, _)| i)
            .unwrap_or(text.len());
        return Some(&text[..end]);
    }
    None
}

/// Generate a session title from the user's first message via the summary
/// model (flash). `Ok(None)` on ANY failure — caller treats it as "no title,
/// keep the default" and never retries this session.
pub async fn generate_session_title(
    client: &Client,
    config: &crate::config::Config,
    description: &str,
    cancel: &CancellationToken,
) -> Result<Option<String>> {
    let trimmed = description.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    // resolve_model so a session on `model: "auto"` doesn't send the literal
    // "auto" (parity with TS `resolveModel(config.summaryModel || config.model)`).
    let base = if config.summary_model.is_empty() {
        &config.model
    } else {
        &config.summary_model
    };
    let model = crate::config::resolve_model(base).to_string();
    let user_content = format!("{}\n\n{}", SESSION_TITLE_PROMPT, trimmed);
    let body = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": user_content}],
        "max_tokens": MAX_TITLE_TOKENS,
        // "none" (not "off") is the API's no-thinking level: with any thinking
        // enabled the reasoning phase eats the whole 100-token budget and
        // `content` comes back empty (finish_reason: length → no title).
        "reasoning_effort": "none",
        "stream": false,
    })
    .to_string();

    let url = format!("{}/chat/completions", config.base_url);
    let send = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", config.api_key))
        .body(body)
        .send();

    let resp = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Ok(None),
        r = send => match r {
            Ok(r) => r,
            // Network failure → silent (TS `catch { return null }`).
            Err(_) => return Ok(None),
        },
    };
    if !resp.status().is_success() {
        return Ok(None);
    }
    let json: Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    let content = json
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(Value::as_str)
        .unwrap_or("");
    Ok(extract_title_json(content))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_title_json_handles_bare_fenced_and_stray_text() {
        assert_eq!(
            extract_title_json("{\"title\": \"修复移动端登录按钮\"}"),
            Some("修复移动端登录按钮".to_string())
        );
        assert_eq!(
            extract_title_json("```json\n{\"title\": \"添加 OAuth 认证\"}\n```"),
            Some("添加 OAuth 认证".to_string())
        );
        assert_eq!(
            extract_title_json("prefix {\"title\" : \"重构\"} suffix"),
            Some("重构".to_string())
        );
        assert_eq!(extract_title_json("{\"title\": \"\"}"), None);
        assert_eq!(extract_title_json("no json here"), None);
    }

    #[test]
    fn first_real_user_text_skips_meta_slash_and_bash() {
        use crate::types::Message;
        let mk = |role: crate::types::Role, content: &str, meta: bool| Message {
            role,
            content: content.to_string(),
            tool_calls: Vec::new(),
            tool_call_id: None,
            reasoning_content: None,
            usage: None,
            interrupted: false,
            meta,
            bash: false,
            bash_output: None,
            error: false,
            turn_summary_strategy: None,
        };
        let msgs = vec![
            mk(crate::types::Role::User, "/model", false),
            mk(crate::types::Role::User, "ls -la", true),
            mk(crate::types::Role::User, "!pnpm build", false),
            mk(crate::types::Role::User, "修复一下登录 bug", false),
        ];
        assert_eq!(first_real_user_text(&msgs), Some("修复一下登录 bug"));
        assert_eq!(
            first_real_user_text(&[mk(crate::types::Role::User, "/clear", false)]),
            None
        );
    }

    #[test]
    fn first_real_user_text_caps_length() {
        use crate::types::Message;
        let mk = Message {
            role: crate::types::Role::User,
            content: "x".repeat(2000),
            tool_calls: Vec::new(),
            tool_call_id: None,
            reasoning_content: None,
            usage: None,
            interrupted: false,
            meta: false,
            bash: false,
            bash_output: None,
            error: false,
            turn_summary_strategy: None,
        };
        let msgs = [mk];
        let got = first_real_user_text(&msgs).unwrap();
        assert!(got.chars().count() <= MAX_DESCRIPTION_LENGTH);
    }
}
