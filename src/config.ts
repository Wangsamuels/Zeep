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
  INTERNAL_API_TOKEN: z.string().optional(),
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
  DEPOSIT_INTENT_TTL_HOURS: int(72),
  ZEC_USD_FALLBACK: z.coerce.number().positive().default(50),
  PRICE_REFRESH_SEC: int(300),
  // Route prices in USD; charged in zats at the live ZEC price (NEAR Intents token feed).
  SERVICE_PRICES_USD_JSON: json(
    z.record(z.string(), z.number().nonnegative()),
    '{"search":0.01,"research":0.25,"health":0.005,"rpc100":0.002,"inbox":0.30}',
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
  TESTNET_MAX_DEPOSIT_ZATS_PER_DAY: z.coerce.number().int().optional(),
  VAULT_MAX_ITEM_KB: int(512),
  VAULT_MAX_ITEMS: int(2000),

  // Two-asset balances. Each deposit is split: ZEC_SHARE_BPS stays as shielded ZEC owned by the
  // user (the user carries ZEC's price moves); the rest becomes fixed dollars (USDC.e).
  // Services are paid in dollars. When the dollar part falls to REFILL_AT_BPS of its last
  // top-up, the client converts REFILL_BPS of its ZEC to dollars; on stage REFILL_FINAL_STAGE
  // it converts all of it. The schedule runs client-side (the server never sees balances).
  ZEC_SHARE_BPS: int(5000),
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
  CONVERSION_MIN_ZATS: int(100_000),
  TREASURY_RAILS: z.enum(['live', 'mock']).default('mock'),
  ZEEP_RESERVE_TADDR: z.string().default(''),
  RESERVE_COVERAGE_MIN_BPS: int(10_000),
  // NEAR Intents does not list Tempo, so ZEC ⇄ USDC goes through Base, and Relay bridges
  // Base USDC ⇄ Tempo USDC.e (chain 4217). The same EVM key (TEMPO_PRIVATE_KEY) is used on both.
  BASE_RPC_URL: z.string().default('https://mainnet.base.org'),
  RELAY_API_URL: z.string().default('https://api.relay.link'),
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
  MPP_ALCHEMY_URL: z.string().default('https://mpp.alchemy.com'),
  MPP_QUICKNODE_URL: z.string().default('https://mpp.quicknode.com'),
  MPP_STABLEEMAIL_URL: z.string().default('https://stableemail.dev'),
  MPP_AGENTMAIL_URL: z.string().default('https://mpp.api.agentmail.to'),
  // chain name -> full JSON-RPC URL on an MPP provider; {alchemy}/{quicknode} are substituted
  RPC_ROUTES_JSON: json(
    z.record(z.string(), z.string()),
    '{"ethereum":"{alchemy}/eth-mainnet","base":"{alchemy}/base-mainnet","arbitrum":"{alchemy}/arb-mainnet","solana":"{quicknode}/solana-mainnet"}',
  ),
  INBOX_PROVIDER: z.enum(['stableemail', 'agentmail']).default('stableemail'),

  // Self-hosted models (Modal)
  MODAL_LLM_BASE_URL: z.string().default(''),
  MODAL_PROXY_TOKEN: z.string().optional(),
});

export type Config = z.infer<typeof Env>;

function load(): Config {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
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
