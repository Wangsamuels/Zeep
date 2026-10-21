// AES-256-GCM for stored payout addresses. Wire format (shared with the Rust payouts
// worker): base64( iv[12] || ciphertext || tag[16] ), key = base64 32 bytes.
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { need } from '../config.js';

function key(): Buffer {
  const k = Buffer.from(need('PAYOUT_ADDR_ENC_KEY'), 'base64');
  if (k.length !== 32) throw new Error('PAYOUT_ADDR_ENC_KEY must be 32 bytes, base64');
  return k;
}

export function encryptAddr(plain: string, aad = 'zeep-payout-v1', k: Buffer = key()): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

export function decryptAddr(enc: string, aad = 'zeep-payout-v1', k: Buffer = key()): string {
  const raw = Buffer.from(enc, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(12, raw.length - 16);
  const d = createDecipheriv('aes-256-gcm', k, iv);
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

export function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
