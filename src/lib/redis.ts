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

export const keys = {
  roots: (series: number) => `zeep:roots:${series}`,
  rootsPattern: 'zeep:roots:*',
  tag: (series: number, epoch: string, tag: string) => `zeep:tag:${series}:${epoch}:${tag}`,
  lock: (name: string) => `zeep:lock:${name}`,
  mppBudget: (day: string) => `zeep:mpp:budget:${day}`,
  cfg: 'zeep:cfg',
  reserve: 'zeep:reserve',
  chainHeight: 'zeep:chain:height',
  job: (id: string) => `zeep:job:${id}`,
};

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
