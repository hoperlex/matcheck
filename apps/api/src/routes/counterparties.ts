import type { FastifyInstance } from 'fastify';
import { and, eq, ilike, or, sql as drSql } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import {
  CounterpartyListResponseSchema,
  CounterpartySchema,
  CounterpartyUpsertSchema,
  ErrorResponseSchema,
} from '@matcheck/contracts';
import { counterparties } from '../db/schema.js';

const ListQuerySchema = z.object({
  q: z.string().optional(),
  role: z.enum(['supplier', 'customer', 'carrier']).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

function row(c: typeof counterparties.$inferSelect) {
  return {
    id: c.id,
    inn: c.inn,
    kpp: c.kpp,
    name: c.name,
    address: c.address,
    isSelf: c.isSelf,
    isSupplier: c.isSupplier,
    isCustomer: c.isCustomer,
    isCarrier: c.isCarrier,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export async function counterpartyRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);
  app.get(
    '/api/v1/counterparties',
    {
      preHandler: [app.authenticate],
      schema: { querystring: ListQuerySchema, response: { 200: CounterpartyListResponseSchema } },
    },
    async (req) => {
      const { q, role, limit, offset } = req.query;
      const filters = [];
      if (q) {
        filters.push(or(ilike(counterparties.name, `%${q}%`), ilike(counterparties.inn, `${q}%`)));
      }
      if (role === 'supplier') filters.push(eq(counterparties.isSupplier, true));
      if (role === 'customer') filters.push(eq(counterparties.isCustomer, true));
      if (role === 'carrier') filters.push(eq(counterparties.isCarrier, true));
      const where = filters.length ? and(...filters) : undefined;

      const rows = await app.db
        .select()
        .from(counterparties)
        .where(where)
        .orderBy(counterparties.name)
        .limit(limit)
        .offset(offset);
      const [{ count } = { count: 0 }] = await app.db
        .select({ count: drSql<number>`count(*)::int` })
        .from(counterparties)
        .where(where);
      return { items: rows.map(row), total: count };
    },
  );

  app.post(
    '/api/v1/counterparties',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        body: CounterpartyUpsertSchema,
        response: { 201: CounterpartySchema, 409: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      try {
        const [created] = await app.db.insert(counterparties).values(req.body).returning();
        if (!created) throw new Error('insert failed');
        reply.code(201);
        return row(created);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('unique')) {
          return reply.code(409).send({
            error: 'duplicate_inn_kpp',
            message: 'Counterparty with this INN/KPP already exists',
          });
        }
        throw err;
      }
    },
  );

  app.patch(
    '/api/v1/counterparties/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: CounterpartyUpsertSchema.partial(),
        response: { 200: CounterpartySchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const [updated] = await app.db
        .update(counterparties)
        .set({ ...req.body, updatedAt: new Date() })
        .where(eq(counterparties.id, req.params.id))
        .returning();
      if (!updated) return reply.code(404).send({ error: 'not_found' });
      return row(updated);
    },
  );

  app.delete(
    '/api/v1/counterparties/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const deleted = await app.db
        .delete(counterparties)
        .where(eq(counterparties.id, req.params.id))
        .returning({ id: counterparties.id });
      if (deleted.length === 0) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );
}
