// `treasury` process (1 dyno). BullMQ repeatable jobs, each under the treasury lock:
//   float        every FLOAT_TICK_SEC: convert deposited ZEC to USDC.e on Tempo, and each
//                withdrawal's dollars back to ZEC — see src/treasury/float.ts
//   reserve      every 10 min: coverage, hot-wallet cap and profit-floor alerts
//   housekeeping hourly: retention rules from the data model
import { Queue, Worker } from 'bullmq';
import { cfg } from '../config.js';
import { pool, q } from '../lib/db.js';
import { log } from '../lib/log.js';
import { checkRedisNetwork, keys, newRedis, redis, withLock } from '../lib/redis.js';
import { checkDbNetwork } from '../migrate.js';
import { refreshPrice } from '../services/prices.js';
import { reserveBooks } from '../services/reserve.js';
import { floatTick } from '../treasury/float.js';

const QUEUE = 'treasury';
const PREFIX = keys.queuePrefix;

export async function reserveCheck(): Promise<void> {
  const b = await reserveBooks();
  for (const [asset, bps] of [['zec', b.zec.coverage_bps], ['usd', b.usd.coverage_bps]] as const) {
    if (bps < cfg.RESERVE_COVERAGE_MIN_BPS) log.error({ asset, coverage_pct: bps / 100, zec: b.zec, usd: b.usd }, 'ALERT reserve below coverage floor');
  }
  if (b.zec.surplus_zats > cfg.RESERVE_HOT_CAP_ZATS) {
    log.error({ surplus: b.zec.surplus_zats, cap: cfg.RESERVE_HOT_CAP_ZATS }, 'ALERT unconverted ZEC piling up; is the float converting?');
  }
  if (b.profit.net_bps_of_volume != null && b.profit.net_bps_of_volume < cfg.PROFIT_FLOOR_BPS) {
    log.warn({ net_bps: b.profit.net_bps_of_volume }, 'profit below floor; covered fees pause until margin recovers');
  }
  const stuck = await q<{ n: string }>(`SELECT COUNT(*) AS n FROM payouts WHERE status IN ('stuck','failed')`);
  if (Number(stuck[0].n)) log.error({ count: Number(stuck[0].n) }, 'ALERT payouts need manual review');
  const failed = await q<{ n: string }>(`SELECT COUNT(*) AS n FROM conversions WHERE step = 'failed' AND updated_at > now() - interval '1 day'`);
  if (Number(failed[0].n)) log.error({ count: Number(failed[0].n) }, 'ALERT float conversions failed; check the conversions table');
}

/** Retention rules from the data model. */
export async function housekeeping(): Promise<void> {
  const r = await Promise.all([
    q(`DELETE FROM roots r WHERE r.created_at < now() - interval '1 day'
        AND r.root NOT IN (SELECT root FROM roots r2 WHERE r2.tree_id = r.tree_id ORDER BY created_at DESC LIMIT ${cfg.NOTE_ROOT_HISTORY}) RETURNING 1`),
    q(`DELETE FROM deposit_sightings s USING deposits d WHERE d.txid_hash = s.txid_hash RETURNING 1`),
    q(`UPDATE deposit_intents SET status = 'expired' WHERE status = 'open' AND expires_at < now()
        AND NOT EXISTS (SELECT 1 FROM deposit_sightings s WHERE s.intent_id = deposit_intents.id)
        AND NOT EXISTS (SELECT 1 FROM deposits d WHERE d.intent_id = deposit_intents.id AND d.status = 'confirmed') RETURNING 1`),
    q(`DELETE FROM daily_tags WHERE day < $1 RETURNING 1`, [Math.floor(Date.now() / 86_400_000) - 2]),
    q(`DELETE FROM inboxes WHERE expires_at < now() RETURNING 1`),
    q(`DELETE FROM vault_items WHERE expires_at IS NOT NULL AND expires_at < now() RETURNING 1`),
    // Only withdrawals whose tranches exist and are all confirmed; never one still converting.
    q(`UPDATE withdrawals w SET payout_addr_enc = NULL, status = 'done' WHERE payout_addr_enc IS NOT NULL
        AND w.status IN ('scheduled','paying','done')
        AND EXISTS (SELECT 1 FROM payouts p WHERE p.withdrawal_id = w.id)
        AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p.withdrawal_id = w.id AND p.status <> 'confirmed') RETURNING 1`),
    q(`DELETE FROM upstream_daily WHERE day < now() - interval '400 days' RETURNING 1`),
  ]);
  log.info({ changed: r.map((x) => x.length) }, 'housekeeping');
}

const handlers: Record<string, () => Promise<unknown>> = {
  prices: refreshPrice,
  float: floatTick,
  reserve: reserveCheck,
  housekeeping,
};

async function main() {
  await checkDbNetwork();
  await checkRedisNetwork();
  const connection = newRedis();
  const queue = new Queue(QUEUE, { connection, prefix: PREFIX });
  await queue.upsertJobScheduler('float', { every: cfg.FLOAT_TICK_SEC * 1000 }, { name: 'float' });
  await queue.upsertJobScheduler('reserve', { every: 10 * 60_000 }, { name: 'reserve' });
  await queue.upsertJobScheduler('housekeeping', { every: 60 * 60_000 }, { name: 'housekeeping' });
  await queue.upsertJobScheduler('prices', { every: Math.max(30, cfg.PRICE_REFRESH_SEC) * 1000 }, { name: 'prices' });

  const worker = new Worker(
    QUEUE,
    async (job) => {
      const fn = handlers[job.name];
      if (!fn) return;
      const ran = await withLock('treasury', async () => (await fn(), true), 120_000);
      if (!ran) log.warn({ job: job.name }, 'treasury lock busy; skipped');
    },
    { connection: newRedis(), prefix: PREFIX, concurrency: 1 },
  );
  worker.on('failed', (job, err) => log.error({ job: job?.name, err: err.message }, 'treasury job failed'));
  log.info({ float: cfg.FLOAT_MODE, rails: cfg.TREASURY_RAILS }, 'treasury worker started');

  const shutdown = async () => {
    await worker.close();
    await queue.close();
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    log.error({ err: e.message }, 'treasury boot failed');
    process.exit(1);
  });
}
