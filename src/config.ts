// Typed, validated view of every Heroku config var the Node processes read.
// Secrets are optional at parse time so each process only fails on the ones it uses
// (see `need()`); everything else has the defaults from the architecture doc.
import { z } from 'zod';

const bool = (d: boolean) =>
  z.enum(['true', 'false', '1', '0']).default(d ? 'true' : 'false').transform((v) => v === 'true' || v === '1');
const int = (d: number) => z.coerce.number().int().default(d);
const csv = (d = '') =>
  z.string().default(d).transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));
const json = <T extends z.ZodTypeAny>(schema: T, d: string) =>
  z.string().default(d).transform((v, ctx) => {
    try {
      return schema.parse(JSON.parse(v)) as z.infer<T>;
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: `invalid JSON: ${(e as Error).message}` });
      return z.NEVER;
    }
  });

const Env = z.object({
  // Heroku-provided
  DATABASE_URL: z.string().default('postgres://localhost:5432/zeep'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  PORT: int(3000),

  // App and networking
  NODE_ENV: z.string().default('development'),
  ZEEP_ENV: z.enum(['testnet', 'mainnet']).default('testnet'),
  LOG_LEVEL: z.string().default('info'),
  PUBLIC_API_BASE_URL: z.string().default('http://localhost:3000'),
  CORS_ALLOWED_ORIGINS: csv('http://localhost:3001'),
  RELAY_SHARED_SECRET: z.string().optional(),
  REQUIRE_RELAY: bool(false),
  // Oblivious HTTP: requests are encrypted to this key, so the relay sees only ciphertext.
  // 32 random bytes, base64 (openssl rand -base64 32). The public half goes in the frontend.
  OHTTP_PRIVATE_KEY: z.string().optional(),
  OHTTP_KEY_ID: z.coerce.number().int().min(0).max(255).default(1),
  // Optional: the previous key, accepted while users still have the old frontend loaded.
  OHTTP_PREVIOUS_PRIVATE_KEY: z.string().optional(),
  OHTTP_PREVIOUS_KEY_ID: z.coerce.number().int().min(0).max(255).default(0),
  // Refuse every API call that doesn't arrive through OHTTP (turn on once the frontend uses it).
  REQUIRE_OHTTP: bool(false),
  DB_POOL_MAX: int(10),
  REDIS_TLS_REJECT_UNAUTHORIZED: bool(false),
  STREAM_HEARTBEAT_SEC: int(15),
  UPSTREAM_TIMEOUT_MS: int(25_000),

  // Zcash (only the public parts are read by Node)
  ZCASH_NETWORK: z.enum(['main', 'test']).default('test'),
  ZEEP_RECEIVE_UA: z.string().default(''),
  RESERVE_HOT_CAP_ZATS: int(500_000_000),

  // Balances are fixed DOLLARS, held as micro-USD (1e-6 USD, the same precision as USDC).
  // A deposit is credited at the ZEC price when it confirms and the ZEC is converted to
  // USDC.e, so ZEC moving up or down never changes a balance or the reserve's coverage.
  // "Credits" are how the app shows dollars: MICRO_USD_PER_CREDIT (default 1 credit = $1).
  MICRO_USD_PER_CREDIT: int(1_000_000),
  MIN_DEPOSIT_ZATS: int(100_000),
  DEPOSIT_INTENT_TTL_HOURS: int(24), // an unpaid intent expires (its address is still watched 7 more days)
  ZEC_USD_FALLBACK: z.coerce.number().positive().default(50),
  PRICE_REFRESH_SEC: int(60), // the treasury refreshes the shared quote this often
  // Money operations (crediting deposits, refills, withdrawals) need a live quote no older than
  // this, and refuse to run on the fallback price unless ALLOW_PRICE_FALLBACK (testnet only).
  PRICE_MAX_AGE_SEC: int(120),
  ALLOW_PRICE_FALLBACK: bool(false),
  // Anti-spam for deposit intents (each one takes a deposit address): a proof of work of
  // INTENT_POW_BITS leading zero bits, and a cap on unpaid open intents.
  INTENT_POW_BITS: int(16),
  MAX_OPEN_INTENTS: int(20_000),
  // Spent-note lookups by bucket (top bits of the nullifier), so a client never sends its exact nullifiers.
  NULLIFIER_BUCKET_BITS: int(12),
  // The public reserve books are published at most this often, rounded, so single payments can't be read off them.
  RESERVE_PUBLISH_SEC: int(3600),
  ALLOW_NO_RELAY: bool(false),
  TESTNET_LIVE_MPP: bool(false),
  // Route prices in USD; charged in zats at the live ZEC price (NEAR Intents token feed).
  SERVICE_PRICES_USD_JSON: json(
    z.record(z.string(), z.number().nonnegative()),
    '{"search":0.01,"research_base":0.03,"research_core":0.06,"research_pro":0.20,"health":0.10,"inbox":2.00,"inbox_send":0.01,"email_send":0.025}',
  ),
  // Models shown in the picker, each with a per-response USD price.
  MODELS_JSON: json(
    z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        host: z.enum(['zeep', 'mpp']),
        usd: z.number().nonnegative(),
        vision: z.boolean().default(false),
        detail: z.string().default(''),
        upstream: z.string().optional(),
        testnet: z.boolean().default(true),
        // Metered models (MPP gateways price each request upfront from its text and its output
        // cap). With these set, a reply costs max(min_usd, input tokens × in + output cap × out),
        // and the output cap is enforced on the request Zeep forwards. Without them: flat `usd`.
        in_usd_per_m: z.number().nonnegative().optional(),
        out_usd_per_m: z.number().nonnegative().optional(),
        min_usd: z.number().nonnegative().default(0.012),
        default_output: z.number().int().positive().default(4096),
        max_output: z.number().int().positive().default(16_000),
        /** Context window in tokens (input + output): longer chats are refused before payment. */
        context: z.number().int().positive().default(128_000),
        gateway: z.enum(['openrouter', 'openai']).optional(),
      }),
    ),
    JSON.stringify([
      { id: 'gpt-oss-20b', name: 'GPT-OSS 20B', host: 'zeep', usd: 0.002, detail: 'Open weights, runs on Zeep' },
      { id: 'qwen3-vl-30b', name: 'Qwen3 VL 30B', host: 'zeep', usd: 0.003, vision: true, detail: 'Open weights, reads images' },
      { id: 'mistral-small-4', name: 'Mistral Small 4', host: 'zeep', usd: 0.002, detail: 'Open weights, fast' },
      { id: 'openai/gpt-5', name: 'GPT-5', host: 'mpp', usd: 0.04, vision: true, detail: 'Frontier, via MPP', testnet: false },
      { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', host: 'mpp', usd: 0.03, vision: true, detail: 'Frontier, via MPP', testnet: false },
      { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', host: 'mpp', usd: 0.03, vision: true, detail: 'Frontier, via MPP', testnet: false },
    ]),
  ),
  DEFAULT_MODEL: z.string().default('gpt-oss-20b'),
  // Attachments: the first 64 KB of a chat body is free, then this much per started MB.
  ATTACHMENT_USD_PER_MB: z.coerce.number().nonnegative().default(0.01),
  CHAT_MAX_BODY_MB: int(20),
  NOTE_TREE_DEPTH: int(20),
  NOTE_ROOT_HISTORY: int(200),
  SPEND_VKEY_URL: z.string().default(''),
  SPEND_VKEY_PATH: z.string().optional(), // local file alternative (dev / tests)
  SPEND_VKEY_SHA256: z.string().default(''),
  SPEND_WASM_URL: z.string().default('/circuits/zeep_spend.wasm'),
  SPEND_ZKEY_URL: z.string().default('/circuits/zeep_spend.zkey'),
  SPEND_ZKEY_SHA256: z.string().default(''),
  // Total ZEC credited per UTC day, on either network (later deposits wait for the next day).
  // A safety limit for launches; unset = no limit. TESTNET_MAX_DEPOSIT_ZATS_PER_DAY is the old name.
  MAX_DEPOSIT_ZATS_PER_DAY: z.coerce.number().int().positive().optional(),
  TESTNET_MAX_DEPOSIT_ZATS_PER_DAY: z.coerce.number().int().optional(),
  VAULT_MAX_ITEM_KB: int(512),
  VAULT_MAX_ITEMS: int(2000),

  // Two-asset balances. Each deposit is split: ZEC_SHARE_BPS stays as shielded ZEC owned by the
  // user (the user carries ZEC's price moves); the rest becomes fixed dollars (USDC.e).
  // Services are paid in dollars. When the dollar part falls to REFILL_AT_BPS of its last
  // top-up, the client converts REFILL_BPS of its ZEC to dollars; on stage REFILL_FINAL_STAGE
  // it converts all of it. The schedule runs client-side (the server never sees balances).
  ZEC_SHARE_BPS: int(5000),
  // Small deposits become credits only (no ZEC half): a deposit worth less than this would leave
  // a dollar half under the $5 convert-back minimum and a ZEC half too small to be useful.
  ALL_CREDITS_BELOW_MICRO_USD: int(10_000_000),
  REFILL_AT_BPS: int(500),
  REFILL_BPS: int(5000),
  REFILL_FINAL_STAGE: int(3),
  MIN_CONVERT_ZATS: int(10_000),
  CONVERT_QUOTE_TOLERANCE_BPS: int(100), // a refill's proposed amount may be up to 1% under the live quote

  // Fees.
  //  - Services: upstream price + PRICE_MARKUP_BPS (4.5%).
  //  - Conversions ZEC → dollars (the dollar half of a deposit, and every refill):
  //    DEPOSIT_FEE_BPS of the converted value. The ZEC half pays nothing.
  //  - Conversions dollars → ZEC (withdrawals beyond the ZEC balance): WITHDRAWAL_FEE_BPS of
  //    the dollars converted. ZEC withdrawn from the ZEC balance pays no conversion fee.
  //  - Payout network fees (two tranches) are the user's, except on their first withdrawal
  //    of the day; the first deposit of the day gets its network fee credited back.
  // Covered network fees come only from profit above PROFIT_FLOOR_BPS of volume (plus a
  // one-off launch allowance); when that budget is spent, everyone pays them.
  PRICE_MARKUP_BPS: int(450),
  DEPOSIT_FEE_BPS: int(150),
  WITHDRAWAL_FEE_BPS: int(150),
  PROFIT_FLOOR_BPS: int(100),
  FREE_FEE_MIN_MICRO_USD: int(1_000_000),
  SUBSIDY_WINDOW_DAYS: int(7),
  SUBSIDY_BOOTSTRAP_MICRO_USD: int(2_500_000),

  // Withdrawals: dollars → ZEC at the conversion's actual rate, paid in two tranches
  // (the first right after the ZEC arrives, the second TRANCHE_GAP_SEC later).
  MIN_WITHDRAWAL_MICRO_USD: int(1_000_000),
  // Credits converted back to ZEC must be at least this much: NEAR Intents takes a fixed
  // ~0.003 ZEC to deliver ZEC and refuses swaps under ~$1.70, so smaller conversions either
  // fail after bridging or cost the user most of the amount.
  MIN_CONVERT_BACK_MICRO_USD: int(5_000_000),
  TRANCHE_GAP_SEC: int(600),
  REFUND_JITTER_SEC: int(180),
  REFUND_SPLIT_BPS: int(5000),
  REFUND_NETWORK_FEE_ZATS: int(10_000),
  PAYOUT_ADDR_ENC_KEY: z.string().optional(),

  // Treasury and NEAR Intents
  NEAR_ONECLICK_BASE_URL: z.string().default('https://1click.chaindefuser.com'),
  NEAR_ONECLICK_JWT: z.string().optional(),
  TREASURY_SWAP_ORIGIN_ASSET: z.string().default('nep141:zec.omft.near'),
  TREASURY_SWAP_DEST_ASSET: z.string().default('nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near'),
  TREASURY_SWAP_RECIPIENT: z.string().default(''),
  TREASURY_REFUND_TO: z.string().default(''), // defaults to ZEEP_RESERVE_TADDR
  TREASURY_SLIPPAGE_BPS: int(100),
  // Tempo float: the reserve holds ZEC against ZEC notes and USDC.e against dollar notes. ZEC
  // above what ZEC notes are owed (the dollar half of deposits, refills) is converted to
  // USDC.e each tick. Withdrawals beyond the ZEC balance convert their dollars back.
  FLOAT_MODE: z.enum(['auto', 'off']).default('off'),
  FLOAT_TICK_SEC: int(60),
  // Treasury ZEC kept unconverted on top of what ZEC notes are owed: pays network fees Zeep
  // covers (first withdrawal of the day, conversion sends, shielding). Refills itself from the
  // next deposits' surplus; the cost shows up as covered fees in the profit books.
  ZEC_FLOOR_ZATS: int(200_000),
  CONVERSION_MIN_ZATS: int(300_000), // NEAR Intents refuses ZEC swaps under ~0.0013 ZEC
  TREASURY_RAILS: z.enum(['live', 'mock']).default('mock'),
  ZEEP_RESERVE_TADDR: z.string().default(''),
  RESERVE_COVERAGE_MIN_BPS: int(10_000),
  // NEAR Intents does not list Tempo, so ZEC ⇄ USDC goes through Base, and Relay bridges
  // Base USDC ⇄ Tempo USDC.e (chain 4217). The same EVM key (TEMPO_PRIVATE_KEY) is used on both.
  BASE_RPC_URL: z.string().default('https://mainnet.base.org'),
  RELAY_API_URL: z.string().default('https://api.relay.link'),
  // Relay.link API key (Relay dashboard → Apps). Required for quotes since 2 Oct 2026; mainnet only (testnet rails are simulated).
  RELAY_API_KEY: z.string().optional(),
  BASE_USDC: z.string().default('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
  TEMPO_USDC_E: z.string().default('0x20C000000000000000000000b9537d11c60E8b50'),
  TEMPO_CHAIN_ID: int(4217),

  // MPP and Tempo
  MPP_ENABLED: bool(true),
  MPP_MODE: z.enum(['live', 'mock']).default('mock'),
  TEMPO_PRIVATE_KEY: z.string().optional(),
  TEMPO_RPC_URL: z.string().optional(),
  MPP_SESSION_MAX_USD: z.coerce.number().default(20),
  MPP_DAILY_BUDGET_USD: z.coerce.number().default(50),
  MPP_OPENROUTER_URL: z.string().default('https://openrouter.mpp.tempo.xyz'),
  MPP_ANTHROPIC_URL: z.string().default('https://anthropic.mpp.tempo.xyz'),
  MPP_OPENAI_URL: z.string().default('https://openai.mpp.tempo.xyz'),
  MPP_EXA_URL: z.string().default('https://api.exa.ai'),
  MPP_BRAVE_URL: z.string().default('https://brave.mpp.paywithlocus.com'),
  MPP_PARALLEL_URL: z.string().default('https://parallelmpp.dev'),
  MPP_RXATLAS_URL: z.string().default('https://api.rxatlas.dev'),
  MPP_TRIALBASE_URL: z.string().default('https://api.trialbase-db.org'),
  MPP_STABLEEMAIL_URL: z.string().default('https://stableemail.dev'),
  MPP_AGENTMAIL_URL: z.string().default('https://mpp.api.agentmail.to'),
  // Which chain backend the Rust workers use. With mock rails on a REAL chain (testnet light
  // client), the treasury simulates conversions in its books and never sends ZEC to fake rails.
  CHAIN_BACKEND: z.enum(['dev', 'rpc', 'lightclient']).default('dev'),
  INBOX_PROVIDER: z.enum(['agentmail', 'stableemail']).default('agentmail'),
  // Anti-abuse limits per inbox (sending costs money and reputation; reads cost Zeep MPP fees).
  INBOX_SENDS_PER_DAY: int(20),
  INBOX_MAX_RECIPIENTS: int(10),
  // Send-only email (no inbox) goes out from StableEmail's shared relay address: a global daily
  // cap protects that sender's reputation (and Zeep's account) from bulk sending.
  EMAIL_SENDS_PER_DAY: int(500),
  INBOX_READS_PER_HOUR: int(240),

  // Self-hosted models (Modal)
  MODAL_LLM_BASE_URL: z.string().default(''),
  MODAL_PROXY_TOKEN: z.string().optional(),
});

export type Config = z.infer<typeof Env>;

/**
 * Testnet and mainnet must never mix: one network per app, database and Redis, and mainnet
 * only with real rails, a pinned verifying key and live prices. Returns the problems found.
 */
/** What each paid route costs Zeep upstream, per call (provider 402 prices). */
export const PROVIDER_COST_USD: Record<string, number> = {
  search: 0.007, // Exa /search
  research_base: 0.01, // Parallel /api/responses, low
  research_core: 0.05, // Parallel /api/responses, medium
  research_pro: 0.1, // Parallel /api/task, pro
  health: 0.1, // RxAtlas / TrialBase search page
  inbox: 2.0, // AgentMail inbox
  inbox_send: 0.01, // AgentMail send / reply
  email_send: 0.02, // StableEmail /api/send (send-only, shared relay address)
};

export function networkProblems(c: Config): string[] {
  const p: string[] = [];
  const main = c.ZEEP_ENV === 'mainnet';
  if (main !== (c.ZCASH_NETWORK === 'main')) p.push(`ZEEP_ENV=${c.ZEEP_ENV} needs ZCASH_NETWORK=${main ? 'main' : 'test'}`);
  const ua = main ? /^u1[02-9ac-hj-np-z]+$/ : /^utest1[02-9ac-hj-np-z]+$/;
  if (c.ZEEP_RECEIVE_UA && !ua.test(c.ZEEP_RECEIVE_UA)) p.push(`ZEEP_RECEIVE_UA is not a ${c.ZCASH_NETWORK}net unified address`);
  const taddr = main ? /^t1[1-9A-HJ-NP-Za-km-z]{33}$/ : /^tm[1-9A-HJ-NP-Za-km-z]{33}$/;
  if (c.ZEEP_RESERVE_TADDR && !taddr.test(c.ZEEP_RESERVE_TADDR)) p.push(`ZEEP_RESERVE_TADDR is not a ${c.ZCASH_NETWORK}net transparent (P2PKH) address`);
  if (c.TREASURY_REFUND_TO && !taddr.test(c.TREASURY_REFUND_TO)) p.push(`TREASURY_REFUND_TO is not a ${c.ZCASH_NETWORK}net transparent address`);
  // Never sell a call for less than the provider charges Zeep (checked against their live 402
  // prices, Oct 2026). mppFetch also refuses to pay more than the user paid, as a backstop.
  if (c.INBOX_PROVIDER === 'stableemail') p.push('INBOX_PROVIDER=stableemail charges for every inbox read, which Zeep gives away free: use agentmail');
  for (const [route, min] of Object.entries(PROVIDER_COST_USD)) {
    const price = c.SERVICE_PRICES_USD_JSON[route];
    if (price !== undefined && price < min) p.push(`SERVICE_PRICES_USD_JSON.${route} is ${price}, below the provider's price of ${min}`);
  }
  for (const k of ['OHTTP_PRIVATE_KEY', 'OHTTP_PREVIOUS_PRIVATE_KEY'] as const) {
    const v = c[k];
    if (v && Buffer.from(v.trim(), 'base64').length !== 32) p.push(`${k} must be 32 random bytes in base64 (openssl rand -base64 32)`);
  }
  if (c.OHTTP_PREVIOUS_PRIVATE_KEY && c.OHTTP_PREVIOUS_KEY_ID === c.OHTTP_KEY_ID) p.push('OHTTP_PREVIOUS_KEY_ID must differ from OHTTP_KEY_ID');
  if (c.REQUIRE_OHTTP && !c.OHTTP_PRIVATE_KEY) p.push('REQUIRE_OHTTP=true needs OHTTP_PRIVATE_KEY');
  if (!main) {
    // Testnet ZEC is free: it must never move real money. The rails are always simulated, and
    // real paid services only with an explicit opt-in (keep MPP_DAILY_BUDGET_USD small).
    if (c.TREASURY_RAILS !== 'mock') p.push('testnet needs TREASURY_RAILS=mock (live rails would sell free testnet ZEC for real USDC)');
    if (c.MPP_MODE === 'live' && !c.TESTNET_LIVE_MPP) p.push('testnet with MPP_MODE=live needs TESTNET_LIVE_MPP=true (real USDC pays for services bought with free testnet ZEC)');
  }
  if (main) {
    if (c.TREASURY_RAILS !== 'live') p.push('mainnet needs TREASURY_RAILS=live');
    if (c.TREASURY_RAILS === 'live' && !c.RELAY_API_KEY) p.push('mainnet needs RELAY_API_KEY (Relay.link requires a key for bridge quotes)');
    if (c.MPP_MODE !== 'live') p.push('mainnet needs MPP_MODE=live');
    if (!c.SPEND_VKEY_SHA256) p.push('mainnet needs SPEND_VKEY_SHA256 (pin the verifying key from the ceremony)');
    if (c.ALLOW_PRICE_FALLBACK) p.push('ALLOW_PRICE_FALLBACK is not allowed on mainnet');
    if (!c.REQUIRE_RELAY && !c.ALLOW_NO_RELAY) p.push('mainnet needs REQUIRE_RELAY=true (or ALLOW_NO_RELAY=true to accept that Heroku logs client IPs)');
    if (!c.OHTTP_PRIVATE_KEY) p.push('mainnet needs OHTTP_PRIVATE_KEY (openssl rand -base64 32): requests are encrypted end to end through the relay');
    if (/testnet|localhost|127\.0\.0\.1/.test(c.PUBLIC_API_BASE_URL)) p.push('PUBLIC_API_BASE_URL looks like a testnet/local URL');
    // Everything the live money path and paid services need, checked at boot instead of failing
    // on the first user's request.
    if (!c.TEMPO_PRIVATE_KEY) p.push('mainnet needs TEMPO_PRIVATE_KEY (treasury EVM key: pays MPP services, moves the float)');
    if (!c.NEAR_ONECLICK_JWT) p.push('mainnet needs NEAR_ONECLICK_JWT (live ZEC price and treasury swaps)');
    if (c.CORS_ALLOWED_ORIGINS.some((o) => /localhost|127\.0\.0\.1/.test(o))) p.push('CORS_ALLOWED_ORIGINS must be your mainnet frontend URL');
    const selfHosted = c.MODELS_JSON.some((m) => m.host === 'zeep');
    if (selfHosted && (!c.MODAL_LLM_BASE_URL || !c.MODAL_PROXY_TOKEN)) {
      p.push('mainnet lists self-hosted models: set MODAL_LLM_BASE_URL and MODAL_PROXY_TOKEN (or remove them from MODELS_JSON)');
    }
  }
  return p;
}

function load(): Config {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
  let problems = networkProblems(parsed.data);
  // Release phase / doctor: only what migrations need (database + network identity). Wrong-network
  // addresses still stop it; missing service keys are reported by release.ts instead of failing it.
  if (process.env.ZEEP_PHASE === 'release') {
    problems = problems.filter((m) => /ZCASH_NETWORK|ZEEP_RECEIVE_UA|ZEEP_RESERVE_TADDR|TREASURY_REFUND_TO/.test(m));
  }
  // End-to-end tests run mainnet settings against the simulated chain and mock rails. Never
  // possible on Heroku (DYNO is set there) or outside NODE_ENV=test.
  if (process.env.ZEEP_TEST_SIMULATION === '1') {
    if (process.env.DYNO || parsed.data.NODE_ENV !== 'test') throw new Error('ZEEP_TEST_SIMULATION is for local tests only');
    problems = problems.filter((m) => /ZCASH_NETWORK|ZEEP_RECEIVE_UA|ZEEP_RESERVE_TADDR|TREASURY_REFUND_TO/.test(m) && !/RELAY_API_KEY/.test(m));
  }
  if (problems.length) throw new Error(`Invalid configuration for ${parsed.data.ZEEP_ENV}: ${problems.join('; ')}`);
  return parsed.data;
}

export const cfg: Config = load();

export const isProd = cfg.NODE_ENV === 'production';

/** Return a secret config var or throw with a clear message. Call at the point of use. */
export function need<K extends keyof Config>(key: K): NonNullable<Config[K]> {
  const v = cfg[key];
  if (v === undefined || v === null || v === '') throw new Error(`Missing required config var ${String(key)}`);
  return v as NonNullable<Config[K]>;
}

export type ModelInfo = Config['MODELS_JSON'][number];

/** Models available on this network. */
export function models(): ModelInfo[] {
  return cfg.MODELS_JSON.filter((m) => cfg.ZEEP_ENV === 'mainnet' || m.testnet);
}
