// Imported first by every test file (ESM imports run before module code).
process.env.SPEND_VKEY_PATH ??= new URL('../circuits/zeep_spend_vkey.json', import.meta.url).pathname;
process.env.PAYOUT_ADDR_ENC_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.DATABASE_URL ??= 'postgres://zeep:zeep@localhost:5432/zeep';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.LOG_LEVEL ??= 'warn';
process.env.MPP_MODE ??= 'mock';
process.env.ZEC_USD_FALLBACK ??= '50';
