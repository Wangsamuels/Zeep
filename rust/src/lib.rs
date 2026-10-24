//! Shared code for the two Rust processes on Heroku:
//! - `zeep-watcher`: keeps a pool of fresh deposit addresses and records payments to them.
//! - `zeep-payouts`: sends withdrawal tranches and treasury sweeps from the reserve wallet.
//!
//! Both are single-dyno processes; `zeep-payouts` additionally holds a Redis lock so a
//! tranche can never be sent twice.

pub mod chain;
pub mod config;
pub mod crypto;
pub mod lock;
pub mod payouts;
pub mod watcher;

use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};
use sqlx::PgPool;
use std::str::FromStr;

pub async fn pg(url: &str) -> anyhow::Result<PgPool> {
    let mut opts = PgConnectOptions::from_str(url)?;
    // Heroku Postgres requires TLS with a certificate we cannot verify.
    if std::env::var("DYNO").is_ok() {
        opts = opts.ssl_mode(PgSslMode::Require);
    }
    Ok(PgPoolOptions::new().max_connections(4).connect_with(opts).await?)
}

/// Refuse to run against a database or Redis that belongs to the other network.
/// The Node release phase stamps the database (`meta.network`) when it migrates.
pub async fn check_network(cfg: &config::Config, pool: &PgPool, redis: &mut redis::aio::MultiplexedConnection) -> anyhow::Result<()> {
    let db: Option<String> = sqlx::query_scalar("SELECT value FROM meta WHERE key = 'network'")
        .fetch_optional(pool)
        .await
        .map_err(|e| anyhow::anyhow!("database not migrated ({e}); run the release phase first"))?;
    match db {
        Some(n) if n == cfg.zeep_env => {}
        Some(n) => anyhow::bail!("this database belongs to {n}; refusing to run {} on it", cfg.zeep_env),
        None => anyhow::bail!("database has no network stamp; run the release phase (migrate) first"),
    }
    let _: Option<String> = redis::cmd("SET").arg("zeep:network").arg(&cfg.zeep_env).arg("NX").query_async(redis).await?;
    let r: Option<String> = redis::cmd("GET").arg("zeep:network").query_async(redis).await?;
    if r.as_deref() != Some(cfg.zeep_env.as_str()) {
        anyhow::bail!("this Redis belongs to {}; refusing to run {} on it", r.unwrap_or_default(), cfg.zeep_env);
    }
    Ok(())
}

pub fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_env("LOG_LEVEL")
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(filter).json().with_current_span(false).init();
}

/// Sleep that returns early (true) on SIGTERM/SIGINT so dynos stop cleanly.
pub async fn sleep_or_shutdown(d: std::time::Duration) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(d) => false,
        _ = shutdown_signal() => true,
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal");
        tokio::select! { _ = term.recv() => {}, _ = tokio::signal::ctrl_c() => {} }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
