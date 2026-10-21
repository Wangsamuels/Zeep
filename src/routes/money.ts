// Deposits (any amount of ZEC → a ZEC note + a dollar note), conversions (ZEC → dollars, the
// client's refills), withdrawals (ZEC notes first; dollars converted back only for the rest,
// always arriving shielded) and note management (merge / split / fund an agent).
// Fees: see src/services/fees.ts. "First of the user's day" is enforced with a private daily
// tag in the proof, so it works without accounts or linking.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { cfg } from '../config.js';
import { encryptAddr } from '../lib/crypto.js';
import { q, tx } from '../lib/db.js';
import { errors, ZeepError } from '../lib/errors.js';
import { toField } from '../lib/field.js';
import { keys, redis } from '../lib/redis.js';
import { bundleFromHeaders, convertSignal, depositSignal, mintedLeaf, notesHeader, notesSignal, parseBundle, spend, spendAll, USD, withdrawSignal, ZEC, type SpendOpts } from '../notes/spend.js';
import { addBooks } from '../services/books.js';
import { bpsOf, feeSheet, takeSubsidy } from '../services/fees.js';
import { microUsdToZats, zatsToMicroUsd, zecQuotes } from '../services/prices.js';
import { scheduleTranches } from '../treasury/float.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTENT = /^[0-9a-f]{64}$/;
const B58 = '[1-9A-HJ-NP-Za-km-z]';

export const CONVERTING_MESSAGE =
  'Processing: converting your credits back to ZEC (Tempo → Base → Zcash). This usually takes 20–60 minutes; the ZEC is shielded on arrival and sent to you automatically.';
export const TRANSPARENT_WARNING =
  'Transparent address: the amount and the recipient will be public on the Zcash blockchain.';

export function isShielded(a: string): boolean {
  return cfg.ZCASH_NETWORK === 'main'
    ? new RegExp('^(u1[02-9ac-hj-np-z]{100,1000}|zs1[02-9ac-hj-np-z]{75})$').test(a)
    : new RegExp('^(utest1[02-9ac-hj-np-z]{100,1000}|ztestsapling1[02-9ac-hj-np-z]{75})$').test(a);
}
export function isTransparent(a: string): boolean {
  return cfg.ZCASH_NETWORK === 'main' ? new RegExp(`^t[13]${B58}{33}$`).test(a) : new RegExp(`^t[m2]${B58}{33}$`).test(a);
}
/** Shielded always; transparent only when the user explicitly opts in. */
export function validPayoutAddress(a: string, allowTransparent = false): boolean {
  return isShielded(a) || (allowTransparent && isTransparent(a));
}

/**
 * A withdrawal takes `zecZats` from ZEC notes (paid as is) and `usdMicro` from dollar notes
 * (converted back to ZEC, minus the conversion fee). The two payout network fees come out of
 * the ZEC unless Zeep covers them (first withdrawal of the day).
 */
export function withdrawalAmounts(zecZats: number, usdMicro: number, networkFeeZats: number, zeepPaysNetwork: boolean) {
  const conversionFee = usdMicro > 0 ? bpsOf(usdMicro, cfg.WITHDRAWAL_FEE_BPS) : 0;
  const userNetworkZats = zeepPaysNetwork ? 0 : networkFeeZats;
  return { zecZats, usdMicro, conversionFee, convert: usdMicro - conversionFee, userNetworkZats, zecNow: zecZats - userNetworkZats };
}

async function intentStatus(id: string) {
  const [i] = await q<{
    status: string; address: string; expected_zats: string | null; amount_zats: string | null; zec_usd: string | null;
    zec_kept_zats: string | null; converted_zats: string | null; zec_leaf_index: number | null;
    value_micro_usd: string | null; fee_micro_usd: string | null; rebate_micro_usd: string; credited_micro_usd: string | null;
    rebate_eligible: boolean; tree_id: number | null; leaf_index: number | null; expires_at: Date;
  }>('SELECT * FROM deposit_intents WHERE id = $1', [id]);
  if (!i) return undefined;
  const pending = await q<{ amount_zats: string; confirmations: number }>(
    `SELECT s.amount_zats, s.confirmations FROM deposit_sightings s
      WHERE s.intent_id = $1 AND NOT EXISTS (SELECT 1 FROM deposits d WHERE d.txid_hash = s.txid_hash)`, [id]);
  const [u] = await q<{ z: string }>(`SELECT COALESCE(SUM(amount_zats),0) AS z FROM deposits WHERE intent_id = $1 AND status = 'unclaimed'`, [id]);
  return {
    intent_id: id,
    status: i.status === 'credited' ? 'credited' : pending.length ? 'confirming' : i.expires_at < new Date() ? 'expired' : 'waiting',
    address: i.address,
    expected_zats: i.expected_zats == null ? null : Number(i.expected_zats),
    first_today: i.rebate_eligible,
    credited: i.status === 'credited'
      ? {
          zec_zats: Number(i.amount_zats), // received
          zec_usd: Number(i.zec_usd),
          tree: i.tree_id,
          // Kept as ZEC (the user's ZEC note; its value moves with ZEC's price).
          zec: { amount_zats: Number(i.zec_kept_zats), index: i.zec_leaf_index },
          // Converted to dollars (the user's dollar note).
          usd: {
            converted_zats: Number(i.converted_zats),
            value_micro_usd: Number(i.value_micro_usd),
            fee_micro_usd: Number(i.fee_micro_usd),
            rebate_micro_usd: Number(i.rebate_micro_usd),
            amount_micro_usd: Number(i.credited_micro_usd),
            index: i.leaf_index,
          },
        }
      : null,
    confirming: pending.map((p) => ({ amount_zats: Number(p.amount_zats), confirmations: p.confirmations, needed: Number(process.env.MIN_CONFIRMATIONS ?? 3) })),
    unclaimed_zats: Number(u.z),
    expires_at: i.expires_at.toISOString(),
  };
}

export default async function moneyRoutes(app: FastifyInstance) {
  app.get('/v1/fees', async () => feeSheet());

  // ---------- deposits ----------
  const Intent = z.object({
    intent_id: z.string().regex(INTENT, 'intent_id must be 64 hex chars'),
    d: z.string(), // dollar note owner tag
    d_zec: z.string(), // ZEC note owner tag
    expected_zats: z.number().int().positive().max(21e14).optional(),
    claim_from: z.string().regex(INTENT).optional(), // move unclaimed funds from an older intent
    proof: z.unknown().optional(), // daily tag proof (purpose 2): first deposit today gets its fee back
  });

  /** Reserve a fresh deposit address for one note. Idempotent on intent_id. */
  app.post('/v1/deposits', async (req, reply) => {
    const b = Intent.safeParse(req.body);
    if (!b.success) throw errors.bad(b.error.issues[0]?.message ?? 'invalid deposit request');
    let d: bigint;
    let dZec: bigint;
    try {
      d = toField(b.data.d);
      dZec = toField(b.data.d_zec);
    } catch {
      throw errors.bad('d and d_zec must be field elements');
    }
    if (d === dZec) throw errors.bad('d and d_zec must differ');
    const id = b.data.intent_id;
    const existing = await intentStatus(id);
    if (existing) return existing;

    let firstToday = false;
    if (b.data.proof !== undefined) {
      // A zero-value spend that only reveals today's deposit tag; it moves no money.
      const s = await spend({ bundle: parseBundle(b.data.proof), asset: 'any', signal: depositSignal(id, d), exactCost: 0n, book: null, daily: 2 });
      firstToday = s.firstToday;
    }

    await tx(async (c) => {
      const a = await c.query<{ address: string }>(
        `UPDATE deposit_addresses SET intent_id = $1
          WHERE diversifier_index = (SELECT diversifier_index FROM deposit_addresses WHERE intent_id IS NULL
                                     ORDER BY diversifier_index LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING address`, [id]);
      if (!a.rows[0]) throw new ZeepError(503, 'no_address', 'no deposit address is ready yet; try again in a minute');
      await c.query(
        `INSERT INTO deposit_intents (id, d, d_zec, address, expected_zats, rebate_eligible, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(hours => $7))`,
        [id, d.toString(), dZec.toString(), a.rows[0].address, b.data.expected_zats ?? null, firstToday, cfg.DEPOSIT_INTENT_TTL_HOURS]);
      if (b.data.claim_from) {
        const moved = await c.query(
          `UPDATE deposits SET status = 'claimed', claimed_by = $2 WHERE intent_id = $1 AND status = 'unclaimed' RETURNING amount_zats, txid_hash, block_height`,
          [b.data.claim_from, id]);
        for (const m of moved.rows) {
          await c.query(`INSERT INTO deposits (txid_hash, intent_id, amount_zats, block_height, status) VALUES ($1, $2, $3, $4, 'confirmed')`,
            [`claim:${m.txid_hash}`, id, m.amount_zats, m.block_height]);
        }
      }
    });
    reply.code(201);
    return intentStatus(id);
  });

  app.get<{ Params: { id: string } }>('/v1/deposits/:id', async (req) => {
    if (!INTENT.test(req.params.id)) throw errors.notFound();
    const s = await intentStatus(req.params.id);
    if (!s) throw errors.notFound('deposit not found');
    return s;
  });

  // ---------- conversions: ZEC note → dollar note (the client's refills) ----------
  const Convert = z.object({
    conversion_id: z.string().regex(UUID, 'conversion_id must be a random v4 UUID'),
    // The new dollar note. The client proposes its amount (from /v1/prices) so its encrypted
    // backup holds the exact amount; the server accepts it if it's within the quote tolerance.
    mint: z.object({
      d: z.string(),
      e: z.string().regex(/^[A-Za-z0-9+/=_-]{16,160}$/).nullable().default(null),
      amount_micro_usd: z.number().int().positive(),
    }),
    proof: z.unknown(),
  });

  /**
   * Burn `cost` zats of ZEC notes and mint a dollar note worth at most cost × price − the
   * conversion fee, at the live price. The proof's signal binds the conversion id and the new
   * note's owner tag; the amount is bound by the note commitment itself.
   */
  app.post('/v1/convert/to-usd', async (req, reply) => {
    const b = Convert.safeParse(req.body);
    if (!b.success) throw errors.bad(b.error.issues[0]?.message ?? 'invalid conversion');
    let d: bigint;
    try {
      d = toField(b.data.mint.d);
    } catch {
      throw errors.bad('mint.d must be a field element');
    }
    const bundle = parseBundle(b.data.proof);
    if (bundle.cost < BigInt(cfg.MIN_CONVERT_ZATS)) throw errors.bad(`conversions must be at least ${cfg.MIN_CONVERT_ZATS} zats`);
    const px = (await zecQuotes()).current.usd;
    const value = zatsToMicroUsd(Number(bundle.cost), px);
    const max = value - bpsOf(value, cfg.DEPOSIT_FEE_BPS);
    const amount = b.data.mint.amount_micro_usd;
    if (amount > max || amount < max - bpsOf(max, cfg.CONVERT_QUOTE_TOLERANCE_BPS)) {
      throw new ZeepError(409, 'price_moved', 'the ZEC price changed; refresh prices and try again', { zec_usd: px, amount_micro_usd: max });
    }
    const fee = value - amount; // the conversion fee, plus any quote slack the client left
    const { spent, minted } = await spendAll(
      [{ bundle, asset: ZEC, signal: convertSignal(b.data.conversion_id.toLowerCase(), d), book: 'zec_to_usd' }],
      async (c) => {
        await addBooks(c, 'usd_from_zec', amount);
        await addBooks(c, 'conversion_fee', fee);
        return [{ commitment: mintedLeaf(d, BigInt(amount), USD), enc: b.data.mint.e }];
      },
    );
    await redis.del(keys.reserve);
    reply.header('x-zeep-notes', notesHeader(spent[0].notes));
    reply.code(201);
    return {
      conversion_id: b.data.conversion_id.toLowerCase(),
      zec_zats: Number(bundle.cost),
      zec_usd: px,
      value_micro_usd: value,
      fee_micro_usd: fee,
      amount_micro_usd: amount,
      minted: { tree: minted!.tree, index: minted!.indexes[0] },
      notes: spent[0].notes,
    };
  });

  // ---------- withdrawals ----------
  // ZEC notes are paid out as they are. If the user wants more than their ZEC balance, the app
  // asks them to confirm converting credits (dollar notes) back to ZEC, and sends both proofs.
  const Withdraw = z.object({
    withdrawal_id: z.string().regex(UUID, 'withdrawal_id must be a random v4 UUID'),
    payout_address: z.string().min(10).max(1100),
    allow_transparent: z.boolean().default(false),
    zec_proof: z.unknown().optional(), // asset 1: zats from ZEC notes
    usd_proof: z.unknown().optional(), // asset 0: micro-USD from dollar notes, converted to ZEC
  });

  app.post('/v1/withdrawals', async (req, reply) => {
    const b = Withdraw.safeParse(req.body);
    if (!b.success) throw errors.bad(b.error.issues[0]?.message ?? 'invalid withdrawal');
    const id = b.data.withdrawal_id.toLowerCase();
    const addr = b.data.payout_address;
    if (!validPayoutAddress(addr, b.data.allow_transparent)) {
      throw errors.bad(isTransparent(addr)
        ? 'this is a transparent address; set allow_transparent: true to confirm (amount and recipient become public)'
        : `payout_address must be a ${cfg.ZCASH_NETWORK}net Zcash address`);
    }
    if (b.data.zec_proof === undefined && b.data.usd_proof === undefined) throw errors.bad('send zec_proof, usd_proof or both');
    const transparent = isTransparent(addr);
    const zb = b.data.zec_proof === undefined ? undefined : parseBundle(b.data.zec_proof);
    const ub = b.data.usd_proof === undefined ? undefined : parseBundle(b.data.usd_proof);
    const zecZats = Number(zb?.cost ?? 0n);
    const usdMicro = Number(ub?.cost ?? 0n);
    const px = (await zecQuotes()).current.usd;
    const total = zatsToMicroUsd(zecZats, px) + usdMicro;
    if (total < cfg.MIN_WITHDRAWAL_MICRO_USD) throw errors.bad(`withdrawals must be worth at least ${cfg.MIN_WITHDRAWAL_MICRO_USD} micro-USD`);
    if (ub && usdMicro < cfg.MIN_WITHDRAWAL_MICRO_USD) throw errors.bad(`the credits converted back must be at least ${cfg.MIN_WITHDRAWAL_MICRO_USD} micro-USD`);
    if ((await q('SELECT 1 FROM withdrawals WHERE id = $1', [id])).length) throw errors.tagUsed();
    const networkZats = 2 * cfg.REFUND_NETWORK_FEE_ZATS;
    const networkMicro = zatsToMicroUsd(networkZats, px);

    // The first proof carries today's withdrawal tag; a second one uses a random tag.
    const signal = withdrawSignal(id, addr);
    const list: SpendOpts[] = [];
    if (zb) list.push({ bundle: zb, asset: ZEC, signal, exactCost: zb.cost, book: 'zec_withdrawal', daily: 1 });
    if (ub) list.push({ bundle: ub, asset: USD, signal, exactCost: ub.cost, book: 'withdrawal', daily: zb ? undefined : 1 });

    let amt!: ReturnType<typeof withdrawalAmounts> & { zeepPays: boolean };
    const { spent } = await spendAll(list, async (c, meta) => {
      const zeepPays = meta[0].firstToday && total >= cfg.FREE_FEE_MIN_MICRO_USD && (await takeSubsidy(c, networkMicro));
      amt = { ...withdrawalAmounts(zecZats, usdMicro, networkZats, zeepPays), zeepPays };
      if (!ub && amt.zecNow <= 0) throw errors.bad('amount is too small to cover the network fees');
      await c.query(
        `INSERT INTO withdrawals (id, zec_zats, gross_micro_usd, fee_micro_usd, convert_micro_usd, network_fee_zats, network_fee_paid_by,
                                  transparent, payout_addr_enc, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, zecZats, usdMicro, amt.conversionFee, amt.convert, amt.userNetworkZats, zeepPays ? 'zeep' : 'user',
          transparent, encryptAddr(addr), ub ? 'converting' : 'scheduled']);
      if (amt.conversionFee) await addBooks(c, 'conversion_fee', amt.conversionFee);
      // ZEC only: paid straight from the shielded reserve.
      if (!ub) await scheduleTranches(c, id, amt.zecNow, null);
    });
    await redis.del(keys.reserve);

    const notes = { zec: zb ? spent[0].notes : null, usd: ub ? spent[zb ? 1 : 0].notes : null };
    reply.code(201);
    return {
      withdrawal_id: id,
      zec_zats: zecZats,
      usd_micro_usd: usdMicro,
      conversion_fee_micro_usd: amt.conversionFee,
      network_fee_zats: amt.userNetworkZats,
      network_fees_paid_by: amt.zeepPays ? 'zeep' : 'you',
      // Exact for ZEC only; with credits converted, the final amount depends on the conversion.
      estimated_zec_zats: amt.zecNow + (ub ? microUsdToZats(amt.convert, px) : 0),
      transparent,
      warning: transparent ? TRANSPARENT_WARNING : undefined,
      status: ub ? 'converting' : 'scheduled',
      processing: ub ? { converting: true, message: CONVERTING_MESSAGE } : { converting: false },
      notes,
    };
  });

  app.get<{ Params: { id: string } }>('/v1/withdrawals/:id', async (req) => {
    if (!UUID.test(req.params.id)) throw errors.notFound();
    const id = req.params.id.toLowerCase();
    const [w] = await q<{
      status: string; zec_zats: string; gross_micro_usd: string; fee_micro_usd: string; network_fee_zats: string; network_fee_paid_by: string;
      transparent: boolean; zec_received: string | null;
    }>(`SELECT status, zec_zats, gross_micro_usd, fee_micro_usd, network_fee_zats, network_fee_paid_by, transparent, zec_received
          FROM withdrawals WHERE id = $1`, [id]);
    if (!w) throw errors.notFound('withdrawal not found');
    const p = await q<{ tranche: number; amount_zats: string; scheduled_at: Date; status: string; txid: string | null }>(
      'SELECT tranche, amount_zats, scheduled_at, status, txid FROM payouts WHERE withdrawal_id = $1 ORDER BY tranche', [id]);
    const converting = w.status === 'converting';
    return {
      withdrawal_id: id,
      status: w.status === 'scheduled' && p.some((x) => x.status !== 'scheduled') ? 'paying' : w.status,
      message: converting ? CONVERTING_MESSAGE : undefined,
      zec_zats: Number(w.zec_zats),
      usd_micro_usd: Number(w.gross_micro_usd),
      conversion_fee_micro_usd: Number(w.fee_micro_usd),
      network_fee_zats: Number(w.network_fee_zats),
      network_fees_paid_by: w.network_fee_paid_by === 'zeep' ? 'zeep' : 'you',
      zec_received_zats: w.zec_received == null ? null : Number(w.zec_received),
      transparent: w.transparent,
      tranches: p.map((x) => ({
        tranche: x.tranche,
        amount_zats: Number(x.amount_zats),
        eta: x.scheduled_at.toISOString(),
        status: x.status === 'stuck' ? 'sending' : x.status,
        txid: x.txid,
      })),
    };
  });

  // ---------- note management: merge, split, fund an agent (cost 0) ----------
  app.post('/v1/notes/spend', async (req, reply) => {
    const raw = (req.body as { proof?: unknown } | undefined)?.proof;
    const bundle = raw !== undefined ? parseBundle(raw) : bundleFromHeaders(req.headers);
    const s = await spend({ bundle, asset: 'any', signal: notesSignal(), exactCost: 0n, book: null });
    reply.header('x-zeep-notes', notesHeader(s.notes));
    reply.code(201);
    return { notes: s.notes };
  });
}
