import type { FastifyInstance } from 'fastify';
import { asc, eq, ilike, inArray, or, sql as drSql } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import {
  BulkDeleteRequestSchema,
  BulkDeleteResponseSchema,
  ErrorResponseSchema,
  UnitListResponseSchema,
  UnitSchema,
  UnitUpsertSchema,
} from '@matcheck/contracts';
import { units } from '../db/schema.js';

// Справочник единиц измерения (см. миграцию 0062, schema.ts → units).
// CRUD по образцу customer-counterparties / suppliers.

const ListQuerySchema = z.object({
  q: z.string().optional(),
  limit: z.coerce.number().int().positive().max(2000).default(500),
  offset: z.coerce.number().int().nonnegative().default(0),
  activeOnly: z.coerce.boolean().default(false),
});

function row(u: typeof units.$inferSelect) {
  return {
    id: u.id,
    code: u.code,
    name: u.name,
    okeiCode: u.okeiCode,
    isActive: u.isActive,
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
  };
}

export async function unitRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);

  app.get(
    '/api/v1/units',
    {
      preHandler: [app.authenticate],
      schema: { querystring: ListQuerySchema, response: { 200: UnitListResponseSchema } },
    },
    async (req) => {
      const { q, limit, offset, activeOnly } = req.query;
      const conds = [];
      if (q) {
        conds.push(
          or(ilike(units.code, `%${q}%`), ilike(units.name, `%${q}%`)),
        );
      }
      if (activeOnly) conds.push(eq(units.isActive, true));
      const where = conds.length ? conds.reduce((a, b) => drSql`${a} AND ${b}`) : undefined;

      const rows = await app.db
        .select()
        .from(units)
        .where(where)
        .orderBy(asc(units.name))
        .limit(limit)
        .offset(offset);
      const [{ count } = { count: 0 }] = await app.db
        .select({ count: drSql<number>`count(*)::int` })
        .from(units)
        .where(where);
      return { items: rows.map(row), total: count };
    },
  );

  app.post(
    '/api/v1/units',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        body: UnitUpsertSchema,
        response: { 201: UnitSchema, 409: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const b = req.body;
      try {
        const [created] = await app.db
          .insert(units)
          .values({
            code: b.code.trim(),
            name: b.name.trim(),
            okeiCode: b.okeiCode?.trim() || null,
            isActive: b.isActive ?? true,
          })
          .returning();
        if (!created) throw new Error('insert failed');
        reply.code(201);
        return row(created);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('units_code_unique')) {
          return reply.code(409).send({
            error: 'duplicate_code',
            message: 'Единица с таким кодом уже существует',
          });
        }
        throw err;
      }
    },
  );

  app.patch(
    '/api/v1/units/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: UnitUpsertSchema.partial(),
        response: { 200: UnitSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const b = req.body;
      const patch: Partial<typeof units.$inferInsert> = { updatedAt: new Date() };
      if (b.code !== undefined) patch.code = b.code.trim();
      if (b.name !== undefined) patch.name = b.name.trim();
      if (b.okeiCode !== undefined) patch.okeiCode = b.okeiCode?.trim() || null;
      if (b.isActive !== undefined) patch.isActive = b.isActive;
      try {
        const [updated] = await app.db
          .update(units)
          .set(patch)
          .where(eq(units.id, req.params.id))
          .returning();
        if (!updated) return reply.code(404).send({ error: 'not_found' });
        return row(updated);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('units_code_unique')) {
          return reply.code(409).send({
            error: 'duplicate_code',
            message: 'Единица с таким кодом уже существует',
          });
        }
        throw err;
      }
    },
  );

  app.delete(
    '/api/v1/units/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const deleted = await app.db
        .delete(units)
        .where(eq(units.id, req.params.id))
        .returning({ id: units.id });
      if (deleted.length === 0) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );

  app.post(
    '/api/v1/units/bulk-delete',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: { body: BulkDeleteRequestSchema, response: { 200: BulkDeleteResponseSchema } },
    },
    async (req) => {
      const ids = req.body.ids;
      const deletedRows = await app.db
        .delete(units)
        .where(inArray(units.id, ids))
        .returning({ id: units.id });
      const deletedSet = new Set(deletedRows.map((r) => r.id));
      const skipped = ids
        .filter((id) => !deletedSet.has(id))
        .map((id) => ({ id, reason: 'not_found' as const }));
      return { deleted: Array.from(deletedSet), skipped };
    },
  );
}
