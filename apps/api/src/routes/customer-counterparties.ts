import type { FastifyInstance } from 'fastify';
import { eq, ilike, inArray, or, sql as drSql } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import { escapeLike } from '../lib/like.js';
import {
  BulkDeleteRequestSchema,
  BulkDeleteResponseSchema,
  CustomerCounterpartyListResponseSchema,
  CustomerCounterpartySchema,
  CustomerCounterpartyUpsertSchema,
  ErrorResponseSchema,
} from '@matcheck/contracts';
import { customerCounterparties } from '../db/schema.js';

// Справочник контрагентов заказчика (см. schema.ts / миграция 0055).
// ОТДЕЛЬНАЯ таблица `customer_counterparties`, не путать с операционной
// `counterparties` — на приёмки/отгрузки/мобилу не влияет.
const ListQuerySchema = z.object({
  q: z.string().optional(),
  limit: z.coerce.number().int().positive().max(5000).default(2000),
  offset: z.coerce.number().int().nonnegative().default(0),
});

function row(c: typeof customerCounterparties.$inferSelect) {
  return {
    id: c.id,
    inn: c.inn,
    name: c.name,
    aliases: c.aliases ?? [],
    address: c.address,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export async function customerCounterpartyRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);

  app.get(
    '/api/v1/customer-counterparties',
    {
      preHandler: [app.authenticate],
      schema: {
        querystring: ListQuerySchema,
        response: { 200: CustomerCounterpartyListResponseSchema },
      },
    },
    async (req) => {
      const { q, limit, offset } = req.query;
      const like = q ? escapeLike(q) : '';
      const where = q
        ? or(
            ilike(customerCounterparties.name, `%${like}%`),
            ilike(customerCounterparties.inn, `${like}%`),
            drSql`exists (select 1 from unnest(${customerCounterparties.aliases}) as a(v) where a.v ilike ${'%' + like + '%'})`,
          )
        : undefined;
      const rows = await app.db
        .select()
        .from(customerCounterparties)
        .where(where)
        .orderBy(customerCounterparties.name)
        .limit(limit)
        .offset(offset);
      const [{ count } = { count: 0 }] = await app.db
        .select({ count: drSql<number>`count(*)::int` })
        .from(customerCounterparties)
        .where(where);
      return { items: rows.map(row), total: count };
    },
  );

  app.post(
    '/api/v1/customer-counterparties',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        body: CustomerCounterpartyUpsertSchema,
        response: { 201: CustomerCounterpartySchema },
      },
    },
    async (req, reply) => {
      const b = req.body;
      const [created] = await app.db
        .insert(customerCounterparties)
        .values({
          inn: (b.inn ?? '').trim(),
          name: b.name.trim(),
          aliases: b.aliases ?? [],
          address: b.address ?? null,
        })
        .returning();
      if (!created) throw new Error('insert failed');
      reply.code(201);
      return row(created);
    },
  );

  app.patch(
    '/api/v1/customer-counterparties/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: CustomerCounterpartyUpsertSchema.partial(),
        response: { 200: CustomerCounterpartySchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const b = req.body;
      const patch: Partial<typeof customerCounterparties.$inferInsert> = { updatedAt: new Date() };
      if (b.inn !== undefined) patch.inn = (b.inn ?? '').trim();
      if (b.name !== undefined) patch.name = b.name.trim();
      if (b.aliases !== undefined) patch.aliases = b.aliases;
      if (b.address !== undefined) patch.address = b.address;
      const [updated] = await app.db
        .update(customerCounterparties)
        .set(patch)
        .where(eq(customerCounterparties.id, req.params.id))
        .returning();
      if (!updated) return reply.code(404).send({ error: 'not_found' });
      return row(updated);
    },
  );

  app.delete(
    '/api/v1/customer-counterparties/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const deleted = await app.db
        .delete(customerCounterparties)
        .where(eq(customerCounterparties.id, req.params.id))
        .returning({ id: customerCounterparties.id });
      if (deleted.length === 0) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );

  app.post(
    '/api/v1/customer-counterparties/bulk-delete',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: { body: BulkDeleteRequestSchema, response: { 200: BulkDeleteResponseSchema } },
    },
    async (req) => {
      const ids = req.body.ids;
      const deletedRows = await app.db
        .delete(customerCounterparties)
        .where(inArray(customerCounterparties.id, ids))
        .returning({ id: customerCounterparties.id });
      const deletedSet = new Set(deletedRows.map((r) => r.id));
      const skipped = ids
        .filter((id) => !deletedSet.has(id))
        .map((id) => ({ id, reason: 'not_found' as const }));
      return { deleted: Array.from(deletedSet), skipped };
    },
  );
}
