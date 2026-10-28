// The note trees. The current (open) tree lives in memory on every web dyno, rebuilt
// from Postgres on boot and kept in sync through the `zeep:notes` pub/sub channel.
// Closed trees are not kept in memory: only their final roots, which stay valid forever.
// Also hosts the deposit activator (confirmed deposit → note leaf).
import { poseidon3 } from 'poseidon-lite';
import { cfg } from '../config.js';
import { pool, reloadPool, tx, type Tx } from '../lib/db.js';
import { log } from '../lib/log.js';
import { keys, newRedis, redis, withLock } from '../lib/redis.js';
import { addBooks } from '../services/books.js';
import { bpsOf, takeSubsidy } from '../services/fees.js';
import { moneyQuote, zatsToMicroUsd } from '../services/prices.js';
import { MerkleTree } from './tree.js';

const CHANNEL = keys.notesChannel;

export interface Leaf {
  commitment: bigint;
  enc: string | null;
}
export interface Appended {
  tree: number;
  indexes: number[];
  root: string;
}

type Msg =
  | { op: 'append'; tree: number; from: number; leaves: string[]; root: string }
  | { op: 'rotate'; closed: number; finalRoot: string; opened: number };

interface Current {
  id: number;
  tree: MerkleTree;
  roots: string[]; // accepted, oldest first
}

class Registry {
  private cur!: Current;
  private closed = new Map<string, number>(); // final root → tree id
  private sub = newRedis();
  private timers: NodeJS.Timeout[] = [];
  private mu: Promise<unknown> = Promise.resolve();

  /** Appends, reloads and sync messages run one at a time on this dyno. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mu.then(fn, fn);
    this.mu = run.catch(() => {});
    return run;
  }

  async boot(): Promise<void> {
    await this.reload(reloadPool);
    await this.sub.subscribe(CHANNEL);
    this.sub.on('message', (_c, m) => this.locked(() => this.onMessage(JSON.parse(m) as Msg)).catch((e) => log.error({ err: e }, 'note sync')));
    // Messages lost while Redis reconnects are never replayed: reload on reconnect, and check
    // against Postgres every 30 s so a quiet dyno can't keep stale roots.
    this.sub.on('ready', () => this.resync().catch(() => {}));
    this.timers.push(setInterval(() => this.catchUp().catch((e) => log.warn({ err: (e as Error).message }, 'note catch-up')), 30_000));
  }

  private async catchUp(): Promise<void> {
    const t = await pool.query<{ id: number; size: number }>('SELECT id, size FROM trees WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1');
    // Only when Postgres is AHEAD (another dyno's append we missed). Memory ahead of Postgres
    // just means a local append hasn't committed yet: leave it alone.
    const row = t.rows[0];
    if (row && (row.id > this.cur.id || (row.id === this.cur.id && row.size > this.cur.tree.size))) await this.resync();
  }

  /**
   * Like treeOf, but on a miss checks Postgres: if the root is NEWER than this dyno's tree
   * (another dyno appended and the message hasn't arrived yet), catch up. Old or unknown
   * roots are rejected without reloading, so requests can't force expensive reloads.
   */
  async acceptRoot(root: string): Promise<number | undefined> {
    const hit = this.treeOf(root);
    if (hit !== undefined) return hit;
    const r = await pool.query<{ tree_id: number; leaf_count: number }>('SELECT tree_id, leaf_count FROM roots WHERE root = $1 LIMIT 1', [root]);
    const row = r.rows[0];
    if (!row) return undefined;
    const behind = row.tree_id > this.cur.id || (row.tree_id === this.cur.id && row.leaf_count > this.cur.tree.size);
    if (!behind) return undefined;
    await this.resync();
    return this.treeOf(root);
  }

  async close(): Promise<void> {
    this.timers.forEach(clearInterval);
    await this.activatorRun?.catch(() => {}); // let an in-flight credit finish before the pools close
    await this.sub.quit().catch(() => {});
    await reloadPool.end().catch(() => {});
  }

  current() {
    return { id: this.cur.id, size: this.cur.tree.size, root: this.cur.tree.root().toString(), roots: this.cur.roots };
  }

  closedTrees(): { id: number; finalRoot: string }[] {
    return [...this.closed].map(([finalRoot, id]) => ({ id, finalRoot }));
  }

  /** Tree id a root belongs to, if the root is accepted for spending. */
  treeOf(root: string): number | undefined {
    if (this.cur.roots.includes(root)) return this.cur.id;
    return this.closed.get(root);
  }

  private async reload(c: Pick<Tx, 'query'>): Promise<void> {
    const t0 = Date.now();
    let open = await c.query<{ id: number }>('SELECT id FROM trees WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1');
    if (!open.rows[0]) open = await c.query<{ id: number }>('INSERT INTO trees DEFAULT VALUES RETURNING id');
    const id = open.rows[0].id;
    const leaves = await c.query<{ commitment: string }>(
      'SELECT commitment FROM notes WHERE tree_id = $1 ORDER BY leaf_index', [id]);
    const tree = new MerkleTree(cfg.NOTE_TREE_DEPTH);
    tree.load(leaves.rows.map((r) => BigInt(r.commitment)));
    const r = await c.query<{ root: string }>(
      'SELECT root FROM roots WHERE tree_id = $1 ORDER BY created_at DESC, leaf_count DESC LIMIT $2', [id, cfg.NOTE_ROOT_HISTORY]);
    const roots = r.rows.map((x) => x.root).reverse();
    const root = tree.root().toString();
    if (roots.length && roots[roots.length - 1] !== root) log.error({ tree: id }, 'rebuilt root does not match the latest stored root');
    if (!roots.includes(root)) roots.push(root);
    this.cur = { id, tree, roots };
    const closed = await c.query<{ id: number; final_root: string }>('SELECT id, final_root FROM trees WHERE closed_at IS NOT NULL');
    this.closed = new Map(closed.rows.map((x) => [x.final_root, x.id]));
    log.info({ tree: id, notes: tree.size, closed: this.closed.size, ms: Date.now() - t0 }, 'note tree loaded');
  }

  private pushRoot(root: string) {
    if (!this.cur.roots.includes(root)) this.cur.roots.push(root);
    while (this.cur.roots.length > cfg.NOTE_ROOT_HISTORY) this.cur.roots.shift();
  }

  private async onMessage(m: Msg): Promise<void> {
    if (m.op === 'rotate') {
      this.closed.set(m.finalRoot, m.closed);
      if (this.cur.id !== m.opened) await this.reload(reloadPool);
      return;
    }
    if (m.tree !== this.cur.id) return this.reload(reloadPool);
    const t = this.cur.tree;
    if (t.size === m.from + m.leaves.length && t.root().toString() === m.root) return this.pushRoot(m.root); // ours
    if (t.size !== m.from) return this.reload(reloadPool);
    m.leaves.forEach((l, i) => t.set(m.from + i, BigInt(l)));
    if (t.root().toString() !== m.root) return this.reload(reloadPool);
    this.pushRoot(m.root);
  }

  /**
   * Append leaves inside the caller's transaction. Holds the tree lock until commit.
   * Call `publish()` after COMMIT, or `resync()` after a ROLLBACK.
   */
  async appendInTx(c: Tx, leaves: Leaf[]): Promise<{ result: Appended; publish: () => Promise<void> }> {
    return this.locked(() => this.appendLocked(c, leaves));
  }

  private async appendLocked(c: Tx, leaves: Leaf[]): Promise<{ result: Appended; publish: () => Promise<void> }> {
    await c.query('SELECT pg_advisory_xact_lock(727600)');
    const t = await c.query<{ id: number; size: number }>('SELECT id, size FROM trees WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1');
    if (!t.rows[0] || t.rows[0].id !== this.cur.id || t.rows[0].size !== this.cur.tree.size) await this.reload(c);
    const msgs: Msg[] = [];
    if (this.cur.tree.size + leaves.length > this.cur.tree.capacity) {
      const finalRoot = this.cur.tree.root().toString();
      await c.query('UPDATE trees SET closed_at = now(), final_root = $2 WHERE id = $1', [this.cur.id, finalRoot]);
      const n = await c.query<{ id: number }>('INSERT INTO trees DEFAULT VALUES RETURNING id');
      msgs.push({ op: 'rotate', closed: this.cur.id, finalRoot, opened: n.rows[0].id });
      this.closed.set(finalRoot, this.cur.id);
      this.cur = { id: n.rows[0].id, tree: new MerkleTree(cfg.NOTE_TREE_DEPTH), roots: [] };
      this.pushRoot(this.cur.tree.root().toString());
    }
    const from = this.cur.tree.size;
    const indexes: number[] = [];
    for (const l of leaves) {
      const { index } = this.cur.tree.append(l.commitment);
      indexes.push(index);
      await c.query('INSERT INTO notes (tree_id, leaf_index, commitment, enc) VALUES ($1, $2, $3, $4)',
        [this.cur.id, index, l.commitment.toString(), l.enc]);
    }
    const root = this.cur.tree.root().toString();
    await c.query('UPDATE trees SET size = $2 WHERE id = $1', [this.cur.id, this.cur.tree.size]);
    await c.query('INSERT INTO roots (tree_id, root, leaf_count) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [this.cur.id, root, this.cur.tree.size]);
    this.pushRoot(root);
    msgs.push({ op: 'append', tree: this.cur.id, from, leaves: leaves.map((l) => l.commitment.toString()), root });
    return {
      result: { tree: this.cur.id, indexes, root },
      // Runs after COMMIT: the money already moved, so a Redis hiccup must never fail the
      // request. Other dynos catch up through their periodic root check (see treeOf / refresh).
      publish: async () => {
        for (const m of msgs) await redis.publish(CHANNEL, JSON.stringify(m)).catch((e) => log.warn({ err: (e as Error).message }, 'note publish failed'));
      },
    };
  }

  /** After a rolled-back append the in-memory tree may hold leaves that never committed. */
  /** Concurrent callers share one reload. Uses its own connection (see reloadPool). */
  private pendingResync: Promise<void> | null = null;
  async resync(): Promise<void> {
    this.pendingResync ??= this.locked(() => this.reload(reloadPool)).finally(() => (this.pendingResync = null));
    return this.pendingResync;
  }

  /**
   * Turn confirmed ZEC deposits into two notes each (one dyno at a time):
   *   ZEC note    = ZEC_SHARE_BPS of the zats, kept as ZEC     leaf Poseidon(d_zec, zats, 1)
   *                 (0 for a deposit worth less than ALL_CREDITS_BELOW_MICRO_USD: all credits)
   *   dollar note = the rest × price − conversion fee (+ rebate) leaf Poseidon(d, micro-USD, 0)
   */
  async creditDeposits(): Promise<number> {
    let credited = 0;
    // Credit only at a live price, fetched BEFORE locking any rows; without one, wait.
    const waiting = await pool.query(`SELECT 1 FROM deposits WHERE status = 'confirmed' LIMIT 1`);
    if (!waiting.rowCount) return 0;
    let px: number;
    try {
      px = (await moneyQuote()).usd;
    } catch {
      log.warn('no live ZEC price; deposits wait');
      return 0;
    }
    let publish: (() => Promise<void>) | undefined;
    try {
      await tx(async (c) => {
        const due = await c.query<{ id: string; intent_id: string; amount_zats: string; d: string; d_zec: string; status: string; rebate_eligible: boolean }>(
          `SELECT dp.id, dp.intent_id, dp.amount_zats, i.d, i.d_zec, i.status, i.rebate_eligible
             FROM deposits dp JOIN deposit_intents i ON i.id = dp.intent_id
            WHERE dp.status = 'confirmed' ORDER BY dp.id LIMIT 200 FOR UPDATE OF dp, i SKIP LOCKED`,
        );
        let cap = Infinity;
        const dailyCap = cfg.MAX_DEPOSIT_ZATS_PER_DAY ?? (cfg.ZEEP_ENV === 'testnet' ? cfg.TESTNET_MAX_DEPOSIT_ZATS_PER_DAY : undefined);
        if (dailyCap !== undefined) {
          const [{ z }] = (await c.query<{ z: string }>(
            `SELECT COALESCE(SUM(amount_zats),0) AS z FROM deposits WHERE status = 'credited' AND credited_on = CURRENT_DATE`)).rows;
          cap = dailyCap - Number(z);
        }
        if (!due.rows.length) return;
        const netFee = zatsToMicroUsd(cfg.REFUND_NETWORK_FEE_ZATS, px);
        const done = new Set<string>(); // an intent becomes exactly one pair of notes
        const leaves: Leaf[] = [];
        const rows: (typeof due.rows[number] & { kept: number; converted: number; value: number; fee: number; rebate: number; credit: number })[] = [];
        for (const r of due.rows) {
          if (r.status === 'credited' || done.has(r.intent_id)) {
            // A second payment to an already-credited address: hold it for a claim.
            await c.query(`UPDATE deposits SET status = 'unclaimed' WHERE id = $1`, [r.id]);
            continue;
          }
          const zats = Number(r.amount_zats);
          // Daily cap: wait for the next UTC day. A single deposit larger than the whole cap is
          // credited alone on a day with nothing else credited, so it can never be stuck forever.
          if (zats > cap && !(dailyCap !== undefined && zats > dailyCap && cap === dailyCap)) continue;
          cap -= zats;
          done.add(r.intent_id);
          // Worth less than ALL_CREDITS_BELOW_MICRO_USD at today's price: all of it becomes credits.
          const small = zatsToMicroUsd(zats, px) < cfg.ALL_CREDITS_BELOW_MICRO_USD;
          const kept = small ? 0 : Math.floor((zats * cfg.ZEC_SHARE_BPS) / 10_000);
          const converted = zats - kept;
          // The converted part at today's price, minus the conversion fee; the first deposit of
          // the user's day also gets their wallet's network fee back (if the budget allows).
          const value = zatsToMicroUsd(converted, px);
          const fee = bpsOf(value, cfg.DEPOSIT_FEE_BPS);
          const total = zatsToMicroUsd(zats, px);
          const rebate = r.rebate_eligible && total >= cfg.FREE_FEE_MIN_MICRO_USD && (await takeSubsidy(c, netFee)) ? netFee : 0;
          const credit = Math.max(0, value - fee + rebate);
          leaves.push({ commitment: poseidon3([BigInt(r.d), BigInt(credit), 0n]), enc: null });
          leaves.push({ commitment: poseidon3([BigInt(r.d_zec), BigInt(kept), 1n]), enc: null });
          rows.push({ ...r, kept, converted, value, fee, rebate, credit: credit });
          await addBooks(c, 'conversion_fee', Math.min(fee, value));
        }
        if (!leaves.length) return;
        const a = await this.appendInTx(c, leaves);
        publish = a.publish;
        for (const [i, r] of rows.entries()) {
          await c.query(`UPDATE deposits SET status = 'credited', credited_on = CURRENT_DATE WHERE id = $1`, [r.id]);
          await c.query(
            `UPDATE deposit_intents SET status = 'credited', tree_id = $2, leaf_index = $3, zec_leaf_index = $4, amount_zats = $5,
                    zec_kept_zats = $6, converted_zats = $7, zec_usd = $8, value_micro_usd = $9, fee_micro_usd = $10,
                    rebate_micro_usd = $11, credited_micro_usd = $12 WHERE id = $1`,
            [r.intent_id, a.result.tree, a.result.indexes[2 * i], a.result.indexes[2 * i + 1], r.amount_zats,
              r.kept, r.converted, px, r.value, r.fee, r.rebate, r.credit],
          );
          await addBooks(c, 'deposit', r.credit);
          await addBooks(c, 'zec_deposit', r.kept);
        }
        credited = rows.length;
      });
    } catch (e) {
      await this.resync();
      throw e;
    }
    await publish?.();
    return credited;
  }

  startActivator(everyMs = 3_000): void {
    const tick = () =>
      withLock('activator', async () => {
        const n = await this.creditDeposits();
        if (n) log.info({ credited: n }, 'deposits credited');
      });
    this.timers.push(setInterval(() => {
      if (this.activatorRun) return; // never overlap ticks
      this.activatorRun = tick().catch((e) => log.error({ err: e }, 'activator')).finally(() => (this.activatorRun = undefined));
    }, everyMs));
  }
  private activatorRun: Promise<unknown> | undefined;
}

export const registry = new Registry();
