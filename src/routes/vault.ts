// Encrypted per-user storage for multi-device restore: chat threads, settings, inbox ids.
// The client derives vault_id and the auth token from its seed and encrypts every blob
// before upload, so the server holds opaque bytes it cannot read or link to spends.
// Items can carry an expiry (30-day auto-delete); expired items are purged hourly.
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { cfg } from '../config.js';
import { safeEqual } from '../lib/crypto.js';
import { q } from '../lib/db.js';
import { errors, ZeepError } from '../lib/errors.js';

const ID = /^[0-9a-f]{64}$/;
const ITEM = /^[A-Za-z0-9_-]{1,80}$/;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function authorize(req: FastifyRequest<{ Params: { vault: string } }>, create: boolean): Promise<void> {
  const vault = req.params.vault;
  const token = req.headers['x-vault-auth'];
  if (!ID.test(vault) || typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) throw errors.unauthorized();
  const [v] = await q<{ auth_hash: string }>('SELECT auth_hash FROM vaults WHERE id = $1', [vault]);
  if (!v) {
    if (!create) throw errors.notFound('vault not found');
    await q('INSERT INTO vaults (id, auth_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING', [vault, sha(token)]);
    const [again] = await q<{ auth_hash: string }>('SELECT auth_hash FROM vaults WHERE id = $1', [vault]);
    if (!safeEqual(again.auth_hash, sha(token))) throw errors.unauthorized();
    return;
  }
  if (!safeEqual(v.auth_hash, sha(token))) throw errors.unauthorized();
}

const Put = z.object({
  blob: z.string().regex(/^[A-Za-z0-9+/=_-]+$/),
  expires_at: z.string().datetime().nullable().optional(),
});

export default async function vaultRoutes(app: FastifyInstance) {
  app.get<{ Params: { vault: string } }>('/v1/vault/:vault/items', async (req) => {
    await authorize(req, false);
    const rows = await q<{ item_id: string; updated_at: Date; expires_at: Date | null; size: number }>(
      `SELECT item_id, updated_at, expires_at, length(blob) AS size FROM vault_items
        WHERE vault_id = $1 AND (expires_at IS NULL OR expires_at > now()) ORDER BY updated_at DESC`, [req.params.vault]);
    return { items: rows };
  });

  app.get<{ Params: { vault: string; item: string } }>('/v1/vault/:vault/items/:item', async (req) => {
    await authorize(req, false);
    const [r] = await q<{ blob: string; updated_at: Date; expires_at: Date | null }>(
      `SELECT blob, updated_at, expires_at FROM vault_items WHERE vault_id = $1 AND item_id = $2
         AND (expires_at IS NULL OR expires_at > now())`, [req.params.vault, req.params.item]);
    if (!r) throw errors.notFound('item not found');
    return r;
  });

  app.put<{ Params: { vault: string; item: string } }>(
    '/v1/vault/:vault/items/:item',
    { bodyLimit: (cfg.VAULT_MAX_ITEM_KB + 16) * 1024 },
    async (req, reply) => {
      if (!ITEM.test(req.params.item)) throw errors.bad('bad item id');
      const b = Put.safeParse(req.body);
      if (!b.success) throw errors.bad('blob must be base64');
      if (b.data.blob.length > cfg.VAULT_MAX_ITEM_KB * 1024) throw new ZeepError(413, 'too_large', 'item is too large');
      await authorize(req, true);
      const [{ n }] = await q<{ n: number }>('SELECT count(*)::int AS n FROM vault_items WHERE vault_id = $1', [req.params.vault]);
      if (n >= cfg.VAULT_MAX_ITEMS) throw new ZeepError(413, 'vault_full', 'vault item limit reached; delete old chats');
      await q(
        `INSERT INTO vault_items (vault_id, item_id, blob, expires_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (vault_id, item_id) DO UPDATE SET blob = $3, expires_at = $4, updated_at = now()`,
        [req.params.vault, req.params.item, b.data.blob, b.data.expires_at ?? null]);
      reply.code(204);
    },
  );

  app.delete<{ Params: { vault: string; item: string } }>('/v1/vault/:vault/items/:item', async (req, reply) => {
    await authorize(req, false);
    await q('DELETE FROM vault_items WHERE vault_id = $1 AND item_id = $2', [req.params.vault, req.params.item]);
    reply.code(204);
  });

  /** Delete everything stored for this vault. */
  app.delete<{ Params: { vault: string } }>('/v1/vault/:vault', async (req, reply) => {
    await authorize(req, false);
    await q('DELETE FROM vaults WHERE id = $1', [req.params.vault]);
    reply.code(204);
  });
}
