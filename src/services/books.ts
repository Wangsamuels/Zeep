// Daily totals for the public reserve books (never one row per request).
import type { Tx } from '../lib/db.js';
import { pool } from '../lib/db.js';

// Units: micro-USD, except the zec_* kinds (ZEC notes) and to_tempo_zats / to_zec_zats
// (ZEC moved by conversions), which are zatoshis.
export type BookKind =
  | 'deposit'
  | 'usd_from_zec'
  | 'zec_deposit'
  | 'zec_withdrawal'
  | 'zec_to_usd'
  | 'service'
  | 'compensation'
  | 'withdrawal'
  | 'margin'
  | 'conversion_fee'
  | 'network_fee'
  | 'subsidy'
  | 'conversion_cost'
  | 'to_tempo_zats'
  | 'to_zec_zats';

export async function addBooks(c: Pick<Tx, 'query'> | null, kind: BookKind, amount: bigint | number): Promise<void> {
  await (c ?? pool).query(
    `INSERT INTO books_daily (day, kind, amount, count) VALUES (CURRENT_DATE, $1, $2, 1)
     ON CONFLICT (day, kind) DO UPDATE SET amount = books_daily.amount + $2, count = books_daily.count + 1`,
    [kind, Math.round(Number(amount)).toString()],
  );
}

/** Sum of each kind over all time (or the last `days`). */
export async function bookTotals(c: Pick<Tx, 'query'> = pool, days?: number): Promise<(k: BookKind) => number> {
  const r = await c.query<{ kind: string; a: string }>(
    `SELECT kind, COALESCE(SUM(amount),0) AS a FROM books_daily ${days ? 'WHERE day > CURRENT_DATE - $1::int' : ''} GROUP BY kind`,
    days ? [days] : []);
  return (k) => Number(r.rows.find((x) => x.kind === k)?.a ?? 0);
}
