//! Network resilience for the chat / summarize paths: a connect-phase deadline,
//! an idle deadline for the streaming phase, and automatic retry of transient
//! failures. Port of TS `src/net.ts` (proxy support needs no code here — reqwest
//! reads `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` by itself).

use anyhow::{anyhow, Result};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio_util::sync::CancellationToken;

/// Connect phase budget: DNS + TCP + TLS + request + response headers. reqwest's
/// `send()` future resolves on headers, so a timeout around it covers exactly
/// this phase and leaves the streaming body unbounded.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(45);
/// Streaming phase budget: max gap between two SSE chunks.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(300);

const MAX_ATTEMPTS: u32 = 4; // 1 try + 3 retries
const BASE_BACKOFF_MS: u64 = 500;
const MAX_BACKOFF_MS: u64 = 8_000;
/// Past this, honoring `Retry-After` would hang the UI — fail fast instead.
const RETRY_AFTER_CAP: Duration = Duration::from_secs(60);

/// 408/429/5xx are transient; other 4xx mean the request itself is wrong.
pub fn is_retriable_status(status: u16) -> bool {
    status == 408 || status == 429 || status >= 500
}

/// `Retry-After` is either delta-seconds or an IMF-fixdate (RFC 9110 §10.2.3).
pub fn parse_retry_after(value: Option<&str>, now_secs: u64) -> Option<Duration> {
    let raw = value?.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(secs) = raw.parse::<u64>() {
        return Some(Duration::from_secs(secs));
    }
    let at = parse_http_date(raw)?;
    Some(Duration::from_secs(at.saturating_sub(now_secs)))
}

/// `Sun, 06 Nov 1994 08:49:37 GMT` -> Unix seconds. Only IMF-fixdate is
/// accepted; the two obsolete RFC 9110 formats are not worth the surface.
fn parse_http_date(raw: &str) -> Option<u64> {
    let parts: Vec<&str> = raw.split_whitespace().collect();
    if parts.len() != 6 || parts[5] != "GMT" {
        return None;
    }
    let day: u32 = parts[1].parse().ok()?;
    let month = match parts[2] {
        "Jan" => 1,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => return None,
    };
    let year: i64 = parts[3].parse().ok()?;
    let hms: Vec<&str> = parts[4].split(':').collect();
    if hms.len() != 3 {
        return None;
    }
    let (h, m, s): (u64, u64, u64) = (
        hms[0].parse().ok()?,
        hms[1].parse().ok()?,
        hms[2].parse().ok()?,
    );
    let days = days_from_civil(year, month, day);
    let secs = days * 86_400 + (h * 3600 + m * 60 + s) as i64;
    u64::try_from(secs).ok()
}

/// Days since 1970-01-01, Howard Hinnant's civil-date algorithm.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = i64::from(if m > 2 { m - 3 } else { m + 9 });
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Exponential backoff with half jitter, so retries from concurrent sessions
/// don't re-collide in lockstep. A server-sent `Retry-After` always wins.
/// `jitter` is in `[0, 1)`.
pub fn backoff_delay(attempt: u32, retry_after: Option<Duration>, jitter: f64) -> Duration {
    if let Some(d) = retry_after {
        return d;
    }
    let window = BASE_BACKOFF_MS
        .checked_shl(attempt)
        .unwrap_or(MAX_BACKOFF_MS)
        .min(MAX_BACKOFF_MS);
    let half = window / 2;
    Duration::from_millis(half + (jitter * half as f64).round() as u64)
}

/// Sub-second clock noise as a jitter source — avoids pulling in a rand crate
/// for what only needs to de-correlate concurrent retries.
fn jitter_frac() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| f64::from(d.subsec_nanos()) / 1e9)
        .unwrap_or(0.5)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

async fn sleep_or_cancel(delay: Duration, cancel: &CancellationToken) -> Result<()> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(anyhow!("request cancelled")),
        _ = tokio::time::sleep(delay) => Ok(()),
    }
}

/// Send with a connect-phase deadline and automatic retry of transient
/// failures. `build` is called once per attempt because `send()` consumes the
/// builder. A response still failing when retries run out is returned as-is
/// (body unread) so callers keep owning their own error message.
pub async fn send_resilient<F>(
    build: F,
    cancel: &CancellationToken,
    label: &str,
) -> Result<reqwest::Response>
where
    F: Fn() -> reqwest::RequestBuilder,
{
    let mut last_err: Option<anyhow::Error> = None;

    for attempt in 0..MAX_ATTEMPTS {
        let send = build().send();
        let outcome = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(anyhow!("request cancelled")),
            r = tokio::time::timeout(CONNECT_TIMEOUT, send) => r,
        };

        let resp = match outcome {
            Ok(Ok(resp)) => resp,
            Ok(Err(e)) => {
                last_err = Some(anyhow!(e));
                if attempt + 1 == MAX_ATTEMPTS {
                    break;
                }
                let delay = backoff_delay(attempt, None, jitter_frac());
                tracing::warn!("{label} retry {} in {:?}: transport error", attempt + 1, delay);
                sleep_or_cancel(delay, cancel).await?;
                continue;
            }
            Err(_elapsed) => {
                last_err = Some(anyhow!(
                    "Connect timeout after {}s",
                    CONNECT_TIMEOUT.as_secs()
                ));
                if attempt + 1 == MAX_ATTEMPTS {
                    break;
                }
                let delay = backoff_delay(attempt, None, jitter_frac());
                tracing::warn!("{label} retry {} in {:?}: connect timeout", attempt + 1, delay);
                sleep_or_cancel(delay, cancel).await?;
                continue;
            }
        };

        let status = resp.status();
        if status.is_success() || !is_retriable_status(status.as_u16()) {
            return Ok(resp);
        }

        let retry_after = parse_retry_after(
            resp.headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok()),
            now_secs(),
        );
        let last_attempt = attempt + 1 == MAX_ATTEMPTS;
        if last_attempt || retry_after.is_some_and(|d| d > RETRY_AFTER_CAP) {
            return Ok(resp);
        }
        drop(resp); // release the pooled connection before sleeping
        let delay = backoff_delay(attempt, retry_after, jitter_frac());
        tracing::warn!("{label} retry {} in {:?}: HTTP {status}", attempt + 1, delay);
        sleep_or_cancel(delay, cancel).await?;
    }

    Err(last_err.unwrap_or_else(|| anyhow!("{label} request failed")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retriable_statuses() {
        for s in [408, 429, 500, 502, 503, 504] {
            assert!(is_retriable_status(s), "{s} should retry");
        }
        for s in [400, 401, 403, 404, 422] {
            assert!(!is_retriable_status(s), "{s} should not retry");
        }
    }

    #[test]
    fn retry_after_delta_seconds() {
        assert_eq!(parse_retry_after(Some("3"), 0), Some(Duration::from_secs(3)));
        assert_eq!(parse_retry_after(Some("0"), 0), Some(Duration::ZERO));
        assert_eq!(
            parse_retry_after(Some("  12 "), 0),
            Some(Duration::from_secs(12))
        );
    }

    #[test]
    fn retry_after_http_date() {
        // 1994-11-06T08:49:37Z = 784111777
        let now = 784_111_777;
        assert_eq!(
            parse_retry_after(Some("Sun, 06 Nov 1994 08:49:37 GMT"), now),
            Some(Duration::ZERO)
        );
        assert_eq!(
            parse_retry_after(Some("Sun, 06 Nov 1994 08:50:07 GMT"), now),
            Some(Duration::from_secs(30))
        );
        // A past date clamps to zero rather than underflowing.
        assert_eq!(
            parse_retry_after(Some("Sun, 06 Nov 1994 08:00:00 GMT"), now),
            Some(Duration::ZERO)
        );
    }

    #[test]
    fn retry_after_rejects_junk() {
        assert_eq!(parse_retry_after(None, 0), None);
        assert_eq!(parse_retry_after(Some(""), 0), None);
        assert_eq!(parse_retry_after(Some("soon"), 0), None);
        assert_eq!(parse_retry_after(Some("Sun, 06 Nov 1994 08:49:37"), 0), None);
        assert_eq!(parse_retry_after(Some("Sun, 06 Foo 1994 08:49:37 GMT"), 0), None);
    }

    #[test]
    fn backoff_prefers_retry_after() {
        assert_eq!(
            backoff_delay(0, Some(Duration::from_secs(7)), 0.5),
            Duration::from_secs(7)
        );
    }

    #[test]
    fn backoff_grows_within_jitter_window() {
        assert_eq!(backoff_delay(0, None, 0.0), Duration::from_millis(250));
        assert_eq!(backoff_delay(1, None, 0.0), Duration::from_millis(500));
        assert_eq!(backoff_delay(2, None, 0.0), Duration::from_millis(1000));
        assert_eq!(backoff_delay(0, None, 1.0), Duration::from_millis(500));
    }

    #[test]
    fn backoff_caps_the_window() {
        assert_eq!(backoff_delay(20, None, 1.0), Duration::from_millis(8000));
        // A shift wide enough to overflow still lands on the cap, not a panic.
        assert_eq!(backoff_delay(99, None, 1.0), Duration::from_millis(8000));
    }

    #[test]
    fn civil_days_match_known_epochs() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 3, 1), 11017);
        assert_eq!(days_from_civil(1969, 12, 31), -1);
    }

    #[tokio::test]
    async fn send_resilient_bails_out_when_cancelled() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let client = reqwest::Client::new();
        let err = send_resilient(|| client.get("http://127.0.0.1:1/x"), &cancel, "test")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("cancelled"));
    }
}
