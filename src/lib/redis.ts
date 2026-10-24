import { Redis, type RedisOptions } from 'ioredis';
import { randomBytes } from 'node:crypto';
import { cfg } from '../config.js';

export function redisOptions(): RedisOptions {
  const tls = cfg.REDIS_URL.startsWith('rediss://')
    ? { rejectUnauthorized: cfg.REDIS_TLS_REJECT_UNAUTHORIZED }
    : undefined;
  // maxRetriesPerRequest=null is required by BullMQ workers.
  return { tls, maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: true };
}

export function newRedis(): Redis {
  return new Redis(cfg.REDIS_URL, redisOptions());
}

/** Shared command connection. Subscribers must use their own (`newRedis()`). */
export const redis = newRedis();

/** Every key is namespaced by network, so a testnet and a mainnet app can never share state. */
export const NS = `zeep:${cfg.ZEEP_ENV}`;
export const keys = {
  lock: (name: string) => `${NS}:lock:${name}`,
  mppBudget: (day: string) => `${NS}:mpp:budget:${day}`,
  reserve: `${NS}:reserve`,
  chainHeight: `${NS}:chain:height`,
  job: (id: string) => `${NS}:job:${id}`,
  price: `${NS}:price:zec`,
  notesChannel: `${NS}:notes`,
  queuePrefix: `${NS}:q`,
  network: 'zeep:network',
};

/** Refuse to run against a Redis that another network already uses. */
export async function checkRedisNetwork(): Promise<void> {
  await redis.set(keys.network, cfg.ZEEP_ENV, 'NX');
  const got = await redis.get(keys.network);
  if (got !== cfg.ZEEP_ENV) throw new Error(`This Redis belongs to ${got}; refusing to run ${cfg.ZEEP_ENV} on it. Use a separate Redis per network.`);
}

/**
 * Single-holder lock with a 60 s lease. `run` keeps renewing while `fn` runs and
 * releases only if we still own it (compare-and-delete), so two holders never overlap.
 */
export async function withLock<T>(name: string, fn: () => Promise<T>, ttlMs = 60_000): Promise<T | undefined> {
  const key = keys.lock(name);
  const token = randomBytes(16).toString('hex');
  const ok = await redis.set(key, token, 'PX', ttlMs, 'NX');
  if (ok !== 'OK') return undefined;
  const renew = setInterval(() => {
    redis
      .eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
        1, key, token, String(ttlMs),
      )
      .catch(() => {});
  }, Math.floor(ttlMs / 3));
  try {
    return await fn();
  } finally {
    clearInterval(renew);
    await redis
      .eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, key, token)
      .catch(() => {});
  }
}
