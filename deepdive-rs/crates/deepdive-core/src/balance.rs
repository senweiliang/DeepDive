//! Account balance query. Faithful port of `src/balance.ts`: GET `/user/balance`
//! with a 5s timeout, reading `balance_infos[0]`. Network failures return `None`
//! (balance is best-effort UI sugar, never load-bearing).

use crate::config::Config;
use serde_json::Value;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Balance {
    pub total_balance: String,
    pub currency: String,
}

impl Balance {
    /// e.g. "12.34 CNY".
    pub fn display(&self) -> String {
        format!("{} {}", self.total_balance, self.currency)
    }
}

pub async fn fetch_balance(client: &reqwest::Client, config: &Config) -> Option<Balance> {
    let url = format!("{}/user/balance", config.base_url);
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let json: Value = resp.json().await.ok()?;
    parse_balance(&json)
}

/// Pure parse of the `/user/balance` response. `currency` defaults to `CNY`.
fn parse_balance(v: &Value) -> Option<Balance> {
    let info = v.get("balance_infos")?.as_array()?.first()?;
    let total = info.get("total_balance")?.as_str()?;
    if total.is_empty() {
        return None;
    }
    let currency = info
        .get("currency")
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty())
        .unwrap_or("CNY");
    Some(Balance {
        total_balance: total.to_string(),
        currency: currency.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_balance_info() {
        let v = json!({ "balance_infos": [{ "total_balance": "42.50", "currency": "USD" }] });
        assert_eq!(
            parse_balance(&v),
            Some(Balance {
                total_balance: "42.50".into(),
                currency: "USD".into()
            })
        );
    }

    #[test]
    fn currency_defaults_to_cny() {
        let v = json!({ "balance_infos": [{ "total_balance": "10" }] });
        let b = parse_balance(&v).unwrap();
        assert_eq!(b.currency, "CNY");
        assert_eq!(b.display(), "10 CNY");
    }

    #[test]
    fn missing_or_empty_yields_none() {
        assert!(parse_balance(&json!({})).is_none());
        assert!(parse_balance(&json!({ "balance_infos": [] })).is_none());
        assert!(parse_balance(&json!({ "balance_infos": [{ "total_balance": "" }] })).is_none());
        assert!(parse_balance(&json!({ "balance_infos": [{ "currency": "CNY" }] })).is_none());
    }
}
