import type { FastifyInstance } from 'fastify';
import { eq, ilike, or, sql as drSql } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import {
  MaterialListResponseSchema,
  MaterialSchema,
  MaterialUpsertSchema,
  ErrorResponseSchema,
} from '@matcheck/contracts';
import { materials } from '../db/schema.js';

const ListQuerySchema = z.object({
  q: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

function row(m: typeof materials.$inferSelect) {
  return {
    id: m.id,
    code: m.code,
    name: m.name,
    unit: m.unit,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

export async function materialRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);
  app.get(
    '/api/v1/materials',
    {
      preHandler: [app.authenticate],
      schema: { querystring: ListQuerySchema, response: { 200: MaterialListResponseSchema } },
    },
    async (req) => {
      const { q, limit, offset } = req.query;
      const where = q
        ? or(ilike(materials.name, `%${q}%`), ilike(materials.code, `${q}%`))
        : undefined;
      const rows = await app.db
        .select()
        .from(materials)
        .where(where)
        .orderBy(materials.name)
        .limit(limit)
        .offset(offset);
      const [{ count } = { count: 0 }] = await app.db
        .select({ count: drSql<number>`count(*)::int` })
        .from(materials)
        .where(where);
      return { items: rows.map(row), total: count };
    },
  );

  app.post(
    '/api/v1/materials',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: { body: MaterialUpsertSchema, response: { 201: MaterialSchema } },
    },
    async (req, reply) => {
      const [created] = await app.db.insert(materials).values(req.body).returning();
      if (!created) throw new Error('insert failed');
      reply.code(201);
      return row(created);
    },
  );

  app.patch(
    '/api/v1/materials/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: MaterialUpsertSchema.partial(),
        response: { 200: MaterialSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const [updated] = await app.db
        .update(materials)
        .set({ ...req.body, updatedAt: new Date() })
        .where(eq(materials.id, req.params.id))
        .returning();
      if (!updated) return reply.code(404).send({ error: 'not_found' });
      return row(updated);
    },
  );

  app.delete(
    '/api/v1/materials/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const deleted = await app.db
        .delete(materials)
        .where(eq(materials.id, req.params.id))
        .returning({ id: materials.id });
      if (deleted.length === 0) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );
}
