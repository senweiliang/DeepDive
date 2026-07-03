//! WebFetch tool — fetch a URL and return readable text. Faithful port of
//! `src/tools/webfetch.ts`. Read-only + network-only.
//!
//! The TS script/style drop uses a `</\1>` backreference; since the tag set is
//! fixed we expand it into one regex per tag (no backreference needed, so the
//! plain `regex` crate suffices). The `<a>` rewrite uses a closure replacer.

use crate::tools::executor::ToolResult;
use regex::{Captures, Regex};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const CACHE_TTL: Duration = Duration::from_secs(15 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_millis(15_000);
const MAX_CHARS: usize = 50_000;
const THIN_TEXT: usize = 200;

static CACHE: LazyLock<Mutex<HashMap<String, (Instant, String)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

const DROP_TAGS: &[&str] = &["script", "style", "noscript", "template", "svg", "head"];
static DROP_RES: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    DROP_TAGS
        .iter()
        .map(|t| Regex::new(&format!(r"(?is)<{t}\b.*?</{t}>")).unwrap())
        .collect()
});
static COMMENT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<!--.*?-->").unwrap());
static LINK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<a\b[^>]*\bhref=['"]([^'"]+)['"][^>]*>(.*?)</a>"#).unwrap()
});
static TAG_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]+>").unwrap());
static BLOCK_CLOSE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)</(p|div|section|article|tr|h[1-6]|blockquote)\s*>").unwrap()
});
static BR_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<(br|hr)\s*/?>").unwrap());
static LI_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<li\b[^>]*>").unwrap());
static INLINE_WS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[ \t\x0c\x0b]+").unwrap());
static BLANKS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").unwrap());
static BLOCKED_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(enable javascript|requires javascript|javascript is (disabled|required)|checking your browser|just a moment|attention required|verify you are (a )?human|press & hold|you have been blocked|access denied|unusual traffic)\b").unwrap()
});

fn decode_entities(s: &str) -> String {
    // Order matters: &amp; last so earlier replacements aren't double-decoded.
    s.replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&quot;", "\"")
        .replace("&nbsp;", " ")
        .replace("&mdash;", "—")
        .replace("&ndash;", "–")
        .replace("&hellip;", "…")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// Convert an HTML document to readable plain text (a small regex pipeline, not
/// a parser).
pub fn html_to_text(html: &str) -> String {
    let mut s = html.to_string();

    for re in DROP_RES.iter() {
        s = re.replace_all(&s, " ").into_owned();
    }
    s = COMMENT_RE.replace_all(&s, " ").into_owned();

    // <a href="X">label</a> → "label (X)".
    s = LINK_RE
        .replace_all(&s, |caps: &Captures| {
            let href = &caps[1];
            let text = TAG_RE.replace_all(&caps[2], "").trim().to_string();
            if text.is_empty() {
                String::new()
            } else if href.starts_with("http") {
                format!("{text} ({href})")
            } else {
                text
            }
        })
        .into_owned();

    s = BLOCK_CLOSE_RE.replace_all(&s, "\n").into_owned();
    s = BR_RE.replace_all(&s, "\n").into_owned();
    s = LI_RE.replace_all(&s, "\n- ").into_owned();

    s = TAG_RE.replace_all(&s, "").into_owned();
    s = decode_entities(&s);

    let collapsed: Vec<String> = s
        .split('\n')
        .map(|line| INLINE_WS_RE.replace_all(line, " ").trim().to_string())
        .collect();
    let joined = collapsed.join("\n");
    BLANKS_RE.replace_all(&joined, "\n\n").trim().to_string()
}

/// Heuristic: an anti-bot / JS-shell placeholder instead of the page.
pub fn looks_blocked(text: &str, is_html: bool) -> bool {
    if is_html && text.chars().count() < THIN_TEXT {
        return true;
    }
    text.chars().count() < 1500 && BLOCKED_RE.is_match(text)
}

/// Validate/normalize the URL: require http(s), upgrade http→https.
fn normalize_url(raw: &str) -> Option<String> {
    let mut u = reqwest::Url::parse(raw.trim()).ok()?;
    match u.scheme() {
        "https" => {}
        "http" => {
            u.set_scheme("https").ok()?;
        }
        _ => return None,
    }
    Some(u.to_string())
}

/// Fetch a URL and return its content as text.
pub async fn execute_web_fetch(client: &reqwest::Client, args: &serde_json::Value) -> ToolResult {
    let Some(url) = normalize_url(args.get("url").and_then(|v| v.as_str()).unwrap_or("")) else {
        return ToolResult::error("Error: a valid http(s) url is required.");
    };

    if let Some((at, content)) = CACHE.lock().unwrap().get(&url) {
        if at.elapsed() < CACHE_TTL {
            return ToolResult::ok(content.clone());
        }
    }

    let resp = match client
        .get(&url)
        .header("User-Agent", UA)
        .header("Accept", "text/html,*/*")
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => {
            return ToolResult::error(format!(
                "Error: failed to fetch {url} (network error or timeout)."
            ))
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let reason = status.canonical_reason().unwrap_or("");
        return ToolResult::error(format!(
            "Error: {url} returned HTTP {} {reason}.",
            status.as_u16()
        ));
    }

    let ctype = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let raw = resp.text().await.unwrap_or_default();
    let is_html = ctype.to_lowercase().contains("html");
    let body = if is_html {
        html_to_text(&raw)
    } else {
        raw.trim().to_string()
    };

    if body.is_empty() {
        return ToolResult::ok(format!(
            "Fetched {url} but it had no extractable text content."
        ));
    }
    if looks_blocked(&body, is_html) {
        return ToolResult::error(format!(
            "Error: {url} requires JavaScript or blocks automated access — its content cannot be fetched. Do not retry this URL or other pages on this site; use a different source instead."
        ));
    }

    let char_count = body.chars().count();
    let truncated = if char_count > MAX_CHARS {
        let head: String = body.chars().take(MAX_CHARS).collect();
        format!(
            "{head}\n\n[truncated — {} more chars]",
            char_count - MAX_CHARS
        )
    } else {
        body
    };
    let content = format!("Content of {url}:\n\n{truncated}");
    CACHE
        .lock()
        .unwrap()
        .insert(url, (Instant::now(), content.clone()));
    ToolResult::ok(content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_to_text_pipeline() {
        let html = r#"<head><title>T</title></head><body>
            <script>var x = 1;</script>
            <p>Hello &amp; welcome</p>
            <a href="https://example.com">click here</a>
            <ul><li>one</li><li>two</li></ul>
            <div>line</div><br>after
        </body>"#;
        let text = html_to_text(html);
        assert!(!text.contains("var x"), "script must be dropped");
        assert!(
            text.contains("Hello & welcome"),
            "entities decoded, p → line"
        );
        assert!(
            text.contains("click here (https://example.com)"),
            "link formatted"
        );
        assert!(text.contains("- one"));
        assert!(text.contains("- two"));
        assert!(text.contains("line"));
        assert!(text.contains("after"));
    }

    #[test]
    fn relative_link_keeps_only_text() {
        let text = html_to_text(r#"<a href="/local">label</a>"#);
        assert_eq!(text, "label");
    }

    #[test]
    fn decode_entities_order() {
        assert_eq!(decode_entities("a &amp; b &lt;c&gt;"), "a & b <c>");
        assert_eq!(decode_entities("&#39;q&quot;"), "'q\"");
    }

    #[test]
    fn looks_blocked_thin_html_and_botwall() {
        assert!(looks_blocked("tiny", true)); // thin HTML
        assert!(!looks_blocked("tiny", false)); // short non-HTML is fine
        assert!(looks_blocked(
            "Just a moment... checking your browser",
            false
        ));
        assert!(!looks_blocked(&"x".repeat(2000), true)); // long real page
    }

    #[test]
    fn normalize_url_upgrades_and_validates() {
        assert!(normalize_url("http://example.com")
            .unwrap()
            .starts_with("https://"));
        assert!(normalize_url("https://example.com/path").is_some());
        assert!(normalize_url("ftp://example.com").is_none());
        assert!(normalize_url("not a url").is_none());
    }
}
