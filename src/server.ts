// `web` process: the public API gateway.
import cors from '@fastify/cors';
import Fastify, { type FastifyError } from 'fastify';
import { cfg, isProd } from './config.js';
import { safeEqual } from './lib/crypto.js';
import { pool } from './lib/db.js';
import { ZeepError } from './lib/errors.js';
import { log } from './lib/log.js';
import { checkRedisNetwork, redis } from './lib/redis.js';
import { checkDbNetwork } from './migrate.js';
import { registry } from './notes/registry.js';
import { loadVkey } from './notes/spend.js';
import aiRoutes from './routes/ai.js';
import internalRoutes from './routes/internal.js';
import moneyRoutes from './routes/money.js';
import publicRoutes from './routes/public.js';
import inboxRoutes from './routes/inbox.js';
import serviceRoutes from './routes/services.js';
import vaultRoutes from './routes/vault.js';
import { isInnerRequest, registerOhttp } from './routes/ohttp.js';

// Headers that can carry a client IP. Removed before any handler or log sees them.
const IP_HEADERS = ['x-forwarded-for', 'x-real-ip', 'forwarded', 'via', 'cf-connecting-ip', 'true-client-ip', 'x-client-ip'];

export async function buildApp() {
  const app = Fastify({
    logger: false, // we log route/status/latency ourselves, never bodies or IPs
    trustProxy: false,
    bodyLimit: 1024 * 1024,
    requestIdHeader: false,
    return503OnClosing: true,
  });

  // Keep the raw bytes: the spend proof signal commits to SHA-256(raw body).
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body as Buffer;
    if (!(body as Buffer).length) return done(null, undefined);
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch {
      done(new ZeepError(400, 'bad_json', 'body is not valid JSON') as unknown as FastifyError, undefined);
    }
  });

  app.addHook('onRequest', async (req, reply) => {
    for (const h of IP_HEADERS) delete req.headers[h];
    (req as { _t?: number })._t = performance.now();
    reply.header('cache-control', 'no-store');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-content-type-options', 'nosniff');
    if (cfg.REQUIRE_RELAY && !req.url.startsWith('/internal/')) {
      const relay = req.headers['x-zeep-relay'];
      if (typeof relay !== 'string' || !safeEqual(relay, cfg.RELAY_SHARED_SECRET)) {
        return reply.code(403).send({ error: { code: 'relay_required', message: `use ${cfg.PUBLIC_API_BASE_URL}` } });
      }
    }
    delete req.headers['x-zeep-relay'];
    // Requests decrypted by the OHTTP gateway carry a per-process marker; nobody else can.
    const inner = isInnerRequest(req.headers['x-zeep-ohttp-inner']);
    delete req.headers['x-zeep-ohttp-inner'];
    if (cfg.REQUIRE_OHTTP && !inner && req.method !== 'OPTIONS' && !req.url.startsWith('/internal/')) {
      const path = req.url.split('?')[0];
      if (path !== '/ohttp' && path !== '/ohttp-keys' && path !== '/v1/status') {
        return reply.code(403).send({ error: { code: 'ohttp_required', message: 'this API only accepts Oblivious HTTP requests; update the app' } });
      }
    }
  });

  await app.register(cors, {
    origin: cfg.CORS_ALLOWED_ORIGINS,
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    exposedHeaders: ['x-zeep-notes', 'x-zeep-cost'],
    allowedHeaders: ['content-type', 'x-zeep-proof', 'x-vault-id', 'x-vault-auth', ...Array.from({ length: 15 }, (_, i) => `x-zeep-proof-${i + 1}`)],
    maxAge: 600,
  });

  app.addHook('onResponse', async (req, reply) => {
    const t = (req as { _t?: number })._t;
    log.info({ route: req.routeOptions.url ?? 'unmatched', method: req.method, status: reply.statusCode, ms: t ? Math.round(performance.now() - t) : undefined }, 'req');
  });

  app.setErrorHandler((err: FastifyError | ZeepError, _req, reply) => {
    if (err instanceof ZeepError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, ...err.extra } });
    }
    const status = (err as FastifyError).statusCode;
    if (status && status < 500) {
      return reply.code(status).send({ error: { code: (err as FastifyError).code ?? 'bad_request', message: err.message } });
    }
    log.error({ err: { message: err.message, stack: err.stack } }, 'unhandled');
    return reply.code(500).send({ error: { code: 'internal', message: 'internal error' } });
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'no such route' } }));

  await app.register(publicRoutes);
  await app.register(aiRoutes);
  await app.register(serviceRoutes);
  await app.register(inboxRoutes);
  await app.register(moneyRoutes);
  await app.register(vaultRoutes);
  await app.register(internalRoutes);
  await registerOhttp(app);
  return app;
}

async function main() {
  if (isProd && cfg.REQUIRE_RELAY && !cfg.RELAY_SHARED_SECRET) throw new Error('REQUIRE_RELAY=true needs RELAY_SHARED_SECRET');
  await checkDbNetwork();
  await checkRedisNetwork();
  await registry.boot();
  await loadVkey().catch((e) => log.error({ err: e.message }, 'verifying key not loaded yet; paid routes will retry'));
  registry.startActivator();

  const app = await buildApp();
  await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
  log.info({ port: cfg.PORT }, 'zeep web listening');

  const shutdown = async () => {
    log.info('shutting down');
    await app.close().catch(() => {});
    await registry.close();
    await redis.quit().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    log.error({ err: e.message }, 'boot failed');
    process.exit(1);
  });
}
