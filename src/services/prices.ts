// Prices are in USD and charged in micro-USD (balances are dollars). The live ZEC price is
// used only to credit ZEC deposits and to estimate withdrawals.
//
// ZEC/USD comes from the NEAR Intents 1Click token list (the same venue the treasury
// sells on), refreshed every PRICE_REFRESH_SEC, with ZEC_USD_FALLBACK when unavailable.
import { OneClickService, OpenAPI } from '@defuse-protocol/one-click-sdk-typescript';
import { cfg, models, type ModelInfo } from '../config.js';
import { errors } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { redis } from '../lib/redis.js';

const KEY = 'zeep:price:zec';

interface Quote {
  usd: number;
  at: string;
  source: 'near-intents' | 'fallback';
}
let cache: { current: Quote; previous: Quote | null; fetchedAt: number } | undefined;

async function fetchZecUsd(): Promise<Quote> {
  if (cfg.MPP_MODE === 'mock' || !cfg.NEAR_ONECLICK_JWT) {
    return { usd: cfg.ZEC_USD_FALLBACK, at: new Date().toISOString(), source: 'fallback' };
  }
  try {
    OpenAPI.BASE = cfg.NEAR_ONECLICK_BASE_URL;
    OpenAPI.TOKEN = cfg.NEAR_ONECLICK_JWT;
    const tokens = (await OneClickService.getTokens()) as Array<{ symbol?: string; blockchain?: string; price?: number | string }>;
    const zec = tokens.find((t) => t.symbol?.toUpperCase() === 'ZEC' && (t.blockchain ?? '').toLowerCase().includes('zec'))
      ?? tokens.find((t) => t.symbol?.toUpperCase() === 'ZEC');
    const usd = Number(zec?.price);
    if (!(usd > 0)) throw new Error('no ZEC price in token list');
    return { usd, at: new Date().toISOString(), source: 'near-intents' };
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'ZEC price fetch failed; using fallback');
    return { usd: cfg.ZEC_USD_FALLBACK, at: new Date().toISOString(), source: 'fallback' };
  }
}

/** Current and previous ZEC/USD quotes, shared across dynos through Redis. */
export async function zecQuotes(): Promise<{ current: Quote; previous: Quote | null }> {
  if (cache && Date.now() - cache.fetchedAt < 30_000) return cache;
  let stored: { current: Quote; previous: Quote | null } | null = null;
  try {
    const raw = await redis.get(KEY);
    stored = raw ? JSON.parse(raw) : null;
  } catch {
    stored = null;
  }
  const stale = !stored || Date.now() - Date.parse(stored.current.at) > cfg.PRICE_REFRESH_SEC * 1000;
  if (stale) {
    const fresh = await fetchZecUsd();
    stored = { current: fresh, previous: stored?.current ?? null };
    await redis.set(KEY, JSON.stringify(stored), 'EX', 24 * 3600).catch(() => {});
  }
  cache = { ...stored!, fetchedAt: Date.now() };
  return cache;
}

export const usdToZats = (usd: number, zecUsd: number): number => Math.ceil((usd * 1e8) / zecUsd);
export const zatsToMicroUsd = (zats: number | bigint, zecUsd: number): number => Math.floor((Number(zats) / 1e8) * zecUsd * 1e6);
export const microUsdToZats = (micro: number | bigint, zecUsd: number): number => Math.floor((Number(micro) / 1e6 / zecUsd) * 1e8);

/** What the user pays in USD: the upstream price plus PRICE_MARKUP_BPS. */
export const withMarkup = (usd: number): number => (usd * (10_000 + cfg.PRICE_MARKUP_BPS)) / 10_000;
export const toMicro = (usd: number): number => Math.ceil(Math.round(usd * 1e12) / 1e6);

/** What a request for an upstream price of `usd` costs, in micro-USD (markup included). */
export function requiredMicroUsd(usd: number): number {
  return usd <= 0 ? 0 : toMicro(withMarkup(usd));
}

export function routeUsd(key: string): number {
  const usd = cfg.SERVICE_PRICES_USD_JSON[key];
  if (usd === undefined) throw errors.forbidden(`${key} is disabled on this network`);
  return usd;
}

export function modelById(id: string): ModelInfo | undefined {
  return models().find((m) => m.id === id);
}

/** Per-response price for a chat body of `bodyBytes` (attachments beyond 64 KB are metered). */
export function chatUsd(model: ModelInfo, bodyBytes: number): number {
  const extraMb = Math.max(0, Math.ceil((bodyBytes - 64 * 1024) / (1024 * 1024)));
  return model.usd + extraMb * cfg.ATTACHMENT_USD_PER_MB;
}

/** Public price sheet for the frontend. Every amount is what a request is actually charged. */
export async function priceSheet() {
  const q = await zecQuotes();
  const m = (usd: number) => requiredMicroUsd(usd);
  const cr = (usd: number) => m(usd) / cfg.MICRO_USD_PER_CREDIT;
  return {
    unit: 'micro_usd',
    micro_usd_per_credit: cfg.MICRO_USD_PER_CREDIT,
    markup_bps: cfg.PRICE_MARKUP_BPS,
    zec_usd: q.current.usd, // only used to show what a ZEC deposit will be worth
    zec_price_source: q.current.source,
    quoted_at: q.current.at,
    routes: Object.fromEntries(Object.entries(cfg.SERVICE_PRICES_USD_JSON).map(([k, usd]) => [k, { micro_usd: m(usd), credits: cr(usd) }])),
    models: models().map((x) => ({
      id: x.id, name: x.name, host: x.host, detail: x.detail, vision: x.vision, micro_usd: m(x.usd), credits: cr(x.usd),
    })),
    attachments: { free_kb: 64, micro_usd_per_mb: m(cfg.ATTACHMENT_USD_PER_MB), max_body_mb: cfg.CHAT_MAX_BODY_MB },
    default_model: cfg.DEFAULT_MODEL,
  };
}
