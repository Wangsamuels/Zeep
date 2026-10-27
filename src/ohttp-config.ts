// Prints the PUBLIC OHTTP key config for the frontend (NEXT_PUBLIC_OHTTP_KEY_CONFIG).
//   heroku run -a <app> -- node dist/ohttp-config.js
// Reads OHTTP_PRIVATE_KEY from the environment and prints only the public half.
import { encodeKeyConfig, publicKeyOf, b64 } from './lib/ohttp.js';

const sk = process.env.OHTTP_PRIVATE_KEY?.trim();
const raw = sk ? Buffer.from(sk, 'base64') : Buffer.alloc(0);
if (raw.length !== 32) {
  process.stderr.write('OHTTP_PRIVATE_KEY is not set (or not 32 bytes of base64). Set it first:\n  heroku config:set -a <app> OHTTP_PRIVATE_KEY="$(openssl rand -base64 32)"\n');
  process.exit(1);
}
const id = Number(process.env.OHTTP_KEY_ID ?? 1);
process.stdout.write(`NEXT_PUBLIC_OHTTP_KEY_CONFIG=${b64(encodeKeyConfig(id, publicKeyOf(new Uint8Array(raw))))}\n`);
