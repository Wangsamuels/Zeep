// Search, research, health lookup, blockchain RPC and anonymous inbox.
// Upstream paths that vary by provider are kept in PROVIDERS so they can be adjusted
// in one place after each day-1 endpoint check.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { cfg } from '../config.js';
import { q } from '../lib/db.js';
import { errors } from '../lib/errors.js';
import { keys, redis } from '../lib/redis.js';
import { summarize } from '../services/modal.js';
import { mppFetch } from '../services/mpp.js';
import { researchUsd, routeUsd } from '../services/prices.js';
import { chargeRequest, upstreamJson, withCharge } from './paid.js';

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const PROVIDERS = {
  exaSearch: (b: { query: string; n: number }) => [`${cfg.MPP_EXA_URL}/search`, json({ query: b.query, numResults: b.n, contents: { text: { maxCharacters: 1000 } } })] as const,
  braveSearch: (b: { query: string; n: number }) => [`${cfg.MPP_BRAVE_URL}/res/v1/web/search?q=${encodeURIComponent(b.query)}&count=${b.n}`, { method: 'GET' }] as const,
  parallelCreate: (input: string, processor: string) => [`${cfg.MPP_PARALLEL_URL}/v1/tasks/runs`, json({ input, processor })] as const,
  parallelStatus: (runId: string) => `${cfg.MPP_PARALLEL_URL}/v1/tasks/runs/${encodeURIComponent(runId)}`,
  parallelResult: (runId: string) => `${cfg.MPP_PARALLEL_URL}/v1/tasks/runs/${encodeURIComponent(runId)}/result`,
  rxatlas: (query: string) => `${cfg.MPP_RXATLAS_URL}/v1/drugs/search?q=${encodeURIComponent(query)}`,
  trialbase: (query: string) => `${cfg.MPP_TRIALBASE_URL}/v1/trials/search?q=${encodeURIComponent(query)}`,
  inbox: {
    stableemail: {
      create: () => [`${cfg.MPP_STABLEEMAIL_URL}/v1/inboxes`, json({ ttl_days: 30 })] as const,
      messages: (ref: string) => `${cfg.MPP_STABLEEMAIL_URL}/v1/inboxes/${encodeURIComponent(ref)}/messages`,
      parse: (j: any) => ({ ref: String(j.id ?? j.inbox_id), address: String(j.address ?? j.email) }),
    },
    agentmail: {
      create: () => [`${cfg.MPP_AGENTMAIL_URL}/v0/inboxes`, json({})] as const,
      messages: (ref: string) => `${cfg.MPP_AGENTMAIL_URL}/v0/inboxes/${encodeURIComponent(ref)}/messages`,
      parse: (j: any) => ({ ref: String(j.inbox_id), address: String(j.inbox_id) }),
    },
  },
};


export default async function serviceRoutes(app: FastifyInstance) {
  // ---- search (2 credits) ----
  const Search = z.object({
    query: z.string().min(1).max(500),
    provider: z.enum(['exa', 'brave']).default('exa'),
    num_results: z.number().int().min(1).max(20).default(8),
  });
  app.post('/v1/search', async (req, reply) => {
    const b = Search.safeParse(req.body);
    if (!b.success) throw errors.bad('invalid search request');
    const c = await chargeRequest(req, reply, routeUsd('search'));
    return withCharge(c, reply, async () => {
      const [url, init] = b.data.provider === 'exa'
        ? PROVIDERS.exaSearch({ query: b.data.query, n: b.data.num_results })
        : PROVIDERS.braveSearch({ query: b.data.query, n: b.data.num_results });
      const j = (await upstreamJson(await mppFetch('search', url, init))) as any;
      const results = b.data.provider === 'exa'
        ? (j.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.text ?? r.snippet, published: r.publishedDate }))
        : (j.web?.results ?? j.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.description ?? r.snippet }));
      return { provider: b.data.provider, results };
    });
  });

  // ---- research (async job; priced per processor: research_base / research_core / research_pro) ----
  const Research = z.object({ query: z.string().min(1).max(4000), processor: z.enum(['base', 'core', 'pro']).default('base') });
  app.post('/v1/research', async (req, reply) => {
    const b = Research.safeParse(req.body);
    if (!b.success) throw errors.bad('invalid research request');
    const c = await chargeRequest(req, reply, researchUsd(b.data.processor));
    return withCharge(c, reply, async () => {
      const [url, init] = PROVIDERS.parallelCreate(b.data.query, b.data.processor);
      const j = (await upstreamJson(await mppFetch('research', url, init))) as any;
      const jobId = randomBytes(16).toString('hex');
      await redis.set(keys.job(jobId), JSON.stringify({ kind: 'research', run_id: j.run_id ?? j.id }), 'EX', 86_400);
      reply.code(202);
      return { job_id: jobId, status: 'running', poll: `/v1/jobs/${jobId}` };
    });
  });

  app.get<{ Params: { id: string } }>('/v1/jobs/:id', async (req) => {
    const raw = await redis.get(keys.job(req.params.id));
    if (!raw) throw errors.notFound('job not found or expired');
    const job = JSON.parse(raw) as { kind: string; run_id: string; result?: unknown };
    if (job.result) return { job_id: req.params.id, status: 'completed', result: job.result };
    const s = (await upstreamJson(await mppFetch('research', PROVIDERS.parallelStatus(job.run_id), { method: 'GET' }))) as any;
    const status = String(s.status ?? 'running');
    if (status === 'completed') {
      const r = (await upstreamJson(await mppFetch('research', PROVIDERS.parallelResult(job.run_id), { method: 'GET' }))) as any;
      job.result = r.output ?? r;
      await redis.set(keys.job(req.params.id), JSON.stringify(job), 'EX', 86_400);
      return { job_id: req.params.id, status, result: job.result };
    }
    return { job_id: req.params.id, status: status === 'failed' ? 'failed' : 'running' };
  });

  // ---- health lookup (1 credit) ----
  const Health = z.object({ kind: z.enum(['drug', 'trial']), query: z.string().min(1).max(300), summarize: z.boolean().default(true) });
  app.post('/v1/health/lookup', async (req, reply) => {
    const b = Health.safeParse(req.body);
    if (!b.success) throw errors.bad('invalid health lookup');
    const c = await chargeRequest(req, reply, routeUsd('health'));
    return withCharge(c, reply, async () => {
      const url = b.data.kind === 'drug' ? PROVIDERS.rxatlas(b.data.query) : PROVIDERS.trialbase(b.data.query);
      const data = await upstreamJson(await mppFetch('health', url, { method: 'GET' }));
      let summary: string | undefined;
      if (b.data.summarize && cfg.MODAL_LLM_BASE_URL) {
        summary = await summarize(
          'Summarise this medical reference data in plain language for a patient. Be accurate, note uncertainty, and say to consult a clinician. Do not invent facts.',
          JSON.stringify(data).slice(0, 12_000),
        ).catch(() => undefined);
      }
      return { kind: b.data.kind, data, summary, disclaimer: 'Reference information only, not medical advice.' };
    });
  });

  // ---- blockchain RPC (1 credit per 100 calls) ----
  app.post<{ Params: { chain: string } }>('/v1/rpc/:chain', async (req, reply) => {
    const tpl = cfg.RPC_ROUTES_JSON[req.params.chain];
    if (!tpl) throw errors.notFound(`unknown chain; available: ${Object.keys(cfg.RPC_ROUTES_JSON).join(', ')}`);
    const body = req.body;
    const calls = Array.isArray(body) ? body.length : body && typeof body === 'object' ? 1 : 0;
    if (calls < 1 || calls > 1000) throw errors.bad('send one JSON-RPC call or a batch of up to 1000');
    const c = await chargeRequest(req, reply, Math.ceil(calls / 100) * routeUsd('rpc100'));
    return withCharge(c, reply, async () => {
      const url = tpl.replace('{alchemy}', cfg.MPP_ALCHEMY_URL).replace('{quicknode}', cfg.MPP_QUICKNODE_URL);
      return upstreamJson(await mppFetch('rpc', url, json(body)));
    });
  });

  // ---- anonymous inbox (30 credits, 30 days) ----
  app.post('/v1/inbox', async (req, reply) => {
    const c = await chargeRequest(req, reply, routeUsd('inbox'));
    return withCharge(c, reply, async () => {
      const p = PROVIDERS.inbox[cfg.INBOX_PROVIDER];
      const [url, init] = p.create();
      const { ref, address } = p.parse(await upstreamJson(await mppFetch('inbox', url, init)));
      const id = 'ibx_' + randomBytes(24).toString('base64url');
      const expires = new Date(Date.now() + 30 * 86_400_000);
      await q('INSERT INTO inboxes (id, provider, provider_ref, address, expires_at) VALUES ($1,$2,$3,$4,$5)',
        [id, cfg.INBOX_PROVIDER, ref, address, expires]);
      reply.code(201);
      return { inbox_id: id, address, expires_at: expires.toISOString() };
    });
  });

  app.get<{ Params: { id: string } }>('/v1/inbox/:id/messages', async (req) => {
    const [row] = await q<{ provider: 'stableemail' | 'agentmail'; provider_ref: string; address: string; expires_at: Date }>(
      'SELECT provider, provider_ref, address, expires_at FROM inboxes WHERE id = $1', [req.params.id]);
    if (!row || row.expires_at < new Date()) throw errors.notFound('inbox not found or expired');
    const p = PROVIDERS.inbox[row.provider];
    const j = (await upstreamJson(await mppFetch('inbox', p.messages(row.provider_ref), { method: 'GET' }))) as any;
    return { address: row.address, expires_at: row.expires_at, messages: j.messages ?? j.data ?? j };
  });
}
