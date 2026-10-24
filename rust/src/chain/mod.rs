//! The only interface the workers use to touch Zcash.
//!
//! Backends:
//! - `dev`: Postgres-backed simulation (`dev_incoming` / `dev_outgoing`), for local runs and CI.
//! - `rpc`: a zcashd-compatible wallet JSON-RPC (Zallet) on the VPS. The spending key stays
//!   on the VPS; Heroku holds only RPC credentials.
//! - `lightclient`: the reserve wallet inside the `zeep-wallet` dyno (zcash_client_backend +
//!   zcash_client_sqlite, Ironwood-ready), reading blocks from lightwalletd (e.g. zec.rocks),
//!   wallet state persisted in Postgres. See chain/lightclient.rs.

pub mod dev;
pub mod lightclient;
pub mod rpc;

use crate::config::{Backend, Config};
use anyhow::Result;
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
    /// Make sure the node/wallet is on `network` ("main" / "test").
    async fn check_network(&mut self, _network: &str) -> Result<()> {
        Ok(())
    }
    /// Catch up with the chain (light client); a no-op for node-backed wallets.
    async fn sync(&mut self) -> Result<()> {
        Ok(())
    }
    /// Save local wallet state somewhere durable (light client); a no-op otherwise.
    async fn persist(&mut self) -> Result<()> {
        Ok(())
    }
}

pub async fn connect(cfg: &Config, pool: sqlx::PgPool) -> Result<Box<dyn Chain>> {
    let mut chain: Box<dyn Chain> = match cfg.backend {
        Backend::Dev => Box::new(dev::DevChain::new(pool, cfg)),
        Backend::Rpc => Box::new(rpc::RpcChain::new(cfg)?),
        Backend::LightClient => Box::new(lightclient::LightClient::connect(cfg, pool).await?),
    };
    chain.check_network(&cfg.network).await?;
    Ok(chain)
}
