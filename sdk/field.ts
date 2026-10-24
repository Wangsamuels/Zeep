// BN254 field helpers + the request signals. Isomorphic (browser, worker, Node).
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

export const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const mod = (a: bigint): bigint => ((a % R) + R) % R;

export const sha256Hex = (data: Uint8Array | string): string =>
  bytesToHex(sha256(typeof data === "string" ? utf8ToBytes(data) : data));

/** SHA-256 of the parts joined by "\n", reduced into the field. Matches the server. */
export function hashToField(...parts: string[]): bigint {
  return BigInt("0x" + sha256Hex(parts.join("\n"))) % R;
}

export function bytesToField(b: Uint8Array): bigint {
  return BigInt("0x" + (bytesToHex(b) || "0")) % R;
}

export function randomField(): bigint {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return bytesToField(b) || 1n;
}

/** Signal for a paid request: binds method, path and the exact body bytes. */
/** Binds the request (method, path, exact body) and where a refund would go (its owner tag d, or 0). */
export const requestSignal = (method: string, path: string, rawBody: string | Uint8Array, refundD: bigint = 0n) =>
  hashToField("zeep-req-v2", method.toUpperCase(), path, sha256Hex(rawBody), refundD.toString());
export const withdrawSignal = (id: string, address: string) => hashToField("zeep-withdraw-v1", id.toLowerCase(), address);
export const notesSignal = () => hashToField("zeep-notes-v1");
export const depositSignal = (intentId: string, d: bigint) => hashToField("zeep-deposit-v1", intentId, d.toString());
/** Binds the conversion id and the new dollar note's owner tag and amount. */
export const convertSignal = (id: string, mintD: bigint, amountMicroUsd: bigint) =>
  hashToField("zeep-convert-v2", id.toLowerCase(), mintD.toString(), amountMicroUsd.toString());
