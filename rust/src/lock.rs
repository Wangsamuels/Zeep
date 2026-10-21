//! Redis single-holder lease (`zeep:lock:<name>`, 60 s), compatible with withLock() in Node.

use anyhow::Result;
use rand::RngCore;
use redis::aio::MultiplexedConnection;

pub struct Lease {
    key: String,
    token: String,
    ttl_ms: u64,
}

impl Lease {
    pub fn new(name: &str, ttl_ms: u64) -> Self {
        let mut b = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut b);
        Self { key: format!("zeep:lock:{name}"), token: hex::encode(b), ttl_ms }
    }

    /// Acquire, or renew if we already hold it. Returns whether we hold the lease now.
    pub async fn hold(&self, con: &mut MultiplexedConnection) -> Result<bool> {
        let script = redis::Script::new(
            r#"
            local cur = redis.call('get', KEYS[1])
            if cur == ARGV[1] then redis.call('pexpire', KEYS[1], ARGV[2]) return 1 end
            if not cur then redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2]) return 1 end
            return 0"#,
        );
        let got: i32 = script.key(&self.key).arg(&self.token).arg(self.ttl_ms).invoke_async(con).await?;
        Ok(got == 1)
    }

    pub async fn release(&self, con: &mut MultiplexedConnection) -> Result<()> {
        let script = redis::Script::new(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        );
        let _: i32 = script.key(&self.key).arg(&self.token).invoke_async(con).await?;
        Ok(())
    }
}

pub async fn connect(url: &str) -> Result<MultiplexedConnection> {
    // Heroku Key-Value Store uses self-signed certs: redis-rs accepts them with `#insecure`.
    let url = if url.starts_with("rediss://") && !url.contains("#insecure") { format!("{url}#insecure") } else { url.to_string() };
    Ok(redis::Client::open(url)?.get_multiplexed_async_connection().await?)
}
