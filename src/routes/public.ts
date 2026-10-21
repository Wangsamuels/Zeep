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
      },
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
        signal: 'x = sha256("zeep-req-v1\\n" + METHOD + "\\n" + path + "\\n" + hex(sha256(raw body))) mod r',
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
   * Which of these nullifiers are spent? Used when restoring on a new device. Clients mix
   * in random decoys, and nothing is logged, but the query does tell the server that the
   * asker holds some of these notes; the app only calls it on restore and periodic sync.
   */
  app.post('/v1/nullifiers/check', async (req) => {
    const list = (req.body as { nullifiers?: unknown })?.nullifiers;
    if (!Array.isArray(list) || list.length > 1000 || !list.every((n) => typeof n === 'string' && /^[0-9]{1,78}$/.test(n))) {
      throw errors.bad('send { nullifiers: [decimal strings] } (max 1000)');
    }
    const rows = await q<{ nullifier: string }>('SELECT nullifier::text FROM nullifiers WHERE nullifier = ANY($1::numeric[])', [list]);
    const spent = new Set(rows.map((r) => r.nullifier));
    return { spent: list.map((n: string) => spent.has(BigInt(n).toString())) };
  });

  app.get('/v1/reserve', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=60');
    const cached = await redis.get(keys.reserve);
    if (cached) return JSON.parse(cached);
    const books = await reserveBooks();
    const body = { ...books, books_sha256: sha256hex(JSON.stringify(books)) };
    await redis.set(keys.reserve, JSON.stringify(body), 'EX', 60);
    return body;
  });
}
