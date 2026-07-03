import type { FastifyInstance } from 'fastify';
import { eq, ilike, inArray, or, sql as drSql } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import { escapeLike } from '../lib/like.js';
import {
  BulkDeleteRequestSchema,
  BulkDeleteResponseSchema,
  ErrorResponseSchema,
  SupplierListResponseSchema,
  SupplierSchema,
  SupplierUpsertSchema,
} from '@matcheck/contracts';
import { suppliers } from '../db/schema.js';

// Справочник поставщиков заказчика (см. schema.ts / миграция 0055).
// ОТДЕЛЬНАЯ таблица, не операционная `counterparties` — на приёмки/отгрузки/
// мобилу не влияет. Лимит по умолчанию высокий: справочник цельный (~1000),
// фронт тянет весь список и фильтрует/сортирует на клиенте.
const ListQuerySchema = z.object({
  q: z.string().optional(),
  limit: z.coerce.number().int().positive().max(5000).default(2000),
  offset: z.coerce.number().int().nonnegative().default(0),
});

function row(s: typeof suppliers.$inferSelect) {
  return {
    id: s.id,
    inn: s.inn,
    name: s.name,
    aliases: s.aliases ?? [],
    lastSecurityStatus: s.lastSecurityStatus,
    foundingDocumentsComment: s.foundingDocumentsComment,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

export async function supplierRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);

  app.get(
    '/api/v1/suppliers',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager', 'inspector_kpp')],
      schema: { querystring: ListQuerySchema, response: { 200: SupplierListResponseSchema } },
    },
    async (req) => {
      const { q, limit, offset } = req.query;
      const like = q ? escapeLike(q) : '';
      const where = q
        ? or(
            ilike(suppliers.name, `%${like}%`),
            ilike(suppliers.inn, `${like}%`),
            drSql`exists (select 1 from unnest(${suppliers.aliases}) as a(v) where a.v ilike ${'%' + like + '%'})`,
          )
        : undefined;
      const rows = await app.db
        .select()
        .from(suppliers)
        .where(where)
        .orderBy(suppliers.name)
        .limit(limit)
        .offset(offset);
      const [{ count } = { count: 0 }] = await app.db
        .select({ count: drSql<number>`count(*)::int` })
        .from(suppliers)
        .where(where);
      return { items: rows.map(row), total: count };
    },
  );

  app.post(
    '/api/v1/suppliers',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: { body: SupplierUpsertSchema, response: { 201: SupplierSchema } },
    },
    async (req, reply) => {
      const b = req.body;
      const [created] = await app.db
        .insert(suppliers)
        .values({
          inn: (b.inn ?? '').trim(),
          name: b.name.trim(),
          aliases: b.aliases ?? [],
          lastSecurityStatus: b.lastSecurityStatus ?? null,
          foundingDocumentsComment: b.foundingDocumentsComment ?? null,
        })
        .returning();
      if (!created) throw new Error('insert failed');
      reply.code(201);
      return row(created);
    },
  );

  app.patch(
    '/api/v1/suppliers/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: SupplierUpsertSchema.partial(),
        response: { 200: SupplierSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const b = req.body;
      const patch: Partial<typeof suppliers.$inferInsert> = { updatedAt: new Date() };
      if (b.inn !== undefined) patch.inn = (b.inn ?? '').trim();
      if (b.name !== undefined) patch.name = b.name.trim();
      if (b.aliases !== undefined) patch.aliases = b.aliases;
      if (b.lastSecurityStatus !== undefined) patch.lastSecurityStatus = b.lastSecurityStatus;
      if (b.foundingDocumentsComment !== undefined)
        patch.foundingDocumentsComment = b.foundingDocumentsComment;
      const [updated] = await app.db
        .update(suppliers)
        .set(patch)
        .where(eq(suppliers.id, req.params.id))
        .returning();
      if (!updated) return reply.code(404).send({ error: 'not_found' });
      return row(updated);
    },
  );

  app.delete(
    '/api/v1/suppliers/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const deleted = await app.db
        .delete(suppliers)
        .where(eq(suppliers.id, req.params.id))
        .returning({ id: suppliers.id });
      if (deleted.length === 0) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );

  app.post(
    '/api/v1/suppliers/bulk-delete',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: { body: BulkDeleteRequestSchema, response: { 200: BulkDeleteResponseSchema } },
    },
    async (req) => {
      const ids = req.body.ids;
      const deletedRows = await app.db
        .delete(suppliers)
        .where(inArray(suppliers.id, ids))
        .returning({ id: suppliers.id });
      const deletedSet = new Set(deletedRows.map((r) => r.id));
      const skipped = ids
        .filter((id) => !deletedSet.has(id))
        .map((id) => ({ id, reason: 'not_found' as const }));
      return { deleted: Array.from(deletedSet), skipped };
    },
  );
}
