// Release-phase entry point: apply pending SQL migrations and open the first note tree.
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg } from './config.js';
import { pool, tx } from './lib/db.js';
import { log } from './lib/log.js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = process.env.MIGRATIONS_DIR ?? join(here, '..', 'migrations');

export async function migrate(): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    await tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(727370)'); // serialise concurrent releases
      const done = await c.query('SELECT 1 FROM schema_migrations WHERE name = $1', [f]);
      if (done.rowCount) return;
      await c.query(await readFile(join(dir, f), 'utf8'));
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      log.info({ migration: f }, 'applied');
    });
  }
  await pool.query('INSERT INTO trees (size) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM trees)');
  await stampNetwork();
}

/** A database belongs to one network forever. Stamped on first migrate, checked on every boot. */
export async function stampNetwork(): Promise<void> {
  await pool.query(`INSERT INTO meta (key, value) VALUES ('network', $1) ON CONFLICT (key) DO NOTHING`, [cfg.ZEEP_ENV]);
  // Permanent salt for stored deposit hashes (never rotates, unlike secrets in config).
  await pool.query(`INSERT INTO meta (key, value) VALUES ('txid_salt', $1) ON CONFLICT (key) DO NOTHING`, [randomBytes(32).toString('hex')]);
  await checkDbNetwork();
}

export async function checkDbNetwork(): Promise<void> {
  const r = await pool.query<{ value: string }>(`SELECT value FROM meta WHERE key = 'network'`);
  const got = r.rows[0]?.value;
  if (got !== cfg.ZEEP_ENV) {
    throw new Error(got
      ? `This database belongs to ${got}; refusing to run ${cfg.ZEEP_ENV} on it. Use a separate Heroku app and database per network.`
      : 'Database has no network stamp; run the release phase (migrate) first.');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((e) => {
      // Plain text, flushed before exit (an async logger would lose it on process.exit).
      process.stderr.write(`migration failed: ${e instanceof Error ? e.message : String(e)}\n`, () => process.exit(1));
    });
}
