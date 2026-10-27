// Prints every config problem in plain text (never values): heroku run -a <app> -- node dist/doctor.js
import './lib/release-phase.js';
import { cfg, networkProblems } from './config.js';

const problems = networkProblems(cfg);
const out = problems.length
  ? `${cfg.ZEEP_ENV}: ${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}\n`
  : `${cfg.ZEEP_ENV}: config complete\n`;
process.stdout.write(out, () => process.exit(problems.length ? 1 : 0));
