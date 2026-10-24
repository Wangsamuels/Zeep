//! `wallet` process (exactly 1 dyno, Standard-2X) for CHAIN_BACKEND=lightclient: one
//! Zcash wallet does both jobs, so there is a single writer of the wallet state.
//! Every POLL_SECS (15 s):
//!   1. sync the wallet with the chain (lightwalletd, with failover)
//!   2. deposits: keep fresh deposit addresses ready and record what they receive
//!   3. payouts: balance, shielding, confirmations, stuck detection, sending due payouts
//!   4. save the wallet to Postgres if it changed
//!
//! Commands:
//!   zeep-wallet            run the loop (Heroku `wallet` dyno)
//!   zeep-wallet init       create a NEW reserve seed and print what to put in config vars
//!   zeep-wallet address    print the addresses for the ZEEP_WALLET_SEED already set

use anyhow::{Context, Result};
use secrecy::ExposeSecret;
use std::time::Duration;
use tracing::{error, info, warn};
use zcash_client_backend::proto::service;
use zcash_keys::keys::UnifiedSpendingKey;
use zeep_chain::chain::{self, lightclient};
use zeep_chain::config::{Backend, Config};
use zeep_chain::lock::{self, Lease};
use zeep_chain::{check_network, init_tracing, pg, sleep_or_shutdown};

#[tokio::main]
async fn main() -> Result<()> {
    let cmd = std::env::args().nth(1).unwrap_or_default();
    match cmd.as_str() {
        "init" => return init().await,
        "address" => return address(),
        "" | "run" => {}
        other => anyhow::bail!("unknown command {other}; use init, address or run"),
    }

    init_tracing();
    let mut cfg = Config::from_env()?;
    if cfg.poll_secs == 0 {
        cfg.poll_secs = 15;
    }
    if cfg.backend != Backend::LightClient {
        warn!("zeep-wallet is meant for CHAIN_BACKEND=lightclient; running with {:?}", cfg.backend);
    }
    let pay_key = cfg.payout_addr_enc_key.clone().context("PAYOUT_ADDR_ENC_KEY is required")?;
    let pool = pg(&cfg.database_url).await?;
    let mut redis = lock::connect(&cfg.redis_url).await?;
    check_network(&cfg, &pool, &mut redis).await?;
    let hash_key: String = sqlx::query_scalar("SELECT value FROM meta WHERE key = 'txid_salt'")
        .fetch_optional(&pool)
        .await?
        .context("database has no txid_salt; run the release phase (migrate) first")?;

    // One wallet process at a time, or two would write the same wallet.
    let lease = Lease::new(&cfg.ns(), "wallet", 120_000);
    while !lease.hold(&mut redis).await? {
        warn!("another wallet process is running; standing by");
        if sleep_or_shutdown(Duration::from_secs(30)).await {
            return Ok(());
        }
    }
    let mut chain = match chain::connect(&cfg, pool.clone()).await {
        Ok(c) => c,
        Err(e) => {
            // Don't make the next start wait for the lease to expire.
            let _ = lease.release(&mut redis).await;
            return Err(e);
        }
    };
    info!(network = %cfg.network, "wallet started");

    loop {
        match lease.hold(&mut redis).await {
            Ok(true) => {
                if let Err(e) = chain.sync().await {
                    error!(err = %e, "wallet sync failed; will retry");
                }
                if let Err(e) = zeep_chain::watcher::tick(&cfg, &pool, &mut redis, chain.as_mut(), &hash_key).await {
                    error!(err = %e, "deposit tick failed");
                }
                if let Err(e) = zeep_chain::payouts::tick(&cfg, &pool, chain.as_mut(), &pay_key).await {
                    error!(err = %e, "payouts tick failed");
                }
                if let Err(e) = chain.persist().await {
                    error!(err = %e, "ALERT could not save the wallet to Postgres");
                }
            }
            Ok(false) => {
                // Lost the lease (e.g. a long pause): stop rather than risk two writers.
                error!("lost the wallet lease to another process; exiting");
                let _ = chain.persist().await;
                return Ok(());
            }
            Err(e) => error!(err = %e, "lease check failed"),
        }
        if sleep_or_shutdown(Duration::from_secs(cfg.poll_secs)).await {
            break;
        }
    }
    let _ = chain.persist().await;
    let _ = lease.release(&mut redis).await;
    info!("wallet stopped");
    Ok(())
}

fn params_from_env() -> Result<zcash_protocol::consensus::Network> {
    lightclient::network_params(&std::env::var("ZCASH_NETWORK").unwrap_or_else(|_| "test".into()))
}

/// Create a new reserve seed. Prints secrets: run it on your own machine, or in a one-off
/// `heroku run` (the output isn't stored), and write the words down offline.
async fn init() -> Result<()> {
    let params = params_from_env()?;
    let urls = std::env::var("LIGHTWALLETD_URL").context("set LIGHTWALLETD_URL (e.g. https://testnet.zec.rocks:443)")?;
    let url = urls.split(',').next().unwrap().trim().to_string();
    let mut client = lightclient::connect_lightwalletd(&url).await?;
    let info = client.get_lightd_info(service::Empty {}).await?.into_inner();
    let net = std::env::var("ZCASH_NETWORK").unwrap_or_else(|_| "test".into());
    if info.chain_name != net {
        anyhow::bail!("{url} is on {}net but ZCASH_NETWORK={net}", info.chain_name);
    }
    let tip = client.get_latest_block(service::ChainSpec::default()).await?.into_inner().height as u32;
    let birthday = tip.saturating_sub(100);
    let mnemonic = bip0039::Mnemonic::<bip0039::English>::generate(bip0039::Count::Words24);
    let seed = mnemonic.to_seed("");
    let usk = UnifiedSpendingKey::from_seed(&params, &seed, zip32::AccountId::ZERO).map_err(|e| anyhow::anyhow!("{e:?}"))?;
    let (ua, taddr, _ufvk) = lightclient::reserve_addresses(&params, &usk)?;
    println!("NEW {}NET RESERVE WALLET — write the 24 words down offline; anyone with them controls the reserve.\n", net.to_uppercase());
    println!("ZEEP_WALLET_SEED={}", mnemonic.phrase());
    println!("ZEEP_WALLET_BIRTHDAY_HEIGHT={birthday}");
    println!("ZEEP_RECEIVE_UA={ua}");
    println!("ZEEP_RESERVE_TADDR={taddr}");
    Ok(())
}

/// Print the public addresses for the seed in ZEEP_WALLET_SEED (no secrets printed).
fn address() -> Result<()> {
    let params = params_from_env()?;
    let words = std::env::var("ZEEP_WALLET_SEED").context("set ZEEP_WALLET_SEED")?;
    let seed = lightclient::seed_from_words(&words)?;
    let account = std::env::var("ZEEP_WALLET_ACCOUNT").ok().and_then(|v| v.parse().ok()).unwrap_or(0u32);
    let usk = UnifiedSpendingKey::from_seed(&params, seed.expose_secret(), zip32::AccountId::try_from(account).unwrap())
        .map_err(|e| anyhow::anyhow!("{e:?}"))?;
    let (ua, taddr, _) = lightclient::reserve_addresses(&params, &usk)?;
    println!("ZEEP_RECEIVE_UA={ua}");
    println!("ZEEP_RESERVE_TADDR={taddr}");
    Ok(())
}
