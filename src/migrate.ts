// Release-phase entry point: apply pending SQL migrations and open the first note tree.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((e) => {
      log.error({ err: e }, 'migration failed');
      process.exit(1);
    });
}
