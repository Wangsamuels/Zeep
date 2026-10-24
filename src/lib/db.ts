import pg from 'pg';
import { cfg, isProd } from '../config.js';

// NUMERIC/BIGINT come back as strings; keep them that way (zats can exceed 2^53 in sums).
const ssl = isProd || /sslmode=require/.test(cfg.DATABASE_URL) ? { rejectUnauthorized: false } : undefined; // Heroku TLS
export const pool = new pg.Pool({
  connectionString: cfg.DATABASE_URL,
  max: cfg.DB_POOL_MAX,
  ssl,
  connectionTimeoutMillis: 15_000, // fail a request instead of hanging forever when the pool is exhausted
});
/** One connection reserved for note-tree reloads, so a reload never waits behind spends that wait on it. */
export const reloadPool = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 1, ssl, connectionTimeoutMillis: 15_000 });

export type Tx = pg.PoolClient;

export async function tx<T>(fn: (c: Tx) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function q<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await pool.query<T>(text, params);
  return r.rows;
}
