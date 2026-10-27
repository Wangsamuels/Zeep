// Heroku release phase (heroku.yml): apply migrations and stamp the database's network.
// It only needs DATABASE_URL and the network settings, so config can be changed in any order:
// a missing service key no longer fails the release and makes Heroku discard the change.
// Everything is printed as plain text and flushed before exiting, so `heroku releases:output`
// always shows why it failed.
import './lib/release-phase.js';
import { cfg, networkProblems } from './config.js';
import { pool } from './lib/db.js';
import { migrate } from './migrate.js';

const say = (s: string) => new Promise<void>((r) => process.stdout.write(s + '\n', () => r()));

async function main() {
  await say(`release: ${cfg.ZEEP_ENV} (${cfg.ZCASH_NETWORK}net), migrating…`);
  await migrate();
  await say('release: database migrated and stamped');
  const later = networkProblems(cfg);
  if (later.length) {
    await say('release: WARNING: web/treasury will refuse to start until these are fixed:');
    for (const p of later) await say(`  - ${p}`);
  } else {
    await say('release: config complete');
  }
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch(async (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    await new Promise<void>((r) => process.stderr.write(`release FAILED: ${msg}\n`, () => r()));
    await say(`release FAILED: ${msg}`);
    process.exit(1);
  });
