//! Simulated chain for local development and CI. Block height advances with wall-clock
//! time (DEV_BLOCK_SECS per block). Insert rows into `dev_incoming` to "pay" Zeep.

use super::{Balance, Chain, IncomingNote, SendError};
use crate::config::Config;
use anyhow::Result;
use async_trait::async_trait;
use rand::RngCore;
use sqlx::{PgPool, Row};

pub const DEV_FEE_ZATS: i64 = 10_000;

pub struct DevChain {
    pool: PgPool,
    genesis: i64,
    block_secs: i64,
}

impl DevChain {
    pub fn new(pool: PgPool, cfg: &Config) -> Self {
        Self { pool, genesis: cfg.dev_genesis_unix, block_secs: cfg.dev_block_secs.max(1) }
    }
    fn now_height(&self) -> u32 {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
        ((now - self.genesis).max(0) / self.block_secs) as u32
    }
}

#[async_trait]
impl Chain for DevChain {
    async fn tip_height(&mut self) -> Result<u32> {
        Ok(self.now_height())
    }

    async fn new_address(&mut self, diversifier_index: u64) -> Result<String> {
        // Looks like a testnet unified address; only ever shown, never decoded.
        const CHARSET: &[u8] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
        let mut out = String::from("utest1");
        let mut x = diversifier_index.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ 0xD1B5_4A32_D192_ED03;
        for _ in 0..106 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            out.push(CHARSET[(x % 32) as usize] as char);
        }
        Ok(out)
    }

    async fn received(&mut self, addresses: &[String]) -> Result<Vec<IncomingNote>> {
        let tip = self.now_height() as i64;
        let rows = sqlx::query(
            "SELECT txid, output_index, to_address, height, amount_zats FROM dev_incoming
              WHERE to_address = ANY($1) ORDER BY height, txid",
        )
        .bind(addresses)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let h: i32 = r.get("height");
                IncomingNote {
                    to_address: r.get("to_address"),
                    txid: r.get("txid"),
                    index: r.get::<i32, _>("output_index") as u32,
                    height: h.max(0) as u32,
                    confirmations: if h > 0 && tip >= h as i64 { (tip - h as i64 + 1) as u32 } else { 0 },
                    amount_zats: r.get("amount_zats"),
                }
            })
            .collect())
    }

    async fn balance(&mut self) -> Result<Balance> {
        let r = sqlx::query(
            "SELECT (SELECT COALESCE(SUM(amount_zats),0)::bigint FROM dev_incoming) AS inc,
                    (SELECT COALESCE(SUM(amount_zats + $1),0)::bigint FROM dev_outgoing) AS out",
        )
        .bind(DEV_FEE_ZATS)
        .fetch_one(&self.pool)
        .await?;
        let total = r.get::<i64, _>("inc") - r.get::<i64, _>("out");
        Ok(Balance { total_zats: total, spendable_zats: total, transparent_zats: 0 })
    }

    async fn shield(&mut self) -> Result<Option<String>> {
        Ok(None) // the dev chain has no pools
    }

    async fn send(&mut self, to: &str, amount_zats: i64) -> std::result::Result<String, SendError> {
        let bal = self.balance().await.map_err(|e| SendError::NotBroadcast(e.to_string()))?;
        if bal.spendable_zats < amount_zats + DEV_FEE_ZATS {
            return Err(SendError::NotBroadcast("insufficient funds".into()));
        }
        let mut b = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut b);
        let txid = hex::encode(b);
        sqlx::query("INSERT INTO dev_outgoing (txid, to_address, amount_zats, height) VALUES ($1,$2,$3,$4)")
            .bind(&txid)
            .bind(to)
            .bind(amount_zats)
            .bind(self.now_height() as i32 + 1)
            .execute(&self.pool)
            .await
            .map_err(|e| SendError::NotBroadcast(e.to_string()))?;
        Ok(txid)
    }

    async fn confirmations(&mut self, txid: &str) -> Result<Option<u32>> {
        let h: Option<i32> = sqlx::query_scalar("SELECT height FROM dev_outgoing WHERE txid = $1")
            .bind(txid)
            .fetch_optional(&self.pool)
            .await?;
        let tip = self.now_height() as i64;
        Ok(h.and_then(|h| (tip - h as i64 + 1 > 0).then(|| (tip - h as i64 + 1) as u32)))
    }
}
