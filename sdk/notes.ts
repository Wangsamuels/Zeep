// Shielded balance notes. A user has two balances, each the sum of their unspent notes of
// that asset; the server never sees either. Each note is (rho, amount, asset) with:
//   d = Poseidon(pk, rho)   commitment = Poseidon(d, amount, asset)   nullifier = Poseidon(sk, rho)
// asset 0 = dollars (amount in micro-USD), asset 1 = ZEC (amount in zatoshis).
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { poseidon2, poseidon3 } from "poseidon-lite";
import { randomField } from "./field";
import type { ZeepKeys } from "./keys";

export const USD = 0 as const;
export const ZEC = 1 as const;
export type Asset = typeof USD | typeof ZEC;

export interface Note {
  rho: string; // decimal
  amount: string; // micro-USD (asset 0) or zats (asset 1), decimal
  asset: Asset;
  tree: number;
  index: number;
  commitment: string;
  /** "deposit:<i>" / "deposit-zec:<i>" for deposit notes, "refill" for converted notes, "change" for spend outputs. */
  origin: string;
  spent?: boolean;
  /** Locked while a spend that uses it is in flight. */
  pending?: boolean;
}

export const ownerTag = (pk: bigint, rho: bigint) => poseidon2([pk, rho]);
export const noteCommitment = (d: bigint, amount: bigint, asset: Asset) => poseidon3([d, amount, BigInt(asset)]);
export const nullifierOf = (sk: bigint, rho: bigint) => poseidon2([sk, rho]);

// ---- encrypted backups: base64(nonce[12] || AES-GCM(amount u64 BE || rho 32B || asset u8)) ----
const PT_LEN = 41;
const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function aes(key: Uint8Array) {
  return crypto.subtle.importKey("raw", new Uint8Array(key), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptNote(noteKey: Uint8Array, amount: bigint, rho: bigint, asset: Asset): Promise<string> {
  const pt = new Uint8Array(PT_LEN);
  new DataView(pt.buffer).setBigUint64(0, amount);
  pt.set(hexToBytes(rho.toString(16).padStart(64, "0")), 8);
  pt[40] = asset;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aes(noteKey), pt));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return toB64(out);
}

export async function decryptNote(noteKey: Uint8Array, enc: string): Promise<{ amount: bigint; rho: bigint; asset: Asset } | null> {
  try {
    const raw = fromB64(enc);
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, await aes(noteKey), raw.slice(12)));
    if (pt.length !== PT_LEN || pt[40] > 1) return null;
    return { amount: new DataView(pt.buffer).getBigUint64(0), rho: BigInt("0x" + bytesToHex(pt.slice(8, 40))), asset: pt[40] as Asset };
  } catch {
    return null; // not ours
  }
}

/** Same-length random bytes for a zero-value dummy output, so it looks like any other backup. */
export function dummyEnc(): string {
  return toB64(crypto.getRandomValues(new Uint8Array(12 + PT_LEN + 16)));
}

/** A fresh output note owned by `pk` (the user's, or an agent's). */
export function newOutput(pk: bigint, amount: bigint, asset: Asset) {
  const rho = randomField();
  const d = ownerTag(pk, rho);
  return { rho, d, amount, commitment: noteCommitment(d, amount, asset) };
}

/**
 * Refill state for the dollar balance (client-side; the server never sees balances).
 * `base`: the dollar balance right after the last top-up (deposit or refill).
 * `stage`: refills done since the last deposit (the last stage converts all the ZEC).
 */
export interface RefillState {
  base: string;
  stage: number;
}

/** In-memory note book with balances and input selection. Persist with toJSON(). */
export class NoteBook {
  notes: Note[] = [];
  nextDeposit = 0;
  refill: RefillState = { base: "0", stage: 0 };

  static from(json: { notes: Note[]; nextDeposit: number; refill?: RefillState } | null | undefined): NoteBook {
    const b = new NoteBook();
    if (json) {
      b.notes = json.notes.map((n) => ({ ...n, asset: (n.asset ?? USD) as Asset, pending: false }));
      b.nextDeposit = json.nextDeposit;
      if (json.refill) b.refill = json.refill;
    }
    return b;
  }

  toJSON() {
    return { notes: this.notes.filter((n) => !n.spent), nextDeposit: this.nextDeposit, refill: this.refill };
  }

  /** Spendable balance of one asset: micro-USD (USD) or zats (ZEC). */
  balance(asset: Asset): bigint {
    return this.notes.filter((n) => n.asset === asset && !n.spent && !n.pending).reduce((s, n) => s + BigInt(n.amount), 0n);
  }

  add(n: Note) {
    if (!this.notes.some((x) => x.commitment === n.commitment)) this.notes.push(n);
  }

  /**
   * Up to two unspent notes of `asset` covering `cost`. Returns null if the balance is too
   * low; `{ merge: [a, b] }` if the money is spread over more notes than one spend can use.
   */
  select(cost: bigint, asset: Asset): { inputs: Note[] } | { merge: [Note, Note] } | null {
    const free = this.notes.filter((n) => n.asset === asset && !n.spent && !n.pending && BigInt(n.amount) > 0n)
      .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));
    const total = free.reduce((s, n) => s + BigInt(n.amount), 0n);
    if (total < cost) return null;
    const one = [...free].reverse().find((n) => BigInt(n.amount) >= cost);
    if (one) return { inputs: [one] };
    if (free.length >= 2 && BigInt(free[0].amount) + BigInt(free[1].amount) >= cost) return { inputs: [free[0], free[1]] };
    return { merge: [free[free.length - 1], free[free.length - 2]] };
  }
}

export function noteFromKeys(keys: ZeepKeys, rho: bigint, amount: bigint, asset: Asset, tree: number, index: number, origin: string): Note {
  const d = ownerTag(keys.pk, rho);
  return { rho: rho.toString(), amount: amount.toString(), asset, tree, index, commitment: noteCommitment(d, amount, asset).toString(), origin };
}
