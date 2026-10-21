//! zcashd-compatible wallet JSON-RPC backend (Zallet on the VPS, behind TLS + basic auth).
//! Methods used: getblockcount, z_listreceivedbyaddress, z_getbalanceforaccount,
//! z_sendmany, z_getoperationresult, gettransaction / getrawtransaction.
//! Field names follow zcashd; verify them against the Zallet version you deploy.

use super::{Balance, Chain, IncomingNote, SendError};
use crate::config::Config;
use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::time::Duration;

pub struct RpcChain {
    http: reqwest::Client,
    url: String,
    user: Option<String>,
    password: Option<String>,
    reserve_ua: String,
    account: u32,
    privacy_policy: String,
}

impl RpcChain {
    pub fn new(cfg: &Config) -> Result<Self> {
        Ok(Self {
            http: reqwest::Client::builder().timeout(Duration::from_secs(60)).build()?,
            url: cfg.wallet_rpc_url.clone().context("WALLET_RPC_URL is required for CHAIN_BACKEND=rpc")?,
            user: cfg.wallet_rpc_user.clone(),
            password: cfg.wallet_rpc_password.clone(),
            reserve_ua: cfg.reserve_ua.clone(),
            account: cfg.wallet_account,
            privacy_policy: cfg.wallet_privacy_policy.clone(),
        })
    }

    /// Poll an async wallet operation (proving takes seconds) for up to ~3 minutes.
    async fn wait_op(&self, opid: &str) -> std::result::Result<String, SendError> {
        for _ in 0..90 {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let r = match self.call("z_getoperationresult", json!([[opid]])).await {
                Ok(r) => r,
                Err(_) => continue,
            };
            let Some(op) = r.as_array().and_then(|a| a.first()) else { continue };
            match op["status"].as_str() {
                Some("success") => {
                    return op["result"]["txid"].as_str().map(str::to_string).ok_or_else(|| SendError::Unknown("success without txid".into()))
                }
                Some("failed") => return Err(SendError::NotBroadcast(op["error"]["message"].as_str().unwrap_or("failed").into())),
                _ => {}
            }
        }
        Err(SendError::Unknown(format!("operation {opid} did not finish")))
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let mut req = self.http.post(&self.url).json(&json!({"jsonrpc": "1.0", "id": "zeep", "method": method, "params": params}));
        if let Some(u) = &self.user {
            req = req.basic_auth(u, self.password.as_ref());
        }
        let v: Value = req.send().await?.json().await.with_context(|| format!("{method}: bad response"))?;
        if !v["error"].is_null() {
            bail!("{method}: {}", v["error"]);
        }
        Ok(v["result"].clone())
    }
}

fn zats_to_zec(z: i64) -> String {
    format!("{}.{:08}", z / 100_000_000, z % 100_000_000)
}

fn pool(v: &Value, name: &str) -> i64 {
    v["pools"][name]["valueZat"].as_i64().unwrap_or(0)
}
fn shielded(v: &Value) -> i64 {
    pool(v, "sapling") + pool(v, "orchard")
}

#[async_trait]
impl Chain for RpcChain {
    async fn tip_height(&mut self) -> Result<u32> {
        Ok(self.call("getblockcount", json!([])).await?.as_u64().ok_or_else(|| anyhow!("bad height"))? as u32)
    }

    async fn new_address(&mut self, diversifier_index: u64) -> Result<String> {
        // Shielded receivers only, so a deposit can never land in a transparent output.
        let v = self.call("z_getaddressforaccount", json!([self.account, ["sapling", "orchard"], diversifier_index])).await?;
        v["address"].as_str().map(str::to_string).ok_or_else(|| anyhow!("no address returned"))
    }

    async fn received(&mut self, addresses: &[String]) -> Result<Vec<IncomingNote>> {
        let mut out = vec![];
        for addr in addresses {
            let list = self.call("z_listreceivedbyaddress", json!([addr, 0])).await?;
            for n in list.as_array().cloned().unwrap_or_default() {
                if n["change"].as_bool() == Some(true) {
                    continue;
                }
                let index = n["outindex"].as_u64().or(n["actionidx"].as_u64()).or(n["outputIndex"].as_u64()).unwrap_or(0) as u32;
                out.push(IncomingNote {
                    to_address: addr.clone(),
                    txid: n["txid"].as_str().unwrap_or_default().to_string(),
                    index,
                    height: n["blockheight"].as_u64().unwrap_or(0) as u32,
                    confirmations: n["confirmations"].as_u64().unwrap_or(0) as u32,
                    amount_zats: n["amountZat"].as_i64().ok_or_else(|| anyhow!("note without amountZat"))?,
                });
            }
        }
        Ok(out)
    }

    async fn balance(&mut self) -> Result<Balance> {
        let total = self.call("z_getbalanceforaccount", json!([self.account, 0])).await?;
        let spendable = self.call("z_getbalanceforaccount", json!([self.account, 1])).await?;
        Ok(Balance {
            total_zats: shielded(&total) + pool(&total, "transparent"),
            spendable_zats: shielded(&spendable),
            transparent_zats: pool(&spendable, "transparent"),
        })
    }

    async fn shield(&mut self) -> Result<Option<String>> {
        let bal = self.balance().await?;
        // Leave room for the ZIP-317 fee (conservative upper bound for a few inputs).
        let amount = bal.transparent_zats - 30_000;
        if amount <= 0 {
            return Ok(None);
        }
        let opid = self
            .call("z_sendmany", json!(["ANY_TADDR", [{"address": self.reserve_ua, "amount": zats_to_zec(amount)}], 1, null, "AllowRevealedSenders"]))
            .await?;
        let opid = opid.as_str().ok_or_else(|| anyhow!("no operation id"))?.to_string();
        self.wait_op(&opid).await.map(Some).map_err(|e| anyhow!("{e}"))
    }

    async fn send(&mut self, to: &str, amount_zats: i64) -> std::result::Result<String, SendError> {
        // Transparent recipients (NEAR Intents deposit addresses, opted-in user payouts)
        // need a policy that allows revealing the recipient.
        let policy = if to.starts_with('t') { "AllowRevealedRecipients" } else { self.privacy_policy.as_str() };
        let opid = self
            .call("z_sendmany", json!([self.reserve_ua, [{"address": to, "amount": zats_to_zec(amount_zats)}], 1, null, policy]))
            .await
            .map_err(|e| SendError::NotBroadcast(e.to_string()))?;
        let opid = opid.as_str().ok_or_else(|| SendError::NotBroadcast("no operation id".into()))?.to_string();
        self.wait_op(&opid).await
    }

    async fn confirmations(&mut self, txid: &str) -> Result<Option<u32>> {
        let v = match self.call("gettransaction", json!([txid])).await {
            Ok(v) => v,
            Err(_) => self.call("getrawtransaction", json!([txid, 1])).await?,
        };
        Ok(v["confirmations"].as_i64().filter(|c| *c >= 0).map(|c| c as u32))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn formats_zec() {
        assert_eq!(super::zats_to_zec(152_000), "0.00152000");
        assert_eq!(super::zats_to_zec(1_000_000_000), "10.00000000");
    }
}
