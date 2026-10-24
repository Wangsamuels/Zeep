// Open routes: status, config, prices, note trees, public reserve books.
import type { FastifyInstance } from 'fastify';
import { cfg } from '../config.js';
import { q } from '../lib/db.js';
import { errors } from '../lib/errors.js';
import { sha256hex } from '../lib/field.js';
import { keys, redis } from '../lib/redis.js';
import { registry } from '../notes/registry.js';
import { priceSheet } from '../services/prices.js';
import { reserveBooks } from '../services/reserve.js';

export default async function publicRoutes(app: FastifyInstance) {
  app.get('/v1/status', async () => {
    const [height, w] = await Promise.all([
      redis.get(keys.chainHeight),
      q<{ scanned_height: number | null }>('SELECT scanned_height FROM wallet_state WHERE id = 1'),
    ]);
    const t = registry.current();
    return {
      ok: true,
      network: cfg.ZEEP_ENV,
      block_height: height ? Number(height) : null,
      scanned_height: w[0]?.scanned_height ?? null,
      notes: { tree: t.id, size: t.size },
      time: new Date().toISOString(),
    };
  });

  app.get('/v1/config', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=30');
    const t = registry.current();
    return {
      network: cfg.ZEEP_ENV,
      zcash_network: cfg.ZCASH_NETWORK,
      api_base_url: cfg.PUBLIC_API_BASE_URL,
      units: {
        // Two balances: dollar notes (asset 0, micro-USD) and ZEC notes (asset 1, zatoshis).
        // Credits are how the app shows their total dollar value (ZEC at the live price).
        assets: { usd: { id: 0, unit: 'micro_usd' }, zec: { id: 1, unit: 'zats' } },
        micro_usd_per_credit: cfg.MICRO_USD_PER_CREDIT,
        credits_per_usd: 1_000_000 / cfg.MICRO_USD_PER_CREDIT,
      },
      split: {
        // Each deposit: zec_share_bps stays ZEC, the rest becomes dollars.
        zec_share_bps: cfg.ZEC_SHARE_BPS,
        // Client-side refill of the dollar balance from the ZEC balance.
        refill: { at_bps: cfg.REFILL_AT_BPS, convert_bps: cfg.REFILL_BPS, final_stage: cfg.REFILL_FINAL_STAGE, min_zats: cfg.MIN_CONVERT_ZATS },
        conversion_fee_bps: { zec_to_usd: cfg.DEPOSIT_FEE_BPS, usd_to_zec: cfg.WITHDRAWAL_FEE_BPS },
      },
      deposits: {
        min_zats: cfg.MIN_DEPOSIT_ZATS,
        fee_bps: cfg.DEPOSIT_FEE_BPS, // on the converted (dollar) half only
        confirmations: Number(process.env.MIN_CONFIRMATIONS ?? 3),
        intent_ttl_hours: cfg.DEPOSIT_INTENT_TTL_HOURS,
        pow_bits: cfg.INTENT_POW_BITS, // sha256("zeep-intent-pow-v1:" + intent_id + ":" + pow) leading zero bits
      },
      nullifier_bucket_bits: cfg.NULLIFIER_BUCKET_BITS,
      withdrawals: {
        min_micro_usd: cfg.MIN_WITHDRAWAL_MICRO_USD,
        fee_bps: cfg.WITHDRAWAL_FEE_BPS,
        network_fee_zats_per_tranche: cfg.REFUND_NETWORK_FEE_ZATS,
        split_bps: cfg.REFUND_SPLIT_BPS,
        conversion_minutes: [20, 60],
        tranche_gap_sec: cfg.TRANCHE_GAP_SEC,
      },
      circuit: {
        name: 'zeep_spend',
        tree_depth: cfg.NOTE_TREE_DEPTH,
        wasm_url: cfg.SPEND_WASM_URL,
        zkey_url: cfg.SPEND_ZKEY_URL,
        zkey_sha256: cfg.SPEND_ZKEY_SHA256,
        vkey_url: cfg.SPEND_VKEY_URL,
        vkey_sha256: cfg.SPEND_VKEY_SHA256,
        signal: 'x = sha256("zeep-req-v2\\n" + METHOD + "\\n" + path + "\\n" + hex(sha256(raw body)) + "\\n" + refund_d) mod r  (refund_d = compensate.d, or 0)',
      },
      trees: {
        current: { id: t.id, size: t.size, root: t.root },
        closed: registry.closedTrees(),
      },
      vault: { max_item_kb: cfg.VAULT_MAX_ITEM_KB, max_items: cfg.VAULT_MAX_ITEMS },
    };
  });

  app.get('/v1/prices', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=30');
    return priceSheet();
  });

  /** Public leaf list, so clients build their own Merkle paths and never reveal which note is theirs. */
  app.get<{ Params: { id: string }; Querystring: { from?: string; limit?: string } }>('/v1/trees/:id/leaves', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw errors.notFound();
    const from = Math.max(0, Number(req.query.from ?? 0) | 0);
    const limit = Math.min(50_000, Math.max(1, Number(req.query.limit ?? 50_000) | 0));
    const [t] = await q<{ size: number; final_root: string | null }>('SELECT size, final_root FROM trees WHERE id = $1', [id]);
    if (!t) throw errors.notFound('unknown tree');
    const rows = await q<{ commitment: string; enc: string | null }>(
      'SELECT commitment, enc FROM notes WHERE tree_id = $1 AND leaf_index >= $2 ORDER BY leaf_index LIMIT $3', [id, from, limit]);
    reply.header('cache-control', t.final_root ? 'public, max-age=86400, immutable' : 'public, max-age=2');
    const cur = registry.current();
    return {
      tree: id,
      from,
      // c = commitment, e = encrypted backup (owner-readable only; null for deposit notes)
      leaves: rows.map((r) => ({ c: r.commitment, e: r.enc })),
      total: cur.id === id ? cur.size : t.size,
      root: cur.id === id ? cur.root : t.final_root,
      closed: Boolean(t.final_root),
    };
  });

  app.get<{ Params: { id: string } }>('/v1/trees/:id/root', async (req) => {
    const id = Number(req.params.id);
    const cur = registry.current();
    if (id === cur.id) return { tree: id, root: cur.root, size: cur.size, accepted_roots: cur.roots.slice().reverse() };
    const closed = registry.closedTrees().find((t) => t.id === id);
    if (!closed) throw errors.notFound('unknown tree');
    return { tree: id, root: closed.finalRoot, closed: true, accepted_roots: [closed.finalRoot] };
  });

  /**
   * Spent nullifiers by bucket (the top NULLIFIER_BUCKET_BITS bits). A client asks for the
   * buckets its notes fall in and checks locally, so the server never learns which exact
   * nullifiers (notes) it holds; each bucket is shared by many users' notes.
   */
  app.post('/v1/nullifiers/buckets', async (req) => {
    const list = (req.body as { buckets?: unknown })?.buckets;
    const max = 2 ** cfg.NULLIFIER_BUCKET_BITS;
    if (!Array.isArray(list) || list.length > 64 || !list.every((b) => Number.isInteger(b) && b >= 0 && b < max)) {
      throw errors.bad(`send { buckets: [integers below ${max}] } (max 64)`);
    }
    const shift = BigInt(254 - cfg.NULLIFIER_BUCKET_BITS);
    const out: Record<string, string[]> = {};
    for (const b of new Set(list as number[])) {
      const lo = BigInt(b) << shift;
      const hi = BigInt(b + 1) << shift;
      const rows = await q<{ n: string }>('SELECT nullifier::text AS n FROM nullifiers WHERE nullifier >= $1 AND nullifier < $2', [lo.toString(), hi.toString()]);
      out[b] = rows.map((r) => r.n);
    }
    return { bits: cfg.NULLIFIER_BUCKET_BITS, spent: out };
  });

  // Published at most every RESERVE_PUBLISH_SEC and rounded ($1, 0.01 ZEC), so nobody can
  // diff consecutive snapshots to read off a single deposit, refill or withdrawal.
  app.get('/v1/reserve', async (_req, reply) => {
    reply.header('cache-control', `public, max-age=${Math.min(cfg.RESERVE_PUBLISH_SEC, 600)}`);
    const cached = await redis.get(keys.reserve);
    if (cached) return JSON.parse(cached);
    const books = roundBooks(await reserveBooks()) as Record<string, unknown>;
    const body = { ...books, rounded: { micro_usd: 1_000_000, zats: 1_000_000 }, books_sha256: sha256hex(JSON.stringify(books)) };
    await redis.set(keys.reserve, JSON.stringify(body), 'EX', cfg.RESERVE_PUBLISH_SEC);
    return body;
  });
}

/** Round every *_micro_usd field to $1 and every *_zats field to 0.01 ZEC. Ratios stay exact. */
export function roundBooks(v: unknown, key = ''): unknown {
  if (Array.isArray(v)) return v.map((x) => roundBooks(x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, roundBooks(x, k)]));
  if (typeof v === 'number' && /(_micro_usd|_zats)$/.test(key)) return Math.round(v / 1_000_000) * 1_000_000;
  if (typeof v === 'number' && key === 'owed_credits') return Math.round(v);
  return v;
}
