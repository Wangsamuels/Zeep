// POST /v1/ai/chat/completions (OpenAI-compatible, with attachments) and GET /v1/ai/models.
// Each response is charged once, before it runs. Metered (frontier) models: max(min, input
// tokens × input rate + output cap × output rate), the same way the MPP gateway charges Zeep;
// the output cap is enforced on the forwarded request. Flat models: the per-response price plus
// a per-MB fee beyond 64 KB. Prices and formulas are public in /v1/prices.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { cfg } from '../config.js';
import { errors, ZeepError } from '../lib/errors.js';
import { modalFetch } from '../services/modal.js';
import { mppFetch } from '../services/mpp.js';
import { chatQuote, IMAGE_PLACEHOLDER, isMetered, modelById, priceSheet } from '../services/prices.js';
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
    max_tokens: z.number().int().positive().max(128_000).optional(),
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
    // Switching models mid-chat keeps the whole conversation. A model that can't read images
    // only refuses an image in the NEW message; earlier images become a short placeholder.
    const last = body.messages[body.messages.length - 1];
    const lastHasImage = Array.isArray(last.content) && last.content.some((p) => p.type === 'image_url');
    if (lastHasImage && !model.vision) throw errors.bad(`${model.name} can't read images; pick a model marked "reads images"`);
    // Priced on the messages as sent (the SDK computes the same price from the same raw body).
    const quote = chatQuote(model, body, req.rawBody?.length ?? 0);
    if (!model.vision) {
      body.messages = body.messages.map((m) => (Array.isArray(m.content)
        ? { ...m, content: m.content.map((p) => (p.type === 'image_url' ? { type: 'text' as const, text: IMAGE_PLACEHOLDER } : p)) }
        : m));
    }

    // Refuse BEFORE payment when the chat no longer fits this model (the app trims old messages).
    if (isMetered(model) && quote.inputTokens + (quote.maxTokens ?? 0) > model.context) {
      throw new ZeepError(400, 'context_too_long', `This chat is too long for ${model.name}; start a new chat or drop older messages`,
        { max_input_tokens: model.context - (quote.maxTokens ?? 0), estimated_input_tokens: quote.inputTokens });
    }
    const s = await chargeRequest(req, reply, { micro: quote.micro });
    return withCharge(s, reply, async () => {
      const gateway = model.gateway ?? (model.id.startsWith('openai/') ? 'openai' : 'openrouter');
      const upstreamModel = model.upstream ?? (gateway === 'openai' ? model.id.replace(/^openai\//, '') : model.id);
      // The output cap is part of the price: always forward it, so the upstream can't run longer.
      const out = { ...body, model: upstreamModel, ...(quote.maxTokens !== undefined ? { max_tokens: quote.maxTokens } : {}) };
      const long = out.stream ? AbortSignal.timeout(10 * 60_000) : undefined;
      let res: Response;
      if (model.host === 'zeep') res = await modalFetch('/v1/chat/completions', out, long);
      else {
        const url = gateway === 'openai' ? `${cfg.MPP_OPENAI_URL}/v1/chat/completions` : `${cfg.MPP_OPENROUTER_URL}/v1/chat/completions`;
        res = await mppFetch('ai-frontier', url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(out), signal: long });
      }
      if (out.stream && res.ok && res.headers.get('content-type')?.includes('text/event-stream')) return pipeSse(reply, res);
      const json = (await upstreamJson(res)) as Record<string, unknown>;
      if (json && typeof json === 'object') json.model = model.id;
      return json;
    });
  });
}
