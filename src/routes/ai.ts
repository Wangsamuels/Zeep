// POST /v1/ai/chat/completions (OpenAI-compatible, with attachments) and GET /v1/ai/models.
// Each response is charged once: the model's per-response price, plus a per-MB fee for
// attachments beyond the first 64 KB of the request body. Prices are public in /v1/prices.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { cfg } from '../config.js';
import { errors } from '../lib/errors.js';
import { modalFetch } from '../services/modal.js';
import { mppFetch } from '../services/mpp.js';
import { chatUsd, modelById, priceSheet } from '../services/prices.js';
import { chargeRequest, pipeSse, upstreamJson, withCharge } from './paid.js';

// Text, or OpenAI content parts: text and images (data: URLs, so nothing is fetched by URL).
const Part = z.union([
  z.object({ type: z.literal('text'), text: z.string().max(2_000_000) }),
  z.object({
    type: z.literal('image_url'),
    image_url: z.object({ url: z.string().regex(/^data:image\/(png|jpeg|webp|gif);base64,/, 'images must be data: URLs') }),
  }),
]);
const Body = z
  .object({
    model: z.string().max(200).optional(),
    messages: z
      .array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.union([z.string(), z.array(Part).max(40)]) }))
      .min(1)
      .max(500),
    stream: z.boolean().optional(),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().max(32_000).optional(),
  })
  .strict();

export default async function aiRoutes(app: FastifyInstance) {
  app.get('/v1/ai/models', async () => {
    const s = await priceSheet();
    return { object: 'list', data: s.models.map((m) => ({ ...m, object: 'model', per: 'response' })) };
  });

  app.post('/v1/ai/chat/completions', { bodyLimit: cfg.CHAT_MAX_BODY_MB * 1024 * 1024 }, async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) throw errors.bad(parsed.error.issues[0]?.message ?? 'invalid chat request');
    const body = parsed.data;
    const model = modelById(body.model ?? cfg.DEFAULT_MODEL);
    if (!model) throw errors.bad(`unknown or disabled model: ${body.model}`);
    const hasImage = body.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
    if (hasImage && !model.vision) throw errors.bad(`${model.name} can't read images; pick a model marked "reads images"`);

    const s = await chargeRequest(req, reply, chatUsd(model, req.rawBody?.length ?? 0));
    return withCharge(s, reply, async () => {
      const upstreamModel = model.upstream ?? (model.id.startsWith('openai/') ? model.id.slice(7) : model.id);
      const out = { ...body, model: upstreamModel };
      const long = out.stream ? AbortSignal.timeout(10 * 60_000) : undefined;
      let res: Response;
      if (model.host === 'zeep') res = await modalFetch('/v1/chat/completions', out, long);
      else {
        const url = model.id.startsWith('openai/') ? `${cfg.MPP_OPENAI_URL}/v1/chat/completions` : `${cfg.MPP_OPENROUTER_URL}/v1/chat/completions`;
        res = await mppFetch('ai-frontier', url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(out), signal: long });
      }
      if (out.stream && res.ok && res.headers.get('content-type')?.includes('text/event-stream')) return pipeSse(reply, res);
      const json = (await upstreamJson(res)) as Record<string, unknown>;
      if (json && typeof json === 'object') json.model = model.id;
      return json;
    });
  });
}
