// BN254 scalar-field helpers used by the spend circuit.
import { createHash } from 'node:crypto';

export const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export const mod = (a: bigint): bigint => ((a % R) + R) % R;

export function inv(a: bigint): bigint {
  // Fermat: a^(R-2) mod R
  let result = 1n;
  let base = mod(a);
  let e = R - 2n;
  while (e > 0n) {
    if (e & 1n) result = (result * base) % R;
    base = (base * base) % R;
    e >>= 1n;
  }
  return result;
}

/** Parse a decimal or 0x-hex field element; throws if malformed or not < R. */
export function toField(v: string | bigint | number): bigint {
  let n: bigint;
  if (typeof v === 'bigint') n = v;
  else if (typeof v === 'number') n = BigInt(v);
  else {
    const s = v.trim();
    if (!/^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/.test(s)) throw new Error('not a field element');
    n = BigInt(s);
  }
  if (n < 0n || n >= R) throw new Error('field element out of range');
  return n;
}

export const isField = (v: unknown): boolean => {
  try {
    toField(v as string);
    return true;
  } catch {
    return false;
  }
};

export const fieldHex = (n: bigint): string => '0x' + n.toString(16).padStart(64, '0');

/** SHA-256 of the input, reduced into the field. This is the spend signal hash. */
export function hashToField(...parts: (string | Buffer)[]): bigint {
  const h = createHash('sha256');
  parts.forEach((p, i) => {
    if (i > 0) h.update('\n');
    h.update(p);
  });
  return BigInt('0x' + h.digest('hex')) % R;
}

export const sha256hex = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');
