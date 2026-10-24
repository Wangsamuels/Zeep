//! Light client backend (CHAIN_BACKEND=lightclient): the reserve wallet runs inside the
//! `wallet` dyno, built on the official Zcash wallet crates (zcash_client_backend +
//! zcash_client_sqlite, Ironwood-ready). Blocks come from lightwalletd servers
//! (LIGHTWALLETD_URL, a comma-separated failover list, e.g. zec.rocks).
//!
//! Persistence: the wallet is a SQLite file on the dyno's scratch disk. It is restored from
//! Postgres (`wallet_store`) on boot and saved back after every sync that changed it and
//! before every broadcast. A restart therefore resumes where it stopped; if the copy were
//! ever lost, the wallet rebuilds itself from ZEEP_WALLET_SEED + the chain.
//!
//! Addresses: diversifier index 0 is the reserve's own address (its transparent receiver is
//! ZEEP_RESERVE_TADDR, where NEAR Intents returns ZEC). Deposit address n uses index
//! DEPOSIT_INDEX_BASE + n, shielded receivers only, far from the low indexes the wallet uses
//! for its own transparent addresses. Deposits are matched by diversifier index, which a
//! rebuild from the seed always reproduces. Ironwood shares the Orchard receiver, so one unified address
//! receives in Sapling, Orchard or Ironwood, and the wallet scans all three pools.

use super::{Balance, Chain, IncomingNote, SendError};
use crate::config::Config;
use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use rand10::rand_core::UnwrapErr;
use rand10::rngs::SysRng;
use secrecy::{ExposeSecret, SecretVec};
use sqlx::PgPool;
use std::collections::HashMap;
use std::num::{NonZeroU32, NonZeroUsize};
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tonic::transport::{Channel, ClientTlsConfig};
use tracing::{error, info, warn};
use transparent::address::TransparentAddress;
use zcash_address::ZcashAddress;
use zcash_client_backend::data_api::chain::{error as chain_error, BlockCache, BlockSource};
use zcash_client_backend::data_api::scanning::ScanRange;
use zcash_client_backend::data_api::wallet::input_selection::{GreedyInputSelector, SpendPolicy};
use zcash_client_backend::data_api::wallet::{
    create_proposed_transactions, propose_shielding, propose_transfer, ConfirmationsPolicy, SpendingKeys,
};
use zcash_client_backend::data_api::{Account as _, AccountBirthday, CoinbaseFilter, WalletRead, WalletWrite};
use zcash_client_backend::fees::standard::MultiOutputChangeStrategy;
use zcash_client_backend::fees::{DustOutputPolicy, SplitPolicy, StandardFeeRule};
use zcash_client_backend::proto::compact_formats::CompactBlock;
use zcash_client_backend::proto::service::{self, compact_tx_streamer_client::CompactTxStreamerClient};
use zcash_client_backend::wallet::OvkPolicy;
use zcash_client_sqlite::util::SystemClock;
use zcash_client_sqlite::wallet::init::init_wallet_db;
use zcash_client_sqlite::{AccountUuid, WalletDb};
use zcash_keys::address::UnifiedAddress;
use zcash_keys::encoding::AddressCodec;
use zcash_keys::keys::{UnifiedAddressRequest, UnifiedSpendingKey};
use zcash_primitives::transaction::TxId;
use zcash_proofs::prover::LocalTxProver;
use zcash_protocol::consensus::{BlockHeight, Network, NetworkUpgrade, Parameters};
use zcash_protocol::value::Zatoshis;
use zcash_protocol::ShieldedPool;
use zip32::DiversifierIndex;
use zip321::{Payment, TransactionRequest};

type Db = WalletDb<rusqlite::Connection, Network, SystemClock, UnwrapErr<SysRng>>;

/// Ask for a fresh block from the server at most this often while idle.
const SYNC_BATCH: u32 = 1_000;
/// Save the wallet to Postgres at least this often even if nothing changed.
const PERSIST_EVERY: Duration = Duration::from_secs(600);
/// Alert (and switch server) if the server's tip hasn't moved for this long (~16 blocks).
const STALL_AFTER: Duration = Duration::from_secs(20 * 60);
/// Deposit address n lives at diversifier index DEPOSIT_INDEX_BASE + n. Never change this.
pub const DEPOSIT_INDEX_BASE: u64 = 1 << 24;

pub fn network_params(network: &str) -> Result<Network> {
    match network {
        "main" => Ok(Network::MainNetwork),
        "test" => Ok(Network::TestNetwork),
        other => bail!("unknown ZCASH_NETWORK {other}"),
    }
}

/// The 24 recovery words → 64-byte seed.
pub fn seed_from_words(words: &str) -> Result<SecretVec<u8>> {
    let m = bip0039::Mnemonic::<bip0039::English>::from_phrase(words.trim())
        .map_err(|_| anyhow!("ZEEP_WALLET_SEED is not a valid 24-word recovery phrase"))?;
    Ok(SecretVec::new(m.to_seed("").to_vec()))
}

/// The reserve's own unified address (diversifier 0, all receivers) and its transparent receiver.
pub fn reserve_addresses(params: &Network, usk: &UnifiedSpendingKey) -> Result<(String, String, String)> {
    let ufvk = usk.to_unified_full_viewing_key();
    let ua = ufvk
        .address(DiversifierIndex::from(0u32), UnifiedAddressRequest::ALLOW_ALL)
        .map_err(|e| anyhow!("deriving the reserve address: {e:?}"))?;
    let taddr = ua.transparent().ok_or_else(|| anyhow!("reserve address has no transparent receiver"))?;
    let ufvk_s = ufvk.encode(params).map_err(|e| anyhow!("encoding the viewing key: {e:?}"))?;
    Ok((ua.encode(params), taddr.encode(params), ufvk_s))
}

pub async fn connect_lightwalletd(url: &str) -> Result<CompactTxStreamerClient<Channel>> {
    let uri: tonic::transport::Uri = url.parse().with_context(|| format!("bad LIGHTWALLETD_URL entry {url}"))?;
    let host = uri.host().ok_or_else(|| anyhow!("LIGHTWALLETD_URL entry {url} has no host"))?.to_string();
    let mut ch = Channel::from_shared(url.to_string())?
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120));
    if uri.scheme_str() == Some("https") {
        let mut tls = ClientTlsConfig::new().domain_name(host).assume_http2(true).with_webpki_roots();
        // Only for networks that intercept TLS with their own CA (e.g. a corporate proxy or a
        // test sandbox). Not needed on Heroku.
        if let Ok(path) = std::env::var("LIGHTWALLETD_EXTRA_CA_FILE") {
            let pem = std::fs::read(&path).with_context(|| format!("reading LIGHTWALLETD_EXTRA_CA_FILE {path}"))?;
            tls = tls.ca_certificate(tonic::transport::Certificate::from_pem(pem));
        }
        ch = ch.tls_config(tls)?;
    }
    Ok(CompactTxStreamerClient::new(ch.connect().await?)
        .max_decoding_message_size(64 * 1024 * 1024))
}

/// In-memory compact block cache: blocks live only between download and scan.
#[derive(Clone, Default)]
struct MemCache(Arc<Mutex<Vec<CompactBlock>>>);

impl BlockSource for MemCache {
    type Error = std::convert::Infallible;
    fn with_blocks<F, WalletErrT>(
        &self,
        from_height: Option<BlockHeight>,
        limit: Option<usize>,
        mut with_block: F,
    ) -> Result<(), chain_error::Error<WalletErrT, Self::Error>>
    where
        F: FnMut(CompactBlock) -> Result<(), chain_error::Error<WalletErrT, Self::Error>>,
    {
        let mut blocks: Vec<CompactBlock> = self
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|b| from_height.is_none_or(|h| BlockHeight::from_u32(b.height as u32) >= h))
            .cloned()
            .collect();
        blocks.sort_by_key(|b| b.height);
        for b in blocks.into_iter().take(limit.unwrap_or(usize::MAX)) {
            with_block(b)?;
        }
        Ok(())
    }
}

#[async_trait]
impl BlockCache for MemCache {
    fn get_tip_height(&self, range: Option<&ScanRange>) -> Result<Option<BlockHeight>, Self::Error> {
        let g = self.0.lock().unwrap();
        Ok(g.iter()
            .map(|b| BlockHeight::from_u32(b.height as u32))
            .filter(|h| range.is_none_or(|r| r.block_range().contains(h)))
            .max())
    }
    async fn read(&self, range: &ScanRange) -> Result<Vec<CompactBlock>, Self::Error> {
        let mut v: Vec<CompactBlock> = self
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|b| range.block_range().contains(&BlockHeight::from_u32(b.height as u32)))
            .cloned()
            .collect();
        v.sort_by_key(|b| b.height);
        Ok(v)
    }
    async fn insert(&self, mut blocks: Vec<CompactBlock>) -> Result<(), Self::Error> {
        self.0.lock().unwrap().append(&mut blocks);
        Ok(())
    }
    async fn delete(&self, range: ScanRange) -> Result<(), Self::Error> {
        self.0
            .lock()
            .unwrap()
            .retain(|b| !range.block_range().contains(&BlockHeight::from_u32(b.height as u32)));
        Ok(())
    }
}

pub struct LightClient {
    params: Network,
    zeep_env: String,
    db: Db,
    db_path: PathBuf,
    pool: PgPool,
    urls: Vec<String>,
    current: usize,
    client: Option<CompactTxStreamerClient<Channel>>,
    cache: MemCache,
    account: AccountUuid,
    usk: UnifiedSpendingKey,
    reserve_taddr: TransparentAddress,
    min_conf: u32,
    tip: Option<(u32, Instant)>,
    dirty: bool,
    last_persist: Instant,
}

impl LightClient {
    pub async fn connect(cfg: &Config, pool: PgPool) -> Result<Self> {
        let params = network_params(&cfg.network)?;
        let urls: Vec<String> = cfg.lightwalletd_urls.clone();
        if urls.is_empty() {
            bail!("LIGHTWALLETD_URL is required for CHAIN_BACKEND=lightclient (e.g. https://zec.rocks:443)");
        }
        let words = cfg.wallet_seed.clone().context("ZEEP_WALLET_SEED (24 words) is required for CHAIN_BACKEND=lightclient")?;
        let seed = seed_from_words(&words)?;
        let account_index = zip32::AccountId::try_from(cfg.wallet_account).map_err(|_| anyhow!("bad ZEEP_WALLET_ACCOUNT"))?;
        let usk = UnifiedSpendingKey::from_seed(&params, seed.expose_secret(), account_index)
            .map_err(|e| anyhow!("deriving keys from ZEEP_WALLET_SEED: {e:?}"))?;
        let (_, taddr_str, _) = reserve_addresses(&params, &usk)?;
        if let Some(expect) = &cfg.reserve_taddr {
            if expect != &taddr_str {
                bail!("ZEEP_RESERVE_TADDR does not belong to ZEEP_WALLET_SEED (expected {taddr_str}); NEAR Intents would return ZEC elsewhere");
            }
        }
        let reserve_taddr = TransparentAddress::decode(&params, &taddr_str).map_err(|e| anyhow!("{e:?}"))?;

        // Restore the wallet file from Postgres (or start a fresh one).
        let db_path = std::env::temp_dir().join(format!("zeep-wallet-{}.sqlite", cfg.zeep_env));
        let _ = std::fs::remove_file(&db_path);
        let saved: Option<Vec<u8>> = sqlx::query_scalar("SELECT data FROM wallet_store WHERE network = $1")
            .bind(&cfg.zeep_env)
            .fetch_optional(&pool)
            .await
            .context("reading wallet_store (run the release phase / migrations first)")?;
        let restored = saved.is_some();
        if let Some(bytes) = &saved {
            std::fs::write(&db_path, bytes)?;
            info!(bytes = bytes.len(), "wallet restored from Postgres");
        }
        let mut db: Db = WalletDb::for_path(&db_path, params, SystemClock, UnwrapErr(SysRng))?;
        init_wallet_db(&mut db, Some(SecretVec::new(seed.expose_secret().clone())))
            .map_err(|e| anyhow!("initialising the wallet database: {e:?}"))?;

        let mut me = Self {
            params,
            zeep_env: cfg.zeep_env.clone(),
            db,
            db_path,
            pool,
            urls,
            current: 0,
            client: None,
            cache: MemCache::default(),
            account: AccountUuid::from_uuid(uuid::Uuid::nil()),
            usk,
            reserve_taddr,
            min_conf: cfg.min_confirmations.max(1),
            tip: None,
            dirty: !restored,
            last_persist: Instant::now(),
        };

        // The account for this seed: found in the restored file, or imported at its birthday.
        let ufvk = me.usk.to_unified_full_viewing_key();
        me.account = match me.db.get_account_for_ufvk(&ufvk)? {
            Some(a) => a.id(),
            None => {
                if cfg.birthday_height == 0 {
                    bail!("ZEEP_WALLET_BIRTHDAY_HEIGHT is required (run `zeep-wallet init` to get one)");
                }
                let birthday = me.birthday(BlockHeight::from_u32(cfg.birthday_height)).await?;
                let (acct, _) = me
                    .db
                    .import_account_hd("zeep-reserve", &seed, account_index, &birthday, Some("ZEEP_WALLET_SEED"))
                    .map_err(|e| anyhow!("importing the reserve account: {e:?}"))?;
                info!(birthday = cfg.birthday_height, "reserve account imported; first sync scans from the birthday");
                me.dirty = true;
                acct.id()
            }
        };
        // Make sure the reserve's own address (and its transparent receiver) is tracked.
        let _ = me
            .db
            .get_address_for_index(me.account, DiversifierIndex::from(0u32), UnifiedAddressRequest::ALLOW_ALL)
            .map_err(|e| anyhow!("{e:?}"))?;
        Ok(me)
    }

    async fn birthday(&mut self, height: BlockHeight) -> Result<AccountBirthday> {
        let sapling = self.params.activation_height(NetworkUpgrade::Sapling).expect("sapling active");
        let height = height.max(sapling + 1);
        let req = service::BlockId { height: u64::from(height - 1), ..Default::default() };
        let ts = self.client().await?.get_tree_state(req).await?.into_inner();
        AccountBirthday::from_treestate(ts, None).map_err(|_| anyhow!("bad tree state from lightwalletd"))
    }

    /// The current server, connecting (and failing over) as needed.
    async fn client(&mut self) -> Result<&mut CompactTxStreamerClient<Channel>> {
        if self.client.is_none() {
            let mut last = None;
            for i in 0..self.urls.len() {
                let idx = (self.current + i) % self.urls.len();
                match connect_lightwalletd(&self.urls[idx]).await {
                    Ok(c) => {
                        self.current = idx;
                        self.client = Some(c);
                        info!(server = %self.urls[idx], "connected to lightwalletd");
                        break;
                    }
                    Err(e) => {
                        warn!(server = %self.urls[idx], err = %e, "lightwalletd unreachable; trying the next");
                        last = Some(e);
                    }
                }
            }
            if self.client.is_none() {
                return Err(last.unwrap_or_else(|| anyhow!("no lightwalletd server")));
            }
        }
        Ok(self.client.as_mut().unwrap())
    }

    /// Drop the current connection and move to the next server.
    fn fail_over(&mut self, why: &str) {
        if self.urls.len() > 1 {
            warn!(server = %self.urls[self.current], why, "switching lightwalletd server");
        }
        self.client = None;
        self.current = (self.current + 1) % self.urls.len();
    }

    fn confirmations_policy(&self) -> ConfirmationsPolicy {
        let n = NonZeroU32::new(self.min_conf).unwrap_or(NonZeroU32::MIN);
        ConfirmationsPolicy::new_symmetrical(n, true)
    }

    /// From NU6.3 (Ironwood) value can't flow into Orchard, so new outputs and change go to Ironwood.
    fn output_pool(&self) -> ShieldedPool {
        let next = self.db.chain_height().ok().flatten().map(|h| h + 1);
        match (self.params.activation_height(NetworkUpgrade::Nu6_3), next) {
            (Some(a), Some(h)) if h >= a => ShieldedPool::Ironwood,
            _ => ShieldedPool::Orchard,
        }
    }

    fn change_strategy(&self) -> MultiOutputChangeStrategy<Db> {
        MultiOutputChangeStrategy::new(
            StandardFeeRule::Zip317,
            None,
            self.output_pool(),
            DustOutputPolicy::default(),
            // Keep a few notes around so payouts don't wait on change from the previous one.
            SplitPolicy::with_min_output_value(NonZeroUsize::new(4).unwrap(), Zatoshis::const_from_u64(10_000_000)),
        )
    }

    /// Store, persist (before broadcast), then broadcast one created transaction.
    async fn broadcast(&mut self, txid: TxId) -> std::result::Result<String, SendError> {
        let tx = self
            .db
            .get_transaction(txid)
            .map_err(|e| SendError::NotBroadcast(format!("{e:?}")))?
            .ok_or_else(|| SendError::NotBroadcast("created transaction not found".into()))?;
        let mut raw = service::RawTransaction::default();
        tx.write(&mut raw.data).map_err(|e| SendError::NotBroadcast(e.to_string()))?;
        // The wallet must remember this spend even if the dyno dies right after broadcasting.
        self.dirty = true;
        if let Err(e) = self.persist().await {
            return Err(SendError::NotBroadcast(format!("could not save the wallet before broadcasting: {e}")));
        }
        let client = self.client().await.map_err(|e| SendError::NotBroadcast(e.to_string()))?;
        match client.send_transaction(raw).await {
            Ok(r) => {
                let r = r.into_inner();
                if r.error_code != 0 {
                    // Rejected by the node: definitely not in the mempool.
                    return Err(SendError::NotBroadcast(format!("node rejected the transaction: {} {}", r.error_code, r.error_message)));
                }
                Ok(txid.to_string())
            }
            // The request may or may not have reached the node.
            Err(e) => {
                self.fail_over("send failed");
                Err(SendError::Unknown(format!("broadcast outcome unknown ({e}); txid {txid}")))
            }
        }
    }

    /// Snapshot the SQLite file into Postgres (consistent copy via VACUUM INTO).
    async fn save(&mut self) -> Result<()> {
        let snap = self.db_path.with_extension("snapshot");
        let _ = std::fs::remove_file(&snap);
        {
            let conn = rusqlite::Connection::open(&self.db_path)?;
            conn.execute("VACUUM INTO ?1", [snap.to_string_lossy().to_string()])?;
        }
        let bytes = std::fs::read(&snap)?;
        let _ = std::fs::remove_file(&snap);
        let scanned = self.db.block_fully_scanned()?.map(|m| u32::from(m.block_height()) as i32);
        sqlx::query(
            "INSERT INTO wallet_store (network, data, scanned_height, updated_at) VALUES ($1, $2, $3, now())
             ON CONFLICT (network) DO UPDATE SET data = $2, scanned_height = $3, updated_at = now()",
        )
        .bind(&self.zeep_env)
        .bind(&bytes)
        .bind(scanned)
        .execute(&self.pool)
        .await?;
        self.dirty = false;
        self.last_persist = Instant::now();
        Ok(())
    }
}

#[async_trait]
impl Chain for LightClient {
    async fn check_network(&mut self, network: &str) -> Result<()> {
        let info = self.client().await?.get_lightd_info(service::Empty {}).await?.into_inner();
        if info.chain_name != network {
            bail!("lightwalletd {} is on {}net but ZCASH_NETWORK={network}; refusing to run", self.urls[self.current], info.chain_name);
        }
        Ok(())
    }

    async fn sync(&mut self) -> Result<()> {
        let before = self.db.block_fully_scanned()?.map(|m| m.block_height());
        let tip = match self.client().await?.get_latest_block(service::ChainSpec::default()).await {
            Ok(b) => b.into_inner().height as u32,
            Err(e) => {
                self.fail_over("tip request failed");
                bail!("lightwalletd tip request failed: {e}");
            }
        };
        // Stall detection: the server's tip should move every ~75 s.
        match self.tip {
            Some((h, since)) if h == tip && since.elapsed() > STALL_AFTER => {
                error!(tip, server = %self.urls[self.current], "ALERT lightwalletd tip has not moved for 20 minutes; switching server");
                self.tip = None;
                self.fail_over("stalled");
                return Ok(());
            }
            Some((h, _)) if h == tip => {}
            _ => self.tip = Some((tip, Instant::now())),
        }
        let params = self.params;
        let cache = self.cache.clone();
        let client = self.client().await?;
        let mut client = client.clone();
        if let Err(e) = zcash_client_backend::sync::run(&mut client, &params, &cache, &mut self.db, SYNC_BATCH).await {
            self.fail_over("sync failed");
            bail!("wallet sync failed: {e}");
        }
        let after = self.db.block_fully_scanned()?.map(|m| m.block_height());
        if after != before {
            self.dirty = true;
        }
        Ok(())
    }

    async fn persist(&mut self) -> Result<()> {
        if self.dirty || self.last_persist.elapsed() > PERSIST_EVERY {
            self.save().await?;
        }
        Ok(())
    }

    async fn tip_height(&mut self) -> Result<u32> {
        if let Some((h, _)) = self.tip {
            return Ok(h);
        }
        let b = self.client().await?.get_latest_block(service::ChainSpec::default()).await?.into_inner();
        Ok(b.height as u32)
    }

    async fn new_address(&mut self, diversifier_index: u64) -> Result<String> {
        let idx = DiversifierIndex::try_from(u128::from(DEPOSIT_INDEX_BASE + diversifier_index)).map_err(|_| anyhow!("diversifier index too large"))?;
        let ua: UnifiedAddress = self
            .db
            .get_address_for_index(self.account, idx, UnifiedAddressRequest::SHIELDED)
            .map_err(|e| anyhow!("{e:?}"))?
            .ok_or_else(|| anyhow!("no shielded address at diversifier index {diversifier_index}"))?;
        self.dirty = true;
        Ok(ua.encode(&self.params))
    }

    async fn received(&mut self, addresses: &[String]) -> Result<Vec<IncomingNote>> {
        if addresses.is_empty() {
            return Ok(vec![]);
        }
        let tip = self.db.chain_height()?.map(u32::from).unwrap_or(0);
        // Our deposit addresses by diversifier index (the wallet may store a differently
        // encoded address string for the same index after a rebuild, so never match on text).
        let rows: Vec<(String, i64)> = sqlx::query_as("SELECT address, diversifier_index FROM deposit_addresses WHERE address = ANY($1)")
            .bind(addresses)
            .fetch_all(&self.pool)
            .await?;
        let by_index: HashMap<u128, String> = rows.into_iter().map(|(a, i)| (u128::from(DEPOSIT_INDEX_BASE) + i as u128, a)).collect();
        let conn = rusqlite::Connection::open(&self.db_path)?;
        // Outputs received at our deposit addresses from someone else (not our own change/sends).
        let mut stmt = conn.prepare(
            "SELECT a.diversifier_index_be, t.txid, ro.pool, ro.output_index, ro.value, t.mined_height
               FROM v_received_outputs ro
               JOIN transactions t ON t.id_tx = ro.transaction_id
               JOIN addresses a ON a.id = ro.address_id
              WHERE ro.account_id = (SELECT id FROM accounts WHERE uuid = ?1)
                AND a.key_scope = 0 AND a.diversifier_index_be IS NOT NULL
                AND ro.is_change = 0 AND ro.sent_note_id IS NULL AND ro.pool IN (2, 3, 4)",
        )?;
        let found = stmt.query_map([self.account.expose_uuid().as_bytes().to_vec()], |r| {
            Ok((
                r.get::<_, Vec<u8>>(0)?,
                r.get::<_, Vec<u8>>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, Option<i64>>(5)?,
            ))
        })?;
        let mut out = vec![];
        for row in found {
            let (di_be, txid, pool, index, value, height) = row?;
            let di = di_be.iter().fold(0u128, |acc, b| (acc << 8) | u128::from(*b)); // stored big-endian
            let Some(address) = by_index.get(&di) else { continue };
            let mut b = txid;
            b.reverse(); // display order, as block explorers show it
            let h = height.unwrap_or(0).max(0) as u32;
            out.push(IncomingNote {
                to_address: address.clone(),
                txid: hex::encode(b),
                // Unique across pools within one transaction.
                index: (pool as u32) * 100_000 + index as u32,
                height: h,
                confirmations: if h > 0 && tip >= h { tip - h + 1 } else { 0 },
                amount_zats: value,
            });
        }
        Ok(out)
    }

    async fn balance(&mut self) -> Result<Balance> {
        let summary = self.db.get_wallet_summary(self.confirmations_policy())?;
        let Some(s) = summary else { return Ok(Balance::default()) };
        let Some(b) = s.account_balances().get(&self.account) else { return Ok(Balance::default()) };
        let shielded_total = u64::from(b.sapling_balance().total()) + u64::from(b.orchard_balance().total()) + u64::from(b.ironwood_balance().total());
        let spendable = u64::from(b.sapling_balance().spendable_value())
            + u64::from(b.orchard_balance().spendable_value())
            + u64::from(b.ironwood_balance().spendable_value());
        let unshielded = b.unshielded_balance();
        Ok(Balance {
            total_zats: (shielded_total + u64::from(unshielded.total())) as i64,
            spendable_zats: spendable as i64,
            transparent_zats: u64::from(unshielded.spendable_value()) as i64,
        })
    }

    async fn shield(&mut self) -> Result<Option<String>> {
        let prover = LocalTxProver::bundled();
        let selector = GreedyInputSelector::new();
        let change = self.change_strategy();
        let policy = ConfirmationsPolicy::MIN;
        let proposal = match propose_shielding::<_, _, _, _, std::convert::Infallible>(
            &mut self.db,
            &self.params,
            &selector,
            &change,
            Zatoshis::const_from_u64(0),
            &[self.reserve_taddr],
            self.account,
            policy,
            CoinbaseFilter::AllTransparentOutputs,
            None,
        ) {
            Ok(p) => p,
            Err(e) => {
                let msg = format!("{e:?}");
                if msg.contains("InsufficientFunds") || msg.contains("Insufficient") {
                    return Ok(None);
                }
                bail!("shielding proposal failed: {msg}");
            }
        };
        let txids = create_proposed_transactions::<_, _, std::convert::Infallible, _, std::convert::Infallible, _>(
            &mut self.db,
            &self.params,
            &SystemClock,
            &mut UnwrapErr(SysRng),
            &prover,
            &prover,
            &SpendingKeys::from_unified_spending_key(self.usk.clone()),
            OvkPolicy::Sender,
            &proposal,
            None,
        )
        .map_err(|e| anyhow!("shielding transaction failed: {e:?}"))?;
        let txid = *txids.first();
        self.broadcast(txid).await.map(Some).map_err(|e| anyhow!("{e}"))
    }

    async fn send(&mut self, to: &str, amount_zats: i64) -> std::result::Result<String, SendError> {
        let not_sent = |e: String| SendError::NotBroadcast(e);
        let addr = ZcashAddress::from_str(to).map_err(|e| not_sent(format!("bad recipient address: {e}")))?;
        let amount = Zatoshis::from_u64(amount_zats as u64).map_err(|_| not_sent("bad amount".into()))?;
        let payment = Payment::new(addr, Some(amount), None, None, None, vec![]).map_err(|e| not_sent(format!("{e:?}")))?;
        let request = TransactionRequest::new(vec![payment]).map_err(|e| not_sent(format!("{e:?}")))?;
        let selector = GreedyInputSelector::new();
        let change = self.change_strategy();
        let policy = self.confirmations_policy();
        let proposal = propose_transfer::<_, _, _, _, std::convert::Infallible>(
            &mut self.db,
            &self.params,
            self.account,
            &selector,
            &change,
            request,
            policy,
            &SpendPolicy::default(),
            None,
            None,
        )
        .map_err(|e| not_sent(format!("could not plan the payout: {e:?}")))?;
        let prover = LocalTxProver::bundled();
        let txids = create_proposed_transactions::<_, _, std::convert::Infallible, _, std::convert::Infallible, _>(
            &mut self.db,
            &self.params,
            &SystemClock,
            &mut UnwrapErr(SysRng),
            &prover,
            &prover,
            &SpendingKeys::from_unified_spending_key(self.usk.clone()),
            OvkPolicy::Sender,
            &proposal,
            None,
        )
        .map_err(|e| not_sent(format!("could not build the payout: {e:?}")))?;
        if txids.len() > 1 {
            // Multi-step proposals (e.g. via an ephemeral address) aren't used for our payouts.
            warn!(steps = txids.len(), "payout needed several transactions; broadcasting each");
        }
        let mut last = String::new();
        for txid in txids.iter() {
            last = self.broadcast(*txid).await?;
        }
        Ok(last)
    }

    async fn confirmations(&mut self, txid: &str) -> Result<Option<u32>> {
        let mut bytes = hex::decode(txid).context("bad txid")?;
        if bytes.len() != 32 {
            bail!("bad txid length");
        }
        bytes.reverse();
        let id = TxId::from_bytes(bytes.try_into().unwrap());
        let Some(h) = self.db.get_tx_height(id)? else { return Ok(None) };
        let tip = self.db.chain_height()?.map(u32::from).unwrap_or(0);
        Ok(Some(tip.saturating_sub(u32::from(h)) + 1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

    #[test]
    fn seed_words_are_validated() {
        assert!(seed_from_words(WORDS).is_ok());
        assert!(seed_from_words("not a real phrase").is_err());
        assert!(seed_from_words(&WORDS.replace(" art", " abandon")).is_err()); // bad checksum
    }

    #[test]
    fn addresses_follow_the_network_and_are_deterministic() {
        let seed = seed_from_words(WORDS).unwrap();
        for (net, ua_prefix, t_prefix) in [("test", "utest1", "tm"), ("main", "u1", "t1")] {
            let params = network_params(net).unwrap();
            let usk = UnifiedSpendingKey::from_seed(&params, seed.expose_secret(), zip32::AccountId::ZERO).unwrap();
            let (ua, taddr, ufvk) = reserve_addresses(&params, &usk).unwrap();
            assert!(ua.starts_with(ua_prefix), "{ua}");
            assert!(taddr.starts_with(t_prefix), "{taddr}");
            assert!(ufvk.starts_with(if net == "main" { "uview1" } else { "uviewtest1" }));
            assert_eq!(reserve_addresses(&params, &usk).unwrap().1, taddr);
        }
        assert!(network_params("regtest").is_err());
    }

    #[test]
    fn deposit_indexes_stay_clear_of_the_wallets_own_addresses() {
        // The wallet uses low indexes for its own (transparent-capable) addresses.
        assert!(DEPOSIT_INDEX_BASE >= 1 << 24);
        // Stored big-endian (11 bytes) in the wallet; decode the way received() does.
        let be = (u128::from(DEPOSIT_INDEX_BASE) + 7).to_be_bytes()[5..].to_vec();
        let di = be.iter().fold(0u128, |acc, b| (acc << 8) | u128::from(*b));
        assert_eq!(di - u128::from(DEPOSIT_INDEX_BASE), 7);
    }
}
