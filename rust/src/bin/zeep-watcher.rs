//! `watcher` process (exactly 1 dyno). View-only: it never spends.
//! Every POLL_SECS (20 s):
//!   1. keep ADDRESS_POOL_MIN fresh deposit addresses ready (one per deposit intent)
//!   2. look at every address with a live intent and record what it received:
//!      unconfirmed → `deposit_sightings` (the app shows "confirming 1/3"),
//!      at least MIN_CONFIRMATIONS → `deposits` (the Node activator turns it into a note).
//!
//! Users can deposit any amount from any wallet; no memo is needed.

use anyhow::Result;
use redis::AsyncCommands;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use std::time::Duration;
use tracing::{error, info};
use zeep_chain::chain::{self, Chain};
use zeep_chain::config::Config;
use zeep_chain::{init_tracing, lock, pg, sleep_or_shutdown};

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    let mut cfg = Config::from_env()?;
    if cfg.poll_secs == 0 {
        cfg.poll_secs = 20;
    }
    let pool = pg(&cfg.database_url).await?;
    let mut redis = lock::connect(&cfg.redis_url).await?;
    let mut chain = chain::connect(&cfg, pool.clone()).await?;
    info!(backend = ?cfg.backend, network = %cfg.network, "watcher started");

    loop {
        if let Err(e) = tick(&cfg, &pool, &mut redis, chain.as_mut()).await {
            error!(err = %e, "watcher tick failed");
        }
        if sleep_or_shutdown(Duration::from_secs(cfg.poll_secs)).await {
            break;
        }
    }
    info!("watcher stopped");
    Ok(())
}

async fn tick(cfg: &Config, pool: &PgPool, redis: &mut redis::aio::MultiplexedConnection, chain: &mut dyn Chain) -> Result<()> {
    let tip = chain.tip_height().await?;
    let _: () = redis.set("zeep:chain:height", tip).await?;
    sqlx::query("UPDATE wallet_state SET chain_height = $1, scanned_height = $1, updated_at = now() WHERE id = 1")
        .bind(tip as i32)
        .execute(pool)
        .await?;

    top_up_addresses(cfg, pool, chain).await?;

    // Addresses with an intent that is still waiting, or credited/expired recently
    // (a late or second payment must still be seen and held for a claim).
    let addrs: Vec<String> = sqlx::query_scalar(
        "SELECT address FROM deposit_intents WHERE status = 'open' OR created_at > now() - interval '30 days'",
    )
    .fetch_all(pool)
    .await?;
    if addrs.is_empty() {
        return Ok(());
    }
    let notes = chain.received(&addrs).await?;
    let mut credited = 0;
    for n in notes {
        let txid_hash = hex::encode(Sha256::digest(format!("{}:{}", n.txid, n.index)));
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
