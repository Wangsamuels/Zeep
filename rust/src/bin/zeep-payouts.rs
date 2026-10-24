//! `payouts` process (exactly 1 dyno + Redis lease `zeep:lock:payouts`).
//! Every 10 s:
//!   1. report the reserve balance (alert above RESERVE_HOT_CAP_ZATS) and shield any
//!      transparent ZEC (conversions back from Tempo arrive at the reserve t-address)
//!   2. mark sent payouts confirmed; wipe a withdrawal's payout address once both tranches confirm
//!   3. flag sends whose outcome is unknown as `stuck` (never auto-retried)
//!   4. claim due payouts (FOR UPDATE SKIP LOCKED), mark them `sending` *before* broadcasting,
//!      then send from the reserve wallet and record the txid.
//!
//! The `sending`-before-broadcast ordering means a crash can only ever produce a missing
//! payment that an operator reviews, never a double payment.

use anyhow::{Context, Result};
use std::time::Duration;
use tracing::{error, info, warn};
use zeep_chain::chain;
use zeep_chain::config::Config;
use zeep_chain::lock::{self, Lease};
use zeep_chain::{check_network, init_tracing, pg, sleep_or_shutdown};


#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    let mut cfg = Config::from_env()?;
    if cfg.backend == zeep_chain::config::Backend::LightClient {
        anyhow::bail!("with CHAIN_BACKEND=lightclient run the single `wallet` process (zeep-wallet) instead");
    }
    if cfg.poll_secs == 0 {
        cfg.poll_secs = 10;
    }
    let key = cfg.payout_addr_enc_key.clone().context("PAYOUT_ADDR_ENC_KEY is required")?;
    let pool = pg(&cfg.database_url).await?;
    let mut redis = lock::connect(&cfg.redis_url).await?;
    check_network(&cfg, &pool, &mut redis).await?;
    let mut chain = chain::connect(&cfg, pool.clone()).await?;
    let lease = Lease::new(&cfg.ns(), "payouts", 60_000);
    info!(backend = ?cfg.backend, "payouts started");

    loop {
        match lease.hold(&mut redis).await {
            Ok(true) => {
                if let Err(e) = zeep_chain::payouts::tick(&cfg, &pool, chain.as_mut(), &key).await {
                    error!(err = %e, "payouts tick failed");
                }
            }
            Ok(false) => warn!("another payouts process holds the lock; standing by"),
            Err(e) => error!(err = %e, "lock check failed"),
        }
        if sleep_or_shutdown(Duration::from_secs(cfg.poll_secs)).await {
            break;
        }
    }
    let _ = lease.release(&mut redis).await;
    info!("payouts stopped");
    Ok(())
}

