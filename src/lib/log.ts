// App logger. Logs carry route, status and latency only — never bodies, proofs,
// tags, addresses or IPs. Anything that looks sensitive is redacted as a backstop.
import pino from 'pino';
import { cfg } from '../config.js';

export const log = pino({
  level: cfg.LOG_LEVEL,
  base: { env: cfg.ZEEP_ENV, dyno: process.env.DYNO },
  redact: {
    paths: [
      'req.headers', 'headers', 'body', 'proof', 'proofs', 'tag', 'tags',
      'payout_address', 'address', 'ip', 'ips', 'remoteAddress', '*.authorization',
    ],
    censor: '[redacted]',
  },
});
