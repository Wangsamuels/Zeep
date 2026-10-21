//! The only interface the workers use to touch Zcash.
//!
//! Backends:
//! - `dev`: Postgres-backed simulation (`dev_incoming` / `dev_outgoing`), for local runs and CI.
//! - `rpc`: a zcashd-compatible wallet JSON-RPC (Zallet) on the VPS. The spending key stays
//!   on the VPS; Heroku holds only RPC credentials.
//! - `lightclient`: the in-dyno design from the architecture doc (zcash_client_backend +
//!   zcash_client_sqlite, wallet DB rebuilt from ZEEP_WALLET_BIRTHDAY_HEIGHT on boot, UFVK
//!   for the watcher, seed for payouts). Not implemented yet: it must be written against the
//!   Ironwood-capable librustzcash release (day-1 check #1). Implement `Chain` for it in
//!   chain/lightclient.rs; nothing else changes.

pub mod dev;
pub mod rpc;

use crate::config::{Backend, Config};
use anyhow::{bail, Result};
use async_trait::async_trait;

#[derive(Debug, Clone)]
pub struct IncomingNote {
    /// The deposit address that received it.
    pub to_address: String,
    pub txid: String,
    /// Output / action index within the transaction (a tx may pay us more than once).
    pub index: u32,
    /// 0 while unmined.
    pub height: u32,
    pub confirmations: u32,
    pub amount_zats: i64,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Balance {
    /// All pools, including unconfirmed.
    pub total_zats: i64,
    /// Shielded, confirmed: what payouts can use.
    pub spendable_zats: i64,
    /// Confirmed transparent funds waiting to be shielded.
    pub transparent_zats: i64,
}

#[derive(Debug, thiserror::Error)]
pub enum SendError {
    /// Definitely not broadcast: safe to retry.
    #[error("send rejected before broadcast: {0}")]
    NotBroadcast(String),
    /// Outcome unknown (timeout, crash): never retry automatically.
    #[error("send outcome unknown: {0}")]
    Unknown(String),
}

#[async_trait]
pub trait Chain: Send {
    async fn tip_height(&mut self) -> Result<u32>;
    /// Derive the receive account's address at a diversifier index (deposit address pool).
    async fn new_address(&mut self, diversifier_index: u64) -> Result<String>;
    /// Notes received by these deposit addresses, including unconfirmed ones
    /// (confirmations = 0). Change outputs are excluded.
    async fn received(&mut self, addresses: &[String]) -> Result<Vec<IncomingNote>>;
    async fn balance(&mut self) -> Result<Balance>;
    /// Move confirmed transparent funds into the shielded reserve; None if nothing to do.
    async fn shield(&mut self) -> Result<Option<String>>;
    /// Send from the reserve account to a shielded or transparent address; returns the txid.
    async fn send(&mut self, to: &str, amount_zats: i64) -> std::result::Result<String, SendError>;
    /// Confirmations of a transaction we sent; None if not (yet) known.
    async fn confirmations(&mut self, txid: &str) -> Result<Option<u32>>;
}

pub async fn connect(cfg: &Config, pool: sqlx::PgPool) -> Result<Box<dyn Chain>> {
    match cfg.backend {
        Backend::Dev => Ok(Box::new(dev::DevChain::new(pool, cfg))),
        Backend::Rpc => Ok(Box::new(rpc::RpcChain::new(cfg)?)),
        Backend::LightClient => bail!(
            "CHAIN_BACKEND=lightclient is not built yet: implement chain::Chain with zcash_client_backend \
             for the Ironwood release, or use CHAIN_BACKEND=rpc (Zallet on the VPS)"
        ),
    }
}
