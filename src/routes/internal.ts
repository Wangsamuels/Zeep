// POST /internal/verify — called only by the spend-proof gate in front of lightwalletd/Zaino on
// the VPS. The gate computes the signal for the gRPC call it is about to forward
// (gateSignal(method, sha256(request bytes))) and sends it with the client's bundle.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { cfg } from '../config.js';
import { safeEqual } from '../lib/crypto.js';
import { errors } from '../lib/errors.js';
import { toField } from '../lib/field.js';
import { gateSignal, parseBundle, spend, USD } from '../notes/spend.js';
import { requiredMicroUsd, routeUsd } from '../services/prices.js';

const Body = z.object({
  bundle: z.unknown(),
  method: z.string().min(1).max(200),
  request_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  calls: z.number().int().min(1).max(10_000).default(1),
  signal: z.string().optional(), // optional cross-check of the gate's own computation
});

export default async function internalRoutes(app: FastifyInstance) {
  app.post('/internal/verify', async (req) => {
    const token = req.headers['x-internal-token'];
    if (typeof token !== 'string' || !safeEqual(token, cfg.INTERNAL_API_TOKEN)) throw errors.unauthorized();
    const b = Body.safeParse(req.body);
    if (!b.success) throw errors.bad('invalid verify request');
    const signal = gateSignal(b.data.method, b.data.request_sha256);
    if (b.data.signal && toField(b.data.signal) !== signal) throw errors.invalid('signal mismatch');
    const minCost = requiredMicroUsd(Math.ceil(b.data.calls / 100) * routeUsd('rpc100'));
    const s = await spend({ bundle: parseBundle(b.data.bundle), asset: USD, signal, minCost, book: 'service' });
    return { ok: true, cost_micro_usd: s.cost.toString(), notes: s.notes };
  });
}
