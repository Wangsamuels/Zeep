import pg from 'pg';
import { cfg, isProd } from '../config.js';

// NUMERIC/BIGINT come back as strings; keep them that way (zats can exceed 2^53 in sums).
export const pool = new pg.Pool({
  connectionString: cfg.DATABASE_URL,
  max: cfg.DB_POOL_MAX,
  // Heroku Postgres requires TLS and uses certificates Node can't verify.
  ssl: isProd || /sslmode=require/.test(cfg.DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
});

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
