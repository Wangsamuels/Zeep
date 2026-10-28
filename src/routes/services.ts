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
  // Parallel over MPP: cited answers (/api/responses, $0.01 low / $0.05 medium) for base/core,
  // a multi-hop task (/api/task, $0.10 pro) for pro. Polling a task is free.
  parallelAnswer: (input: string, effort: 'low' | 'medium') => [`${cfg.MPP_PARALLEL_URL}/api/responses`, json({ input, reasoning: { effort } })] as const,
  parallelTask: (input: string) => [`${cfg.MPP_PARALLEL_URL}/api/task`, json({ input, processor: 'pro' })] as const,
  parallelStatus: (runId: string) => `${cfg.MPP_PARALLEL_URL}/api/task/${encodeURIComponent(runId)}`,
  // $0.10 per search page each.
  rxatlas: (query: string) => `${cfg.MPP_RXATLAS_URL}/v1/drugs?q=${encodeURIComponent(query)}&limit=5`,
  trialbase: (query: string) => `${cfg.MPP_TRIALBASE_URL}/v1/trials?q=${encodeURIComponent(query)}&limit=5`,
};

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const join = (parts: unknown[]) => parts.map((p) => (Array.isArray(p) ? p.filter(Boolean).join(', ') : p)).filter((p) => p !== undefined && p !== null && p !== '').join(' · ');

/** One RxAtlas drug product or TrialBase trial as a list item. */
export function healthItem(kind: 'drug' | 'trial', r: Record<string, any>): { id: unknown; title: string; snippet: string; url?: string } {
  if (kind === 'drug') {
    const title = str(r.brand_name) ?? str(r.generic_name) ?? `Drug product ${r.id}`;
    const snippet = join([
      str(r.generic_name) !== title ? str(r.generic_name) : undefined, str(r.strength), str(r.dosage_form), str(r.route),
      str(r.manufacturer_name), str(r.canonical_product_ndc) ? `NDC ${r.canonical_product_ndc}` : undefined,
      r.has_recall ? 'Recall on record' : undefined, str(r.shortage_status) ? `Shortage: ${r.shortage_status}` : undefined,
    ]);
    return { id: r.id, title, snippet };
  }
  const title = str(r.brief_title) ?? str(r.title) ?? str(r.registry_id) ?? `Trial ${r.id}`;
  const snippet = join([
    str(r.registry_id), str(r.status) ? `Status: ${r.status}` : undefined, str(r.phase), str(r.study_type),
    Array.isArray(r.conditions) ? r.conditions.slice(0, 3) : undefined, Array.isArray(r.countries) ? r.countries.slice(0, 3) : undefined,
    str(r.start_date) ? `Started ${r.start_date}` : undefined, typeof r.enrollment_count === 'number' ? `${r.enrollment_count} enrolled` : undefined,
  ]);
  const url = str(r.source_record_url);
  return { id: r.id, title, snippet, ...(url && /^https:\/\//.test(url) ? { url } : {}) };
}

/** Text and citations from an OpenAI-format Response or a Parallel task result. */
function researchResult(r: any): { content: string; citations: unknown[] } {
  const o = r?.result ?? r;
  if (typeof o?.output_text === 'string') return { content: o.output_text, citations: o.citations ?? [] };
  if (Array.isArray(o?.output)) {
    const parts = o.output.flatMap((x: any) => (Array.isArray(x?.content) ? x.content : []));
    const content = parts.map((p: any) => p?.text ?? '').join('');
    const citations = parts.flatMap((p: any) => (Array.isArray(p?.annotations) ? p.annotations : []));
    return { content, citations };
  }
  const out = o?.output ?? o;
  if (typeof out === 'string') return { content: out, citations: [] };
  return { content: typeof out?.content === 'string' ? out.content : JSON.stringify(out?.content ?? out), citations: out?.basis ?? out?.citations ?? [] };
}


export default async function serviceRoutes(app: FastifyInstance) {
  // ---- search (2 credits) ----
  const Search = z.object({
    query: z.string().min(1).max(500),
    // Only Exa: Brave over MPP costs 3.5× the search price. 'brave' is accepted and served by Exa.
    provider: z.enum(['exa', 'brave']).default('exa'),
    num_results: z.number().int().min(1).max(20).default(8),
  });
  app.post('/v1/search', async (req, reply) => {
    const b = Search.safeParse(req.body);
    if (!b.success) throw errors.bad('invalid search request');
    const c = await chargeRequest(req, reply, routeUsd('search'));
    return withCharge(c, reply, async () => {
      const [url, init] = PROVIDERS.exaSearch({ query: b.data.query, n: b.data.num_results });
      const j = (await upstreamJson(await mppFetch('search', url, init))) as any;
      const results = (j.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.text ?? r.snippet, published: r.publishedDate }));
      return { provider: 'exa', results };
    });
  });

  // ---- research (async job; priced per processor: research_base / research_core / research_pro) ----
  const Research = z.object({ query: z.string().min(1).max(4000), processor: z.enum(['base', 'core', 'pro']).default('base') });
  app.post('/v1/research', async (req, reply) => {
    const b = Research.safeParse(req.body);
    if (!b.success) throw errors.bad('invalid research request');
    const c = await chargeRequest(req, reply, researchUsd(b.data.processor));
    return withCharge(c, reply, async () => {
      const jobId = randomBytes(16).toString('hex');
      if (b.data.processor === 'pro') {
        const [url, init] = PROVIDERS.parallelTask(b.data.query);
        const j = (await upstreamJson(await mppFetch('research', url, init))) as any;
        const runId = j.run_id ?? j.id;
        if (!runId) throw errors.busy('research did not start');
        await redis.set(keys.job(jobId), JSON.stringify({ kind: 'research', run_id: runId }), 'EX', 86_400);
      } else {
        // Answers come back in one call; stored as a finished job so the app polls the same way.
        const [url, init] = PROVIDERS.parallelAnswer(b.data.query, b.data.processor === 'base' ? 'low' : 'medium');
        const j = await upstreamJson(await mppFetch('research', url, init));
        await redis.set(keys.job(jobId), JSON.stringify({ kind: 'research', run_id: '', result: researchResult(j) }), 'EX', 86_400);
      }
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
      job.result = researchResult(s);
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
      const raw = (await upstreamJson(await mppFetch('health', url, { method: 'GET' }))) as { data?: unknown[]; total?: number };
      // RxAtlas / TrialBase return { data: [records], total }: turn each record into
      // { title, snippet, url } so the app can list it.
      const data = (Array.isArray(raw?.data) ? raw.data : []).map((r) => healthItem(b.data.kind, r as Record<string, any>));
      let summary: string | undefined;
      if (b.data.summarize && cfg.MODAL_LLM_BASE_URL) {
        summary = await summarize(
          'Summarise this medical reference data in plain language for a patient. Be accurate, note uncertainty, and say to consult a clinician. Do not invent facts.',
          JSON.stringify(data).slice(0, 12_000),
        ).catch(() => undefined);
      }
      if (!summary && !data.length) summary = `No ${b.data.kind === 'drug' ? 'drug products' : 'clinical trials'} matched "${b.data.query}". Try another name or spelling.`;
      return { kind: b.data.kind, data, total: typeof raw?.total === 'number' ? raw.total : data.length, summary, disclaimer: 'Reference information only, not medical advice.' };
    });
  });

  // ---- anonymous inbox (30 days): src/routes/inbox.ts ----
}
