//! Deposit watching: keep fresh deposit addresses ready and record what they receive.
//! Shared by `zeep-watcher` (rpc/dev backends) and `zeep-wallet` (light client).
//!   unconfirmed → `deposit_sightings` (the app shows "confirming 1/3"),
//!   at least MIN_CONFIRMATIONS → `deposits` (the Node activator turns it into notes).

use crate::chain::Chain;
use crate::config::Config;
use anyhow::Result;
use redis::AsyncCommands;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use tracing::info;

pub async fn tick(cfg: &Config, pool: &PgPool, redis: &mut redis::aio::MultiplexedConnection, chain: &mut dyn Chain, hash_key: &str) -> Result<()> {
    let tip = chain.tip_height().await?;
    let _: () = redis.set(format!("{}:chain:height", cfg.ns()), tip).await?;
    sqlx::query("UPDATE wallet_state SET chain_height = $1, scanned_height = $1, updated_at = now() WHERE id = 1")
        .bind(tip as i32)
        .execute(pool)
        .await?;

    top_up_addresses(cfg, pool, chain).await?;

    // Addresses with an intent that is still waiting, or credited/expired in the last 7 days
    // (a late or second payment must still be seen and held for a claim). Open intents are
    // capped (MAX_OPEN_INTENTS) and expire unpaid, so this set stays bounded.
    let addrs: Vec<String> = sqlx::query_scalar(
        "SELECT address FROM deposit_intents WHERE status = 'open' OR expires_at > now() - interval '7 days'",
    )
    .fetch_all(pool)
    .await?;
    if addrs.is_empty() {
        return Ok(());
    }
    let notes = chain.received(&addrs).await?;
    let mut credited = 0;
    for n in notes {
        // Keyed hash, so the stored value can't be matched against public txids.
        let txid_hash = hex::encode(Sha256::digest(format!("zeep-txid-v1:{hash_key}:{}:{}", n.txid, n.index)));
        let intent: Option<String> = sqlx::query_scalar("SELECT id FROM deposit_intents WHERE address = $1")
            .bind(&n.to_address)
            .fetch_optional(pool)
            .await?;
        let Some(intent) = intent else { continue };
        if n.confirmations >= cfg.min_confirmations {
            let r = sqlx::query(
                "INSERT INTO deposits (txid_hash, intent_id, amount_zats, block_height) VALUES ($1,$2,$3,$4)
                 ON CONFLICT (txid_hash) DO NOTHING",
            )
            .bind(&txid_hash)
            .bind(&intent)
            .bind(n.amount_zats)
            .bind(n.height as i32)
            .execute(pool)
            .await?;
            credited += r.rows_affected();
        } else {
            sqlx::query(
                "INSERT INTO deposit_sightings (intent_id, txid_hash, amount_zats, confirmations) VALUES ($1,$2,$3,$4)
                 ON CONFLICT (intent_id, txid_hash) DO UPDATE SET confirmations = $4, updated_at = now()",
            )
            .bind(&intent)
            .bind(&txid_hash)
            .bind(n.amount_zats)
            .bind(n.confirmations as i32)
            .execute(pool)
            .await?;
        }
    }
    if credited > 0 {
        info!(deposits = credited, tip, "deposits confirmed");
    }
    Ok(())
}

/// Keep a pool of unused diversified addresses so a deposit intent never waits on the wallet.
async fn top_up_addresses(cfg: &Config, pool: &PgPool, chain: &mut dyn Chain) -> Result<()> {
    let row = sqlx::query(
        "SELECT (SELECT count(*) FROM deposit_addresses WHERE intent_id IS NULL) AS free,
                (SELECT COALESCE(max(diversifier_index), -1) FROM deposit_addresses) AS last",
    )
    .fetch_one(pool)
    .await?;
    let free: i64 = row.get("free");
    let first: i64 = row.get::<i64, _>("last") + 1;
    for next in first..first + (cfg.address_pool_min - free).max(0) {
        let address = chain.new_address(next as u64).await?;
        sqlx::query("INSERT INTO deposit_addresses (diversifier_index, address) VALUES ($1, $2) ON CONFLICT DO NOTHING")
            .bind(next)
            .bind(&address)
            .execute(pool)
            .await?;
    }
    Ok(())
}
