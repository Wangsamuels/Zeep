// Self-hosted open-weight models: vLLM's OpenAI-compatible server on Modal.
import { cfg, need } from '../config.js';
import { errors } from '../lib/errors.js';

export function modalHeaders(): Record<string, string> {
  const tok = need('MODAL_PROXY_TOKEN');
  // "wk-…:ws-…" → Modal proxy-auth headers; anything else → Bearer (vLLM --api-key).
  if (tok.includes(':')) {
    const [key, secret] = tok.split(':', 2);
    return { 'Modal-Key': key, 'Modal-Secret': secret };
  }
  return { Authorization: `Bearer ${tok}` };
}

export async function modalFetch(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  if (!cfg.MODAL_LLM_BASE_URL && cfg.MPP_MODE === 'mock') return mockChat(body as { stream?: boolean; model?: string });
  const base = need('MODAL_LLM_BASE_URL').replace(/\/$/, '');
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...modalHeaders() },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(cfg.UPSTREAM_TIMEOUT_MS),
    });
    if (res.status >= 500 || res.status === 429) throw errors.busy('model server busy');
    return res;
  } catch (e) {
    if ((e as { status?: number }).status) throw e;
    throw errors.busy('model server unreachable');
  }
}

/** One-shot completion used internally (e.g. health summaries). */
export async function summarize(system: string, user: string): Promise<string> {
  const res = await modalFetch('/v1/chat/completions', {
    model: cfg.DEFAULT_MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_tokens: 600,
    temperature: 0.2,
  });
  if (!res.ok) throw errors.busy('summary failed');
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return j.choices?.[0]?.message?.content ?? '';
}

/** Offline stand-in for the Modal model server (MPP_MODE=mock and no MODAL_LLM_BASE_URL). */
function mockChat(body: { stream?: boolean; model?: string }): Response {
  const text = 'This is a mock reply from Zeep (no model server configured).';
  if (!body.stream) {
    return Response.json({ id: 'mock', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] });
  }
  const chunks = text.split(' ').map((w, i) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: (i ? ' ' : '') + w } }] })}\n\n`);
  return new Response(chunks.join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
