//! AES-256-GCM payout-address decryption, wire-compatible with src/lib/crypto.ts:
//! base64( iv[12] || ciphertext || tag[16] ), AAD "zeep-payout-v1".

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{anyhow, bail, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};

pub const AAD: &[u8] = b"zeep-payout-v1";

pub fn decrypt_addr(key_b64: &str, enc_b64: &str) -> Result<String> {
    let key = B64.decode(key_b64)?;
    if key.len() != 32 {
        bail!("PAYOUT_ADDR_ENC_KEY must be 32 bytes");
    }
    let raw = B64.decode(enc_b64)?;
    if raw.len() < 12 + 16 {
        bail!("ciphertext too short");
    }
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| anyhow!("{e}"))?;
    let pt = cipher
        .decrypt(Nonce::from_slice(&raw[..12]), Payload { msg: &raw[12..], aad: AAD })
        .map_err(|_| anyhow!("payout address failed to decrypt"))?;
    Ok(String::from_utf8(pt)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fixture produced by encryptAddr() in the Node gateway (see test/crypto.test.ts).
    #[test]
    fn decrypts_node_ciphertext() {
        let key = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
        let enc = include_str!("../../test/fixtures/payout_addr.enc").trim();
        assert_eq!(decrypt_addr(key, enc).unwrap(), "utest1zeepfixtureaddress");
    }
}
