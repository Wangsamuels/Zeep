// Search, research, health lookup and anonymous inbox.
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

  // ---- anonymous inbox (30 days): src/routes/inbox.ts ----
}
