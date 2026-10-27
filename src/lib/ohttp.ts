// Oblivious HTTP for Zeep: the relay (Cloudflare) sees the user's IP but only ciphertext;
// Zeep's server sees the request but never the IP.
//
//   HPKE        RFC 9180, base mode, DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-128-GCM
//   Key config  RFC 9458 §3 (application/ohttp-keys)
//   Framing     chunked OHTTP (draft-ietf-ohai-chunked-ohttp), so AI replies still stream
//   Inner HTTP  RFC 9292 binary HTTP, indeterminate-length, zero padding
//
// This file is shared byte-for-byte by the server (src/lib/ohttp.ts) and the SDK
// (sdk/ohttp.ts); a unit test checks they're identical. It has no Node or DOM imports.
import { gcm } from "@noble/ciphers/aes";
import { x25519 } from "@noble/curves/ed25519";
import { expand, extract } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { randomBytes } from "@noble/hashes/utils";

export const KEM_ID = 0x0020; // DHKEM(X25519, HKDF-SHA256)
export const KDF_ID = 0x0001; // HKDF-SHA256
export const AEAD_ID = 0x0001; // AES-128-GCM
const NK = 16, NN = 12, NH = 32, NPK = 32;
export const REQ_MEDIA = "message/ohttp-chunked-req";
export const RES_MEDIA = "message/ohttp-chunked-res";
const REQ_LABEL = "message/bhttp chunked request";
const RES_LABEL = "message/bhttp chunked response";
const RES_NONCE_LEN = Math.max(NN, NK);

const te = new TextEncoder();
const td = new TextDecoder();
export function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const i2osp = (v: number, len: number) => {
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0 && v > 0; i--) { out[i] = v & 0xff; v = Math.floor(v / 256); }
  return out;
};
const xor = (a: Uint8Array, b: Uint8Array) => a.map((x, i) => x ^ b[i]);

// ------------------------------------------------------------------ HPKE (RFC 9180)
const V1 = te.encode("HPKE-v1");
const KEM_SUITE = concat(te.encode("KEM"), i2osp(KEM_ID, 2));
const HPKE_SUITE = concat(te.encode("HPKE"), i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(AEAD_ID, 2));
const labeledExtract = (suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array) =>
  extract(sha256, concat(V1, suite, te.encode(label), ikm), salt);
const labeledExpand = (suite: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, len: number) =>
  expand(sha256, prk, concat(i2osp(len, 2), V1, suite, te.encode(label), info), len);

function dh(sk: Uint8Array, pk: Uint8Array): Uint8Array {
  const s = x25519.getSharedSecret(sk, pk);
  if (s.every((b) => b === 0)) throw new OhttpError("bad public key");
  return s;
}
function kemSecret(dhv: Uint8Array, enc: Uint8Array, pkR: Uint8Array): Uint8Array {
  const prk = labeledExtract(KEM_SUITE, new Uint8Array(0), "eae_prk", dhv);
  return labeledExpand(KEM_SUITE, prk, "shared_secret", concat(enc, pkR), NH);
}

export class HpkeContext {
  private seq = 0;
  constructor(private key: Uint8Array, private baseNonce: Uint8Array, private exporter: Uint8Array) {}
  private nonce() {
    if (this.seq >= 2 ** 32) throw new OhttpError("too many messages");
    return xor(this.baseNonce, i2osp(this.seq++, NN));
  }
  seal(aad: Uint8Array, pt: Uint8Array) { return gcm(this.key, this.nonce(), aad).encrypt(pt); }
  open(aad: Uint8Array, ct: Uint8Array) {
    try {
      return gcm(this.key, this.nonce(), aad).decrypt(ct);
    } catch {
      throw new OhttpError("decryption failed");
    }
  }
  export(context: Uint8Array, len: number) { return labeledExpand(HPKE_SUITE, this.exporter, "sec", context, len); }
}
function keySchedule(shared: Uint8Array, info: Uint8Array): HpkeContext {
  const empty = new Uint8Array(0);
  const pskIdHash = labeledExtract(HPKE_SUITE, empty, "psk_id_hash", empty);
  const infoHash = labeledExtract(HPKE_SUITE, empty, "info_hash", info);
  const ctx = concat(new Uint8Array([0]), pskIdHash, infoHash); // mode_base
  const secret = labeledExtract(HPKE_SUITE, shared, "secret", empty);
  return new HpkeContext(
    labeledExpand(HPKE_SUITE, secret, "key", ctx, NK),
    labeledExpand(HPKE_SUITE, secret, "base_nonce", ctx, NN),
    labeledExpand(HPKE_SUITE, secret, "exp", ctx, NH),
  );
}
/** Sender side. `ephemeral` is only for test vectors. */
export function setupBaseS(pkR: Uint8Array, info: Uint8Array, ephemeral?: Uint8Array) {
  const skE = ephemeral ?? x25519.utils.randomPrivateKey();
  const enc = x25519.getPublicKey(skE);
  return { enc, ctx: keySchedule(kemSecret(dh(skE, pkR), enc, pkR), info) };
}
export function setupBaseR(enc: Uint8Array, skR: Uint8Array, info: Uint8Array): HpkeContext {
  if (enc.length !== NPK) throw new OhttpError("bad encapsulated key");
  return keySchedule(kemSecret(dh(skR, enc), enc, x25519.getPublicKey(skR)), info);
}
export const publicKeyOf = (sk: Uint8Array) => x25519.getPublicKey(sk);

export class OhttpError extends Error {}

// ------------------------------------------------------------------ key config (RFC 9458 §3)
export interface KeyConfig { keyId: number; publicKey: Uint8Array }

export function encodeKeyConfig(keyId: number, publicKey: Uint8Array): Uint8Array {
  return concat(new Uint8Array([keyId]), i2osp(KEM_ID, 2), publicKey, i2osp(4, 2), i2osp(KDF_ID, 2), i2osp(AEAD_ID, 2));
}
/** application/ohttp-keys: each config prefixed with its 2-byte length. */
export const encodeKeyConfigs = (configs: Uint8Array[]) => concat(...configs.flatMap((c) => [i2osp(c.length, 2), c]));

export function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64(s: string): Uint8Array {
  const t = s.trim().replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** One key config (41 bytes) or an ohttp-keys list; base64/base64url or raw bytes. Picks our suite. */
export function parseKeyConfig(input: string | Uint8Array): KeyConfig {
  const bytes = typeof input === "string" ? unb64(input) : input;
  const one = (c: Uint8Array): KeyConfig | null => {
    if (c.length < 7 + NPK || ((c[1] << 8) | c[2]) !== KEM_ID) return null;
    const algs = c.subarray(3 + NPK);
    const n = (algs[0] << 8) | algs[1];
    for (let i = 2; i + 4 <= 2 + n && i + 4 <= algs.length; i += 4) {
      if (((algs[i] << 8) | algs[i + 1]) === KDF_ID && ((algs[i + 2] << 8) | algs[i + 3]) === AEAD_ID) {
        return { keyId: c[0], publicKey: c.slice(3, 3 + NPK) };
      }
    }
    return null;
  };
  const direct = one(bytes);
  if (direct && bytes.length === 5 + NPK + ((bytes[3 + NPK] << 8) | bytes[4 + NPK])) return direct;
  for (let o = 0; o + 2 <= bytes.length; ) {
    const len = (bytes[o] << 8) | bytes[o + 1];
    const c = one(bytes.subarray(o + 2, o + 2 + len));
    if (c) return c;
    o += 2 + len;
  }
  throw new OhttpError("no usable OHTTP key config (needs X25519 / HKDF-SHA256 / AES-128-GCM)");
}

// ------------------------------------------------------------------ QUIC varints (RFC 9000 §16)
export function varint(v: number): Uint8Array {
  if (v < 0x40) return new Uint8Array([v]);
  if (v < 0x4000) return new Uint8Array([0x40 | (v >> 8), v & 0xff]);
  if (v < 0x40000000) return new Uint8Array([0x80 | (v >>> 24), (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
  throw new OhttpError("value too large");
}
/** [value, bytes used], or null when more input is needed. */
export function readVarint(b: Uint8Array, o: number): [number, number] | null {
  if (o >= b.length) return null;
  const len = 1 << (b[o] >> 6);
  if (o + len > b.length) return null;
  if (len === 8) throw new OhttpError("value too large");
  let v = b[o] & 0x3f;
  for (let i = 1; i < len; i++) v = v * 256 + b[o + i];
  return [v, len];
}

// ------------------------------------------------------------------ padding buckets
/** Requests and buffered responses are padded to these sizes, so lengths say little. */
export function bucket(n: number): number {
  if (n <= 1024) return 1024;
  if (n <= 65536) return 2 ** Math.ceil(Math.log2(n));
  return Math.ceil(n / 65536) * 65536;
}

// ------------------------------------------------------------------ binary HTTP (RFC 9292)
export type Fields = [string, string][];
const lp = (s: string | Uint8Array) => { const b = typeof s === "string" ? te.encode(s) : s; return concat(varint(b.length), b); };
const fieldsIndet = (f: Fields) => concat(...f.flatMap(([k, v]) => [lp(k.toLowerCase()), lp(v)]), varint(0));

/** Whole request, indeterminate-length, padded so the encrypted size falls in a bucket. */
export function encodeRequest(method: string, path: string, headers: Fields, body: Uint8Array): Uint8Array {
  const msg = concat(
    varint(2), lp(method), lp("https"), lp(""), lp(path),
    fieldsIndet(headers),
    body.length ? concat(varint(body.length), body) : new Uint8Array(0), varint(0),
    varint(0), // no trailers
  );
  // Sealed size = header 7 + enc 32 + final marker 1 + msg + tag 16: land exactly on a bucket.
  const over = 7 + NPK + 1 + 16;
  return concat(msg, new Uint8Array(bucket(msg.length + over) - (msg.length + over)));
}

export interface BRequest { method: string; path: string; headers: Fields; body: Uint8Array }

/** Parse a complete indeterminate- or known-length request. */
export function decodeRequest(b: Uint8Array): BRequest {
  let o = 0;
  const vi = () => { const r = readVarint(b, o); if (!r) throw new OhttpError("truncated request"); o += r[1]; return r[0]; };
  const bytes = () => { const n = vi(); if (o + n > b.length) throw new OhttpError("truncated request"); const s = b.subarray(o, o + n); o += n; return s; };
  const str = () => td.decode(bytes());
  const framing = vi();
  if (framing !== 0 && framing !== 2) throw new OhttpError("not a request");
  const method = str(); str(); str(); const path = str();
  const headers: Fields = [];
  if (framing === 0) {
    const end = vi() + o;
    while (o < end) headers.push([str(), str()]);
    const body = bytes();
    return { method, path, headers, body: body.slice() };
  }
  for (;;) { const name = str(); if (!name) break; headers.push([name, str()]); }
  const parts: Uint8Array[] = [];
  for (;;) { const c = bytes(); if (!c.length) break; parts.push(c); }
  return { method, path, headers, body: concat(...parts) };
}

/** Start of an indeterminate-length response: framing, status and headers. */
export const encodeResponseHead = (status: number, headers: Fields) => concat(varint(3), varint(status), fieldsIndet(headers));
export const encodeContent = (data: Uint8Array) => (data.length ? concat(varint(data.length), data) : new Uint8Array(0));
/** Content terminator + empty trailers, then zero padding up to the bucket. */
/** Sealed size of a one-chunk response = nonce 16 + final marker 1 + plaintext + tag 16. */
export const RESPONSE_OVERHEAD = 16 + 1 + 16;
export const encodeResponseEnd = (padTo = 0) => concat(varint(0), varint(0), new Uint8Array(Math.max(0, padTo)));

/** Incremental parser for an indeterminate-length response (what the server sends). */
export class ResponseParser {
  private buf: Uint8Array = new Uint8Array(0);
  private state: "framing" | "status" | "headers" | "content" | "done" = "framing";
  status = 0;
  headers: Fields = [];
  /** Feed decrypted bytes; returns content bytes that became available and whether the head is known. */
  push(data: Uint8Array): { content: Uint8Array[]; head: boolean } {
    this.buf = this.buf.length ? concat(this.buf, data) : data;
    const content: Uint8Array[] = [];
    let o = 0;
    const take = (): number | null => { const r = readVarint(this.buf, o); if (!r) return null; o += r[1]; return r[0]; };
    loop: for (;;) {
      const mark = o;
      switch (this.state) {
        case "framing": {
          const f = take(); if (f === null) break loop;
          if (f !== 3) throw new OhttpError("not an indeterminate-length response");
          this.state = "status"; break;
        }
        case "status": {
          const s = take(); if (s === null) { o = mark; break loop; }
          if (s >= 100 && s < 200) throw new OhttpError("informational responses not supported");
          this.status = s; this.state = "headers"; break;
        }
        case "headers": {
          const n = take(); if (n === null) { o = mark; break loop; }
          if (n === 0) { this.state = "content"; break; }
          if (o + n > this.buf.length) { o = mark; break loop; }
          const name = td.decode(this.buf.subarray(o, o + n)); o += n;
          const m = take(); if (m === null || o + m > this.buf.length) { o = mark; break loop; }
          this.headers.push([name, td.decode(this.buf.subarray(o, o + m))]); o += m;
          break;
        }
        case "content": {
          const n = take(); if (n === null) { o = mark; break loop; }
          if (n === 0) { this.state = "done"; break; }
          if (o + n > this.buf.length) { o = mark; break loop; }
          content.push(this.buf.slice(o, o + n)); o += n;
          break;
        }
        case "done":
          o = this.buf.length; // trailers we don't use, then padding
          break loop;
      }
    }
    this.buf = this.buf.subarray(o);
    return { content, head: this.state === "content" || this.state === "done" };
  }
  get complete() { return this.state === "done"; }
}

// ------------------------------------------------------------------ chunked OHTTP framing
const FINAL = te.encode("final");
const EMPTY = new Uint8Array(0);
const reqHeader = (keyId: number) => concat(new Uint8Array([keyId]), i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(AEAD_ID, 2));
const reqInfo = (hdr: Uint8Array) => concat(te.encode(REQ_LABEL), new Uint8Array([0]), hdr);

/** Response-side AEAD derived from the request's HPKE context (same for both ends). */
export class ResponseCrypto {
  private counter = 0;
  private key: Uint8Array;
  private nonce: Uint8Array;
  constructor(ctx: HpkeContext, enc: Uint8Array, readonly responseNonce: Uint8Array) {
    const secret = ctx.export(te.encode(RES_LABEL), RES_NONCE_LEN);
    const prk = extract(sha256, secret, concat(enc, responseNonce));
    this.key = expand(sha256, prk, te.encode("key"), NK);
    this.nonce = expand(sha256, prk, te.encode("nonce"), NN);
  }
  private next() { return xor(this.nonce, i2osp(this.counter++, NN)); }
  seal(pt: Uint8Array, final: boolean) { return gcm(this.key, this.next(), final ? FINAL : EMPTY).encrypt(pt); }
  open(ct: Uint8Array, final: boolean) {
    try {
      return gcm(this.key, this.next(), final ? FINAL : EMPTY).decrypt(ct);
    } catch {
      throw new OhttpError("response decryption failed");
    }
  }
}

/** Client: encrypt one whole request as a single final chunk. */
export function sealRequest(cfg: KeyConfig, plaintext: Uint8Array) {
  const hdr = reqHeader(cfg.keyId);
  const { enc, ctx } = setupBaseS(cfg.publicKey, reqInfo(hdr));
  const ct = ctx.seal(FINAL, plaintext);
  return { body: concat(hdr, enc, varint(0), ct), ctx, enc };
}

/** Gateway: decrypt a chunked request (any number of chunks). `keyFor` returns the private key for a key id. */
export function openRequest(body: Uint8Array, keyFor: (keyId: number) => Uint8Array | undefined) {
  if (body.length < 7 + NPK + 1) throw new OhttpError("request too short");
  const hdr = body.subarray(0, 7);
  if (((hdr[1] << 8) | hdr[2]) !== KEM_ID || ((hdr[3] << 8) | hdr[4]) !== KDF_ID || ((hdr[5] << 8) | hdr[6]) !== AEAD_ID) {
    throw new OhttpError("unsupported algorithms");
  }
  const sk = keyFor(hdr[0]);
  if (!sk) throw new OhttpError("unknown key id");
  const enc = body.slice(7, 7 + NPK);
  const ctx = setupBaseR(enc, sk, reqInfo(hdr.slice()));
  const parts: Uint8Array[] = [];
  let o = 7 + NPK;
  for (;;) {
    const r = readVarint(body, o);
    if (!r) throw new OhttpError("truncated request");
    o += r[1];
    if (r[0] === 0) { parts.push(ctx.open(FINAL, body.subarray(o))); break; }
    if (o + r[0] > body.length) throw new OhttpError("truncated request");
    parts.push(ctx.open(EMPTY, body.subarray(o, o + r[0])));
    o += r[0];
  }
  return { plaintext: concat(...parts), ctx, enc };
}

/** Gateway: start a response. Write `nonce` first, then `chunk(...)` per piece, then `final(...)`. */
export function responseWriter(ctx: HpkeContext, enc: Uint8Array) {
  const nonce = randomBytes(RES_NONCE_LEN);
  const rc = new ResponseCrypto(ctx, enc, nonce);
  return {
    nonce,
    chunk: (pt: Uint8Array) => { const ct = rc.seal(pt, false); return concat(varint(ct.length), ct); },
    final: (pt: Uint8Array) => concat(varint(0), rc.seal(pt, true)),
  };
}

/** Client: incremental reader for the chunked response stream. */
export class ResponseReader {
  private buf: Uint8Array = new Uint8Array(0);
  private rc: ResponseCrypto | null = null;
  private finalSeen = false;
  constructor(private ctx: HpkeContext, private enc: Uint8Array) {}
  /** Feed raw bytes from the network; returns decrypted non-final chunks. */
  push(data: Uint8Array): Uint8Array[] {
    if (this.finalSeen) { this.buf = concat(this.buf, data); return []; }
    this.buf = this.buf.length ? concat(this.buf, data) : data;
    const out: Uint8Array[] = [];
    let o = 0;
    if (!this.rc) {
      if (this.buf.length < RES_NONCE_LEN) return out;
      this.rc = new ResponseCrypto(this.ctx, this.enc, this.buf.slice(0, RES_NONCE_LEN));
      o = RES_NONCE_LEN;
    }
    for (;;) {
      const r = readVarint(this.buf, o);
      if (!r) break;
      if (r[0] === 0) { this.finalSeen = true; o += r[1]; break; }
      if (o + r[1] + r[0] > this.buf.length) break;
      out.push(this.rc.open(this.buf.subarray(o + r[1], o + r[1] + r[0]), false));
      o += r[1] + r[0];
    }
    this.buf = this.buf.slice(o);
    return out;
  }
  /** At end of stream: the final chunk. Throws if the response was cut short. */
  end(): Uint8Array {
    if (!this.rc || !this.finalSeen) throw new OhttpError("response truncated");
    return this.rc.open(this.buf, true);
  }
}
