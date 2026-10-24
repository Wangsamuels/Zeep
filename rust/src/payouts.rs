//! Payouts: reserve balance, shielding, confirmations, stuck detection, and sending due payouts.
//! Shared by `zeep-payouts` (rpc/dev backends) and `zeep-wallet` (light client).
//!
//! The `sending`-before-broadcast ordering means a crash can only ever produce a missing
//! payment that an operator reviews, never a double payment.

use crate::chain::{Chain, SendError};
use crate::config::Config;
use crate::crypto::decrypt_addr;
use anyhow::Result;
use sqlx::{PgPool, Row};
use tracing::{error, info, warn};

const MAX_ATTEMPTS: i32 = 3;

pub async fn tick(cfg: &Config, pool: &PgPool, chain: &mut dyn Chain, key: &str) -> Result<()> {
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

    // 2. confirmations (one bad lookup never blocks the rest, or new sends)
    let sent = sqlx::query(
        "SELECT id, txid, status, withdrawal_id::text AS withdrawal_id, sent_at < now() - interval '2 hours' AS old
           FROM payouts WHERE status = 'sent' OR (status = 'stuck' AND txid IS NOT NULL)",
    )
    .fetch_all(pool)
    .await?;
    for r in sent {
        let id: i64 = r.get("id");
        let txid: String = r.get("txid");
        let confs = match chain.confirmations(&txid).await {
            Ok(c) => c.unwrap_or(0),
            Err(e) => {
                // An RPC outage is not "unconfirmed": skip and look again next tick.
                warn!(payout = id, err = %e, "confirmation lookup failed; will retry");
                continue;
            }
        };
        let status: String = r.get("status");
        if confs == 0 && status == "sent" && r.get::<bool, _>("old") {
            // Never mined (expired or dropped): it must be checked by hand before any resend.
            sqlx::query("UPDATE payouts SET status = 'stuck', last_error = 'sent 2h ago and still unconfirmed; check the wallet' WHERE id = $1")
                .bind(id)
                .execute(pool)
                .await?;
            error!(payout = id, "payout unconfirmed after 2 hours; marked stuck for review");
            continue;
        }
        if confs >= 1 {
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
