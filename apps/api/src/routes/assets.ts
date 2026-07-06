import type { FastifyInstance } from 'fastify';
import { and, eq, ilike, or, sql as drSql } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import {
  AssetListResponseSchema,
  AssetSchema,
  AssetUpsertSchema,
  ErrorResponseSchema,
} from '@matcheck/contracts';
import { assets, entityDeletions } from '../db/schema.js';

const ListQuerySchema = z.object({
  q: z.string().optional(),
  activeOnly: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
  offset: z.coerce.number().int().nonnegative().default(0),
});

function row(a: typeof assets.$inferSelect) {
  return {
    id: a.id,
    code: a.code,
    name: a.name,
    unit: a.unit,
    isActive: a.isActive,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

export async function assetRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);

  app.get(
    '/api/v1/assets',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager', 'inspector_kpp', 'monitor')],
      schema: { querystring: ListQuerySchema, response: { 200: AssetListResponseSchema } },
    },
    async (req) => {
      const { q, activeOnly, limit, offset } = req.query;
      const filters = [];
      if (q) filters.push(or(ilike(assets.name, `%${q}%`), ilike(assets.code, `${q}%`))!);
      if (activeOnly) filters.push(eq(assets.isActive, true));
      const where = filters.length ? and(...filters) : undefined;

      const rows = await app.db
        .select()
        .from(assets)
        .where(where)
        .orderBy(assets.name)
        .limit(limit)
        .offset(offset);
      const [{ count } = { count: 0 }] = await app.db
        .select({ count: drSql<number>`count(*)::int` })
        .from(assets)
        .where(where);
      return { items: rows.map(row), total: count };
    },
  );

  app.post(
    '/api/v1/assets',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: { body: AssetUpsertSchema, response: { 201: AssetSchema } },
    },
    async (req, reply) => {
      const [created] = await app.db.insert(assets).values(req.body).returning();
      if (!created) throw new Error('insert failed');
      reply.code(201);
      return row(created);
    },
  );

  app.patch(
    '/api/v1/assets/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: AssetUpsertSchema.partial(),
        response: { 200: AssetSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const [updated] = await app.db
        .update(assets)
        .set({ ...req.body, updatedAt: new Date() })
        .where(eq(assets.id, req.params.id))
        .returning();
      if (!updated) return reply.code(404).send({ error: 'not_found' });
      return row(updated);
    },
  );

  app.delete(
    '/api/v1/assets/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      // Hard-delete + запись в журнал hard-delete для офлайн-клиентов
      // (см. /sync.deletedIds.assets). siteId=null — глобальный справочник.
      const result = await app.db.transaction(async (tx) => {
        const deleted = await tx
          .delete(assets)
          .where(eq(assets.id, req.params.id))
          .returning({ id: assets.id });
        if (deleted.length === 0) return null;
        await tx.insert(entityDeletions).values({
          entityType: 'asset',
          entityId: req.params.id,
          siteId: null,
          deletedByUserId: req.user?.id ?? null,
        });
        return deleted[0];
      });
      if (!result) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );
}
