//! `watcher` process (exactly 1 dyno). View-only: it never spends.
//! Every POLL_SECS (20 s):
//!   1. keep ADDRESS_POOL_MIN fresh deposit addresses ready (one per deposit intent)
//!   2. look at every address with a live intent and record what it received:
//!      unconfirmed → `deposit_sightings` (the app shows "confirming 1/3"),
//!      at least MIN_CONFIRMATIONS → `deposits` (the Node activator turns it into a note).
//!
//! Users can deposit any amount from any wallet; no memo is needed.

use anyhow::{Context, Result};
use std::time::Duration;
use tracing::{error, info};
use zeep_chain::chain;
use zeep_chain::config::Config;
use zeep_chain::{check_network, init_tracing, lock, pg, sleep_or_shutdown};

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    let mut cfg = Config::from_env()?;
    if cfg.backend == zeep_chain::config::Backend::LightClient {
        anyhow::bail!("with CHAIN_BACKEND=lightclient run the single `wallet` process (zeep-wallet) instead");
    }
    if cfg.poll_secs == 0 {
        cfg.poll_secs = 20;
    }
    let pool = pg(&cfg.database_url).await?;
    let mut redis = lock::connect(&cfg.redis_url).await?;
    check_network(&cfg, &pool, &mut redis).await?;
    // Permanent per-database salt (meta.txid_salt), so stored hashes can't be matched to public txids.
    let hash_key: String = sqlx::query_scalar("SELECT value FROM meta WHERE key = 'txid_salt'")
        .fetch_optional(&pool)
        .await?
        .context("database has no txid_salt; run the release phase (migrate) first")?;
    let mut chain = chain::connect(&cfg, pool.clone()).await?;
    info!(backend = ?cfg.backend, network = %cfg.network, "watcher started");

    loop {
        if let Err(e) = zeep_chain::watcher::tick(&cfg, &pool, &mut redis, chain.as_mut(), &hash_key).await {
            error!(err = %e, "watcher tick failed");
        }
        if sleep_or_shutdown(Duration::from_secs(cfg.poll_secs)).await {
            break;
        }
    }
    info!("watcher stopped");
    Ok(())
}

