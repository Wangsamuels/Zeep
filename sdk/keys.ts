// Everything a user has on Zeep comes from one recovery phrase (24 BIP39 words):
//   - their in-app Zcash wallet (WebZjs account 0 from the same phrase)
//   - their Zeep spend key (sk) and note owner key (pk = Poseidon(sk))
//   - the key that encrypts their note backups
//   - their deposit intent ids and deposit note secrets (deterministic, so a restore finds them)
//   - their encrypted vault (chat history, settings) id and auth token
// Nothing here ever leaves the device except vaultId/vaultAuth (to read/write the vault),
// deposit intent ids and owner tags d (which don't reveal sk or link to spends).
import { hkdf } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { poseidon1, poseidon2 } from "poseidon-lite";
import { bytesToField } from "./field";

export interface ZeepKeys {
  /** The network these keys belong to; ZeepClient refuses an API on another network. */
  network: "testnet" | "mainnet";
  sk: bigint;
  pk: bigint;
  /** AES-256-GCM key for note backups (raw bytes). */
  noteKey: Uint8Array;
  /** AES-256-GCM key for the vault (chat history, settings). */
  vaultKey: Uint8Array;
  vaultId: string;
  vaultAuth: string;
  intentKey: Uint8Array;
}

const derive = (seed: Uint8Array, info: string, len = 32) => hkdf(sha256, seed, utf8ToBytes("zeep"), utf8ToBytes(info), len);

export function seedFromPhrase(phrase: string): Uint8Array {
  const words = phrase.trim().toLowerCase().split(/\s+/).join(" ");
  if (!validateMnemonic(words, wordlist)) throw new Error("Those words are not a valid recovery phrase.");
  return mnemonicToSeedSync(words);
}

export type ZeepNetwork = "testnet" | "mainnet";

/**
 * All Zeep keys for one network. The same phrase gives completely different keys on testnet
 * and mainnet (the network is part of every derivation), so nothing seen on testnet — intent
 * ids, vault id/auth, nullifiers, tags — can be used or linked on mainnet. Pass the API's
 * `network` from /v1/config.
 */
export function deriveKeys(seed: Uint8Array, network: ZeepNetwork): ZeepKeys {
  if (network !== "testnet" && network !== "mainnet") throw new Error("deriveKeys needs network 'testnet' or 'mainnet'");
  const k = (info: string) => derive(seed, `${info}:${network}`);
  const sk = bytesToField(k("zeep-sk-v1")) || 1n;
  return {
    network,
    sk,
    pk: poseidon1([sk]),
    noteKey: k("zeep-note-enc-v1"),
    vaultKey: k("zeep-vault-enc-v1"),
    vaultId: bytesToHex(k("zeep-vault-id-v1")),
    vaultAuth: bytesToHex(k("zeep-vault-auth-v1")),
    intentKey: k("zeep-intent-v1"),
  };
}

/**
 * Deposit number i: its intent id (sent to the server) and the secrets of its two notes
 * (kept): the dollar note (rho, d) and the ZEC note (rhoZec, dZec).
 */
export function depositSlot(keys: ZeepKeys, i: number): { intentId: string; rho: bigint; d: bigint; rhoZec: bigint; dZec: bigint } {
  const intentId = bytesToHex(hmac(sha256, keys.intentKey, utf8ToBytes(`intent:${i}`)));
  const rho = poseidon2([keys.sk, 2n ** 40n + BigInt(i)]);
  const rhoZec = poseidon2([keys.sk, 2n ** 41n + BigInt(i)]);
  return { intentId, rho, d: poseidon2([keys.pk, rho]), rhoZec, dZec: poseidon2([keys.pk, rhoZec]) };
}
