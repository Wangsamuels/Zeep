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

    /// Light client: lightwalletd servers to use, in order (LIGHTWALLETD_URL, comma-separated).
    pub lightwalletd_urls: Vec<String>,
    /// Light client: the reserve wallet's 24 recovery words (ZEEP_WALLET_SEED).
    pub wallet_seed: Option<String>,
    /// ZEEP_RESERVE_TADDR, checked against the seed so NEAR Intents returns ZEC to this wallet.
    pub reserve_taddr: Option<String>,

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
        let network = var("ZCASH_NETWORK").unwrap_or_else(|| "test".into());
        let mainnet = match zeep_env.as_str() {
            "mainnet" => true,
            "testnet" => false,
            other => bail!("unknown ZEEP_ENV {other}"),
        };
        if mainnet != (network == "main") || !(network == "main" || network == "test") {
            bail!("ZEEP_ENV={zeep_env} needs ZCASH_NETWORK={}", if mainnet { "main" } else { "test" });
        }
        // The dev chain on mainnet settings is only for the end-to-end tests.
        let simulation = var("ZEEP_TEST_SIMULATION").as_deref() == Some("1");
        if simulation && (var("DYNO").is_some() || var("NODE_ENV").as_deref() != Some("test")) {
            bail!("ZEEP_TEST_SIMULATION is for local tests only");
        }
        if backend == Backend::Dev && mainnet && !simulation {
            bail!("CHAIN_BACKEND=dev is not allowed with ZEEP_ENV=mainnet");
        }
        let receive_ua = var("ZEEP_RECEIVE_UA").unwrap_or_default();
        let ua_prefix = if mainnet { "u1" } else { "utest1" };
        for (name, ua) in [("ZEEP_RECEIVE_UA", Some(receive_ua.clone())), ("ZEEP_RESERVE_UA", var("ZEEP_RESERVE_UA"))] {
            if let Some(ua) = ua.filter(|u| !u.is_empty()) {
                if !ua.starts_with(ua_prefix) || (mainnet && ua.starts_with("utest1")) {
                    bail!("{name} is not a {network}net unified address");
                }
            }
        }
        Ok(Self {
            database_url: var("DATABASE_URL").unwrap_or_else(|| "postgres://localhost:5432/zeep".into()),
            redis_url: var("REDIS_URL").unwrap_or_else(|| "redis://localhost:6379".into()),
            zeep_env,
            network,
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
            lightwalletd_urls: var("LIGHTWALLETD_URL")
                .map(|v| v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
                .unwrap_or_default(),
            wallet_seed: var("ZEEP_WALLET_SEED"),
            reserve_taddr: var("ZEEP_RESERVE_TADDR"),
            wallet_rpc_url: var("WALLET_RPC_URL"),
            wallet_rpc_user: var("WALLET_RPC_USER"),
            wallet_rpc_password: var("WALLET_RPC_PASSWORD"),
            // FullPrivacy first; payouts fall back to AllowRevealedAmounts only when a send needs to
            // cross pools (e.g. to a Sapling-only address). See chain/rpc.rs send().
            wallet_privacy_policy: var("WALLET_PRIVACY_POLICY").unwrap_or_else(|| "FullPrivacy".into()),
            dev_genesis_unix: or("DEV_GENESIS_UNIX", 1_760_000_000)?,
            dev_block_secs: or("DEV_BLOCK_SECS", 75)?,
            poll_secs: or("POLL_SECS", 0)?,
        })
    }

    /// Redis namespace shared with the Node processes (`zeep:<ZEEP_ENV>`).
    pub fn ns(&self) -> String {
        format!("zeep:{}", self.zeep_env)
    }
}
