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
use sqlx::{PgPool, Row};
use std::time::Duration;
use tracing::{error, info, warn};
use zeep_chain::chain::{self, Chain, SendError};
use zeep_chain::config::Config;
use zeep_chain::crypto::decrypt_addr;
use zeep_chain::lock::{self, Lease};
use zeep_chain::{init_tracing, pg, sleep_or_shutdown};

const MAX_ATTEMPTS: i32 = 3;

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    let mut cfg = Config::from_env()?;
    if cfg.poll_secs == 0 {
        cfg.poll_secs = 10;
    }
    let key = cfg.payout_addr_enc_key.clone().context("PAYOUT_ADDR_ENC_KEY is required")?;
    let pool = pg(&cfg.database_url).await?;
    let mut redis = lock::connect(&cfg.redis_url).await?;
    let mut chain = chain::connect(&cfg, pool.clone()).await?;
    let lease = Lease::new("payouts", 60_000);
    info!(backend = ?cfg.backend, "payouts started");

    loop {
        match lease.hold(&mut redis).await {
            Ok(true) => {
                if let Err(e) = tick(&cfg, &pool, chain.as_mut(), &key).await {
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

async fn tick(cfg: &Config, pool: &PgPool, chain: &mut dyn Chain, key: &str) -> Result<()> {
    // 1. balance
    let bal = chain.balance().await?;
    sqlx::query("UPDATE wallet_state SET reserve_balance_zats = $1, reserve_spendable_zats = $2, updated_at = now() WHERE id = 1")
        .bind(bal.total_zats)
        .bind(bal.spendable_zats)
        .execute(pool)
        .await?;
    if bal.total_zats > cfg.reserve_hot_cap_zats {
        warn!(balance = bal.total_zats, cap = cfg.reserve_hot_cap_zats, "hot reserve above cap; sweep excess to cold storage");
    }
    // ZEC coming back from NEAR Intents lands on the reserve's transparent address: shield it.
    if bal.transparent_zats >= cfg.shield_min_zats {
        match chain.shield().await {
            Ok(Some(txid)) => info!(zats = bal.transparent_zats, txid = %txid, "shielded transparent funds into the reserve"),
            Ok(None) => {}
            Err(e) => warn!(err = %e, "shielding failed; will retry"),
        }
    }

    // 2. confirmations
    let sent = sqlx::query("SELECT id, txid, withdrawal_id::text AS withdrawal_id FROM payouts WHERE status = 'sent'").fetch_all(pool).await?;
    for r in sent {
        let id: i64 = r.get("id");
        let txid: String = r.get("txid");
        if chain.confirmations(&txid).await?.unwrap_or(0) >= 1 {
            sqlx::query("UPDATE payouts SET status = 'confirmed', confirmed_at = now() WHERE id = $1").bind(id).execute(pool).await?;
            if let Some(wid) = r.get::<Option<String>, _>("withdrawal_id") {
                sqlx::query(
                    "UPDATE withdrawals SET status = 'done', payout_addr_enc = NULL WHERE id = $1::uuid
                       AND NOT EXISTS (SELECT 1 FROM payouts WHERE withdrawal_id = $1::uuid AND status <> 'confirmed')",
                )
                .bind(&wid)
                .execute(pool)
                .await?;
            }
        }
    }

    // 3. unknown outcomes
    let stuck = sqlx::query(
        "UPDATE payouts SET status = 'stuck', last_error = 'send outcome unknown; check the wallet before retrying'
          WHERE status = 'sending' AND sent_at < now() - interval '10 minutes' RETURNING id",
    )
    .fetch_all(pool)
    .await?;
    if !stuck.is_empty() {
        error!(count = stuck.len(), "payouts stuck; manual review needed");
    }

    // 4. claim and send
    let mut tx = pool.begin().await?;
    let due = sqlx::query(
        "SELECT p.id, p.kind, p.amount_zats, p.dest_address, p.attempts, r.payout_addr_enc, p.withdrawal_id::text AS withdrawal_id
           FROM payouts p LEFT JOIN withdrawals r ON r.id = p.withdrawal_id
          WHERE p.status = 'scheduled' AND p.scheduled_at <= now()
          ORDER BY p.scheduled_at LIMIT 5 FOR UPDATE OF p SKIP LOCKED",
    )
    .fetch_all(&mut *tx)
    .await?;
    for r in &due {
        sqlx::query("UPDATE payouts SET status = 'sending', attempts = attempts + 1, sent_at = now() WHERE id = $1")
            .bind(r.get::<i64, _>("id"))
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;

    let mut spendable = bal.spendable_zats;
    for r in due {
        let id: i64 = r.get("id");
        let kind: String = r.get("kind");
        let amount: i64 = r.get("amount_zats");
        let attempts: i32 = r.get::<i32, _>("attempts") + 1;

        if spendable < amount {
            // Funds still confirming: try again in 2 minutes. This is not an attempt.
            sqlx::query("UPDATE payouts SET status = 'scheduled', attempts = attempts - 1, scheduled_at = now() + interval '2 minutes', last_error = 'waiting for spendable funds' WHERE id = $1")
                .bind(id)
                .execute(pool)
                .await?;
            warn!(payout = id, "not enough spendable balance yet");
            continue;
        }

        let to = if kind == "withdrawal" {
            match r.get::<Option<String>, _>("payout_addr_enc").map(|enc| decrypt_addr(key, &enc)) {
                Some(Ok(a)) => a,
                other => {
                    let msg = match other { Some(Err(e)) => e.to_string(), _ => "payout address missing".into() };
                    fail(pool, id, &msg).await?;
                    continue;
                }
            }
        } else {
            r.get::<Option<String>, _>("dest_address").unwrap_or_default()
        };

        if let Some(wid) = r.get::<Option<String>, _>("withdrawal_id") {
            sqlx::query("UPDATE withdrawals SET status = 'paying' WHERE id = $1::uuid AND status = 'scheduled'").bind(&wid).execute(pool).await?;
        }

        match chain.send(&to, amount).await {
            Ok(txid) => {
                spendable -= amount;
                let mut tx = pool.begin().await?;
                sqlx::query("UPDATE payouts SET status = 'sent', txid = $2, sent_at = now(), last_error = NULL WHERE id = $1")
                    .bind(id)
                    .bind(&txid)
                    .execute(&mut *tx)
                    .await?;
                // Withdrawals are booked when requested; conversions by the treasury.
                tx.commit().await?;
                info!(payout = id, kind = %kind, "sent");
            }
            Err(SendError::NotBroadcast(e)) if attempts < MAX_ATTEMPTS => {
                sqlx::query("UPDATE payouts SET status = 'scheduled', scheduled_at = now() + interval '1 minute', last_error = $2 WHERE id = $1")
                    .bind(id)
                    .bind(&e)
                    .execute(pool)
                    .await?;
                warn!(payout = id, err = %e, "send failed before broadcast; will retry");
            }
            Err(SendError::NotBroadcast(e)) => fail(pool, id, &e).await?,
            Err(SendError::Unknown(e)) => {
                sqlx::query("UPDATE payouts SET status = 'stuck', last_error = $2 WHERE id = $1").bind(id).bind(&e).execute(pool).await?;
                error!(payout = id, err = %e, "send outcome unknown; marked stuck");
            }
        }
    }
    Ok(())
}

async fn fail(pool: &PgPool, id: i64, msg: &str) -> Result<()> {
    sqlx::query("UPDATE payouts SET status = 'failed', last_error = $2 WHERE id = $1").bind(id).bind(msg).execute(pool).await?;
    error!(payout = id, err = %msg, "payout failed; manual review needed");
    Ok(())
}
