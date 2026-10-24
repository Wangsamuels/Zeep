// Private-balance spends: parse a bundle, verify the Groth16 proof, burn the two
// nullifiers and append the two change notes — atomically.
//
// Circuit: circuits-src/zeep_spend.circom. Public signals, in order:
//   [root0, root1, nullifier0, nullifier1, outCommitment0, outCommitment1, cost, asset,
//    signalHash, tag, tagEpoch, tagPurpose]   (tag = Poseidon(sk, tagEpoch, tagPurpose))
// asset: 0 = dollars (micro-USD), 1 = ZEC (zatoshis).
import { readFile } from 'node:fs/promises';
import { poseidon3 } from 'poseidon-lite';
import * as snarkjs from 'snarkjs';
import { z } from 'zod';
import { cfg } from '../config.js';
import { tx, type Tx } from '../lib/db.js';
import { errors, ZeepError } from '../lib/errors.js';
import { hashToField, sha256hex, toField } from '../lib/field.js';
import { addBooks, type BookKind } from '../services/books.js';
import { marginOf } from '../services/fees.js';
import { registry, type Appended, type Leaf } from './registry.js';

const field = z.union([z.string(), z.number()]).transform((v, ctx) => {
  try {
    return toField(String(v));
  } catch {
    ctx.addIssue({ code: 'custom', message: 'not a field element' });
    return z.NEVER;
  }
});
const coord = z.string().regex(/^[0-9]{1,78}$/);
const proofSchema = z.union([
  z.object({ pi_a: z.array(coord).min(2).max(3), pi_b: z.array(z.array(coord).length(2)).min(2).max(3), pi_c: z.array(coord).min(2).max(3) }),
  z.array(coord).length(8).transform((p) => ({ pi_a: [p[0], p[1]], pi_b: [[p[2], p[3]], [p[4], p[5]]], pi_c: [p[6], p[7]] })),
]);
// A note backup is base64(nonce[12] || AES-GCM(asset u8 || amount u64 || rho 32 bytes)) = 96 chars.
const enc = z.string().regex(/^[A-Za-z0-9+/=_-]{16,160}$/).nullable().default(null);

const Bundle = z.object({
  root: z.tuple([field, field]),
  nullifier: z.tuple([field, field]),
  out: z.tuple([z.object({ c: field, e: enc }), z.object({ c: field, e: enc })]),
  cost: z.union([z.string().regex(/^\d{1,16}$/), z.number().int().nonnegative()]).transform((v) => BigInt(v)),
  asset: z.union([z.literal(0), z.literal(1)]),
  tag: z.object({ value: field, epoch: field, purpose: z.number().int().min(0).max(2) }),
  proof: proofSchema,
  // Where to put the money back if the upstream fails before answering.
  compensate: z.object({ d: field, e: enc }).optional(),
});
export type SpendBundle = z.infer<typeof Bundle>;

export function parseBundle(raw: unknown): SpendBundle {
  const r = Bundle.safeParse(raw);
  if (!r.success) throw errors.bad('malformed spend proof', { issues: r.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`) });
  return r.data;
}

/** `X-Zeep-Proof` (base64 JSON), optionally split across `X-Zeep-Proof-1..n`. */
export function bundleFromHeaders(headers: Record<string, string | string[] | undefined>): SpendBundle | undefined {
  const first = headers['x-zeep-proof'];
  if (!first || Array.isArray(first)) return undefined;
  let b64 = first;
  for (let i = 1; i < 16; i++) {
    const part = headers[`x-zeep-proof-${i}`];
    if (!part || Array.isArray(part)) break;
    b64 += part;
  }
  try {
    return parseBundle(JSON.parse(Buffer.from(b64, 'base64').toString('utf8')));
  } catch (e) {
    if (e instanceof ZeepError) throw e;
    throw errors.bad('X-Zeep-Proof is not base64 JSON');
  }
}

// ---------- signals (clients must compute exactly the same) ----------
/** Binds the request (method, path, exact body) and where a refund would go (compensate.d, or 0). */
export const requestSignal = (method: string, path: string, rawBody: Buffer | string | undefined, refundD: bigint = 0n) =>
  hashToField('zeep-req-v2', method.toUpperCase(), path, sha256hex(rawBody ?? ''), refundD.toString());
export const withdrawSignal = (id: string, address: string) => hashToField('zeep-withdraw-v1', id.toLowerCase(), address);
export const notesSignal = () => hashToField('zeep-notes-v1');
export const depositSignal = (intentId: string, d: bigint) => hashToField('zeep-deposit-v1', intentId, d.toString());
export const convertSignal = (id: string, mintD: bigint, amountMicroUsd: bigint) =>
  hashToField('zeep-convert-v2', id, mintD.toString(), amountMicroUsd.toString());
export const gateSignal = (method: string, requestDigestHex: string) => hashToField('zeep-gate-v1', method, requestDigestHex);

// ---------- verifying key ----------
let vkeyPromise: Promise<object> | undefined;
export function loadVkey(): Promise<object> {
  vkeyPromise ??= (async () => {
    let raw: string;
    if (cfg.SPEND_VKEY_PATH) raw = await readFile(cfg.SPEND_VKEY_PATH, 'utf8');
    else if (cfg.SPEND_VKEY_URL) {
      const r = await fetch(cfg.SPEND_VKEY_URL, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`verifying key fetch failed: ${r.status}`);
      raw = await r.text();
    } else throw new Error('Set SPEND_VKEY_URL or SPEND_VKEY_PATH');
    const got = sha256hex(raw);
    if (cfg.SPEND_VKEY_SHA256 && got !== cfg.SPEND_VKEY_SHA256.toLowerCase()) throw new Error(`verifying key hash mismatch (got ${got})`);
    const vk = JSON.parse(raw);
    if (vk.protocol !== 'groth16' || vk.nPublic !== 12) throw new Error('unexpected verifying key (need groth16, 12 public signals)');
    return vk;
  })();
  vkeyPromise.catch(() => (vkeyPromise = undefined));
  return vkeyPromise;
}

// ---------- spending ----------
export const USD = 0 as const;
export const ZEC = 1 as const;
export type Asset = typeof USD | typeof ZEC;

export interface SpendOpts {
  bundle: SpendBundle | undefined;
  /** The asset this route spends ('any' for zero-cost note management). */
  asset: Asset | 'any';
  signal: bigint;
  /** Minimum cost (paid routes, micro-USD). */
  minCost?: number;
  /** Exact cost in the spend's asset (withdrawals, note management). */
  exactCost?: bigint;
  book: BookKind | null;
  /** Require today's tag for this purpose (1 withdrawal, 2 deposit rebate) and record it. */
  daily?: 1 | 2;
}

export interface Spent {
  cost: bigint;
  asset: Asset;
  /** With `daily`: true if this is the user's first tag of this purpose today. */
  firstToday: boolean;
  notes: Appended;
  /** Put `cost` back as a new note (upstream failed before answering). */
  compensate(): Promise<Appended | null>;
}

/** Checks that don't touch the database, then the Groth16 verification. */
async function verify(o: SpendOpts): Promise<SpendBundle> {
  const b = o.bundle;
  if (!b) throw new ZeepError(402, 'proof_required', 'this route needs a spend proof', { min_cost_micro_usd: o.minCost ?? 0 });

  if (o.asset !== 'any' && b.asset !== o.asset) throw errors.invalid(o.asset === USD ? 'this must be paid from your dollar balance' : 'this must be paid from your ZEC balance');
  if (o.exactCost !== undefined && b.cost !== o.exactCost) throw errors.invalid('cost does not match the request');
  if (o.minCost !== undefined) {
    if (b.cost < BigInt(o.minCost)) throw new ZeepError(402, 'underpaid', `this request costs ${o.minCost} micro-USD`, { min_cost_micro_usd: o.minCost });
    if (b.cost > BigInt(o.minCost) * 2n + 1000n) throw errors.invalid('cost is far above the current price; refresh prices');
  }
  for (const r of b.root) if ((await registry.acceptRoot(r.toString())) === undefined) throw errors.staleRoot();
  if (o.daily) {
    const today = BigInt(Math.floor(Date.now() / 86_400_000));
    const grace = BigInt(Math.floor((Date.now() - 120_000) / 86_400_000)); // proofs made just before midnight
    if (b.tag.purpose !== o.daily || (b.tag.epoch !== today && b.tag.epoch !== grace)) throw errors.invalid('this request needs today\'s daily tag');
  }
  if (b.nullifier[0] === b.nullifier[1]) throw errors.invalid('the two inputs must be different notes');

  const vk = await loadVkey();
  const publics = [b.root[0], b.root[1], b.nullifier[0], b.nullifier[1], b.out[0].c, b.out[1].c, b.cost, BigInt(b.asset), o.signal,
    b.tag.value, b.tag.epoch, BigInt(b.tag.purpose)].map(String);
  const ok = await snarkjs.groth16
    .verify(vk, publics, {
      pi_a: b.proof.pi_a.length === 2 ? [...b.proof.pi_a, '1'] : b.proof.pi_a,
      pi_b: b.proof.pi_b.length === 2 ? [...b.proof.pi_b, ['1', '0']] : b.proof.pi_b,
      pi_c: b.proof.pi_c.length === 2 ? [...b.proof.pi_c, '1'] : b.proof.pi_c,
      protocol: 'groth16',
      curve: 'bn128',
    })
    .catch(() => false);
  if (!ok) throw new ZeepError(402, 'invalid_proof', 'the spend proof did not verify (is it bound to this exact request?)');
  return b;
}

/**
 * Verify every proof, then in ONE transaction burn all nullifiers, append all outputs and
 * run `inTx` (which may return extra leaves the server mints, e.g. a converted note).
 * Either everything lands or nothing does.
 */
export async function spendAll(
  list: SpendOpts[],
  inTx?: (c: Tx, spent: { cost: bigint; asset: Asset; firstToday: boolean }[]) => Promise<Leaf[] | void>,
): Promise<{ spent: Spent[]; minted: Appended | null }> {
  const bundles: SpendBundle[] = [];
  for (const o of list) bundles.push(await verify(o));
  const seen = new Set<string>();
  for (const b of bundles) for (const n of b.nullifier) {
    if (seen.has(n.toString())) throw errors.invalid('the same note appears twice');
    seen.add(n.toString());
  }

  let publish: (() => Promise<void>) | undefined;
  const appended: Appended[] = [];
  let minted: Appended | null = null;
  let touched = false; // in-memory tree changed; must resync if the transaction fails
  const meta = bundles.map((b) => ({ cost: b.cost, asset: b.asset as Asset, firstToday: false }));
  try {
    await tx(async (c) => {
      for (const b of bundles) for (const n of b.nullifier) {
        const r = await c.query('INSERT INTO nullifiers (nullifier) VALUES ($1) ON CONFLICT DO NOTHING', [n.toString()]);
        if (!r.rowCount) throw errors.tagUsed();
      }
      for (const [i, o] of list.entries()) {
        const b = bundles[i];
        if (o.book && b.cost > 0n) await addBooks(c, o.book, b.cost);
        // The markup on a service charge is booked in the same transaction (never lost to a crash).
        if (o.book === 'service' && b.cost > 0n) await addBooks(c, 'margin', marginOf(b.cost));
        if (o.daily) {
          const t = await c.query('INSERT INTO daily_tags (day, purpose, tag) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [Number(b.tag.epoch), o.daily, b.tag.value.toString()]);
          meta[i].firstToday = (t.rowCount ?? 0) > 0;
        }
      }
      const extra = (await inTx?.(c, meta)) ?? [];
      touched = true;
      const leaves: Leaf[] = bundles.flatMap((b) => b.out.map((x) => ({ commitment: x.c, enc: x.e })));
      const a = await registry.appendInTx(c, [...leaves, ...extra]);
      publish = a.publish;
      for (let i = 0; i < bundles.length; i++) appended.push({ tree: a.result.tree, indexes: a.result.indexes.slice(2 * i, 2 * i + 2), root: a.result.root });
      if (extra.length) minted = { tree: a.result.tree, indexes: a.result.indexes.slice(2 * bundles.length), root: a.result.root };
    });
  } catch (e) {
    if (touched) await registry.resync();
    if (e instanceof ZeepError && e.code === 'tag_used') throw new ZeepError(409, 'note_spent', 'one of these notes was already spent; refresh your notes');
    throw e;
  }
  await publish?.();

  const spent = bundles.map((b, i): Spent => {
    let compensated = false;
    const book = list[i].book;
    return {
      cost: b.cost,
      asset: b.asset as Asset,
      firstToday: meta[i].firstToday,
      notes: appended[i],
      async compensate() {
        if (compensated || !b.compensate || b.cost === 0n) return null;
        compensated = true;
        const leaf = mintedLeaf(b.compensate.d, b.cost, b.asset as Asset);
        let pub: (() => Promise<void>) | undefined;
        let res: Appended | undefined;
        try {
          await tx(async (c) => {
            const a = await registry.appendInTx(c, [{ commitment: leaf, enc: b.compensate!.e }]);
            pub = a.publish;
            res = a.result;
            if (book === 'service') {
              await addBooks(c, 'compensation', b.cost);
              await addBooks(c, 'margin', -marginOf(b.cost)); // refunded: no margin earned
            }
          });
        } catch (e) {
          await registry.resync();
          throw e;
        }
        await pub?.();
        return res!;
      },
    };
  });
  return { spent, minted };
}

export async function spend(o: SpendOpts): Promise<Spent> {
  return (await spendAll([o])).spent[0];
}

/** A note the server creates (deposits, conversions): leaf = Poseidon(d, amount, asset). */
export const mintedLeaf = (d: bigint, amount: bigint, asset: Asset) => poseidon3([d, amount, BigInt(asset)]);

/** Header value telling the client where its change notes landed. */
export const notesHeader = (a: Appended) => `${a.tree}:${a.indexes.join(',')}`;
