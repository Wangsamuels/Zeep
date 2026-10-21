use anyhow::{bail, Result};

fn var(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.is_empty())
}
fn or<T: std::str::FromStr>(k: &str, d: T) -> Result<T> {
    match var(k) {
        Some(v) => v.parse().map_err(|_| anyhow::anyhow!("{k} is not valid")),
        None => Ok(d),
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Backend {
    /// Simulated chain backed by Postgres tables (local dev, CI, demos).
    Dev,
    /// zcashd-compatible wallet JSON-RPC (Zallet on the VPS).
    Rpc,
    /// In-dyno light client (zcash_client_backend). See chain/mod.rs.
    LightClient,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    pub redis_url: String,
    pub zeep_env: String,
    pub network: String,
    pub backend: Backend,

    pub receive_ua: String,
    pub reserve_ua: String,
    pub wallet_account: u32,
    pub birthday_height: u32,
    pub min_confirmations: u32,
    pub reserve_hot_cap_zats: i64,

    /// Free deposit addresses to keep ready (watcher).
    pub address_pool_min: i64,
    /// Shield transparent reserve funds once at least this much has arrived.
    pub shield_min_zats: i64,

    pub payout_addr_enc_key: Option<String>,

    pub wallet_rpc_url: Option<String>,
    pub wallet_rpc_user: Option<String>,
    pub wallet_rpc_password: Option<String>,
    pub wallet_privacy_policy: String,

    pub dev_genesis_unix: i64,
    pub dev_block_secs: i64,
    /// Loop interval (POLL_SECS); defaults: watcher 20 s, payouts 10 s.
    pub poll_secs: u64,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let backend = match var("CHAIN_BACKEND").as_deref().unwrap_or("dev") {
            "dev" => Backend::Dev,
            "rpc" => Backend::Rpc,
            "lightclient" => Backend::LightClient,
            other => bail!("unknown CHAIN_BACKEND {other}"),
        };
        let zeep_env = var("ZEEP_ENV").unwrap_or_else(|| "testnet".into());
        if backend == Backend::Dev && zeep_env == "mainnet" {
            bail!("CHAIN_BACKEND=dev is not allowed with ZEEP_ENV=mainnet");
        }
        let receive_ua = var("ZEEP_RECEIVE_UA").unwrap_or_default();
        Ok(Self {
            database_url: var("DATABASE_URL").unwrap_or_else(|| "postgres://localhost:5432/zeep".into()),
            redis_url: var("REDIS_URL").unwrap_or_else(|| "redis://localhost:6379".into()),
            zeep_env,
            network: var("ZCASH_NETWORK").unwrap_or_else(|| "test".into()),
            backend,
            reserve_ua: var("ZEEP_RESERVE_UA").unwrap_or_else(|| receive_ua.clone()),
            receive_ua,
            wallet_account: or("ZEEP_WALLET_ACCOUNT", 0)?,
            birthday_height: or("ZEEP_WALLET_BIRTHDAY_HEIGHT", 0)?,
            min_confirmations: or("MIN_CONFIRMATIONS", 3)?,
            reserve_hot_cap_zats: or("RESERVE_HOT_CAP_ZATS", 500_000_000)?,
            address_pool_min: or("ADDRESS_POOL_MIN", 25)?,
            shield_min_zats: or("SHIELD_MIN_ZATS", 100_000)?,
            payout_addr_enc_key: var("PAYOUT_ADDR_ENC_KEY"),
            wallet_rpc_url: var("WALLET_RPC_URL"),
            wallet_rpc_user: var("WALLET_RPC_USER"),
            wallet_rpc_password: var("WALLET_RPC_PASSWORD"),
            wallet_privacy_policy: var("WALLET_PRIVACY_POLICY").unwrap_or_else(|| "AllowRevealedAmounts".into()),
            dev_genesis_unix: or("DEV_GENESIS_UNIX", 1_760_000_000)?,
            dev_block_secs: or("DEV_BLOCK_SECS", 75)?,
            poll_secs: or("POLL_SECS", 0)?,
        })
    }

}
