import type { FastifyInstance } from 'fastify';
import { and, desc, eq, ilike, or, sql as drSql } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import {
  MaterialJournalResponseSchema,
  MaterialListResponseSchema,
  MaterialSchema,
  MaterialUpsertSchema,
  ErrorResponseSchema,
} from '@matcheck/contracts';
import {
  counterparties,
  deliveries,
  deliveryItems,
  deliverySources,
  materials,
  sourceDocuments,
} from '../db/schema.js';
import { resolveStatusId } from '../domain/statuses/lookup.js';

const ListQuerySchema = z.object({
  q: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

const JournalQuerySchema = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  supplierId: z.string().uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
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
    '/api/v1/materials/journal',
    {
      preHandler: [app.authenticate],
      schema: {
        querystring: JournalQuerySchema,
        response: { 200: MaterialJournalResponseSchema },
      },
    },
    async (req) => {
      const { q, supplierId, from, to, limit, offset } = req.query;
      const filledStatusId = await resolveStatusId(app, 'delivery', 'filled');
      const conditions = [eq(deliveries.statusId, filledStatusId)];
      if (q) {
        conditions.push(
          or(
            ilike(deliveryItems.nameRaw, `%${q}%`),
            ilike(materials.name, `%${q}%`),
          )!,
        );
      }
      if (supplierId) conditions.push(eq(sourceDocuments.supplierId, supplierId));
      if (from) conditions.push(drSql`${deliveries.arrivedAt} >= ${new Date(from)}`);
      if (to) conditions.push(drSql`${deliveries.arrivedAt} <= ${new Date(to)}`);

      const where = and(...conditions);

      const rows = await app.db
        .select({
          itemId: deliveryItems.id,
          deliveryId: deliveries.id,
          materialId: deliveryItems.materialId,
          materialName: materials.name,
          nameRaw: deliveryItems.nameRaw,
          unit: deliveryItems.unit,
          qtyPlanned: deliveryItems.qtyPlanned,
          qtyActual: deliveryItems.qtyActual,
          arrivedAt: deliveries.arrivedAt,
          supplierId: counterparties.id,
          supplierName: counterparties.name,
          sourceDocumentId: sourceDocuments.id,
          docNumber: sourceDocuments.docNumber,
          docDate: sourceDocuments.docDate,
        })
        .from(deliveryItems)
        .innerJoin(deliveries, eq(deliveries.id, deliveryItems.deliveryId))
        .leftJoin(materials, eq(materials.id, deliveryItems.materialId))
        .leftJoin(deliverySources, eq(deliverySources.deliveryId, deliveries.id))
        .leftJoin(sourceDocuments, eq(sourceDocuments.id, deliverySources.sourceDocumentId))
        .leftJoin(counterparties, eq(counterparties.id, sourceDocuments.supplierId))
        .where(where)
        .orderBy(desc(deliveries.arrivedAt))
        .limit(limit)
        .offset(offset);

      const [{ count } = { count: 0 }] = await app.db
        .select({ count: drSql<number>`count(*)::int` })
        .from(deliveryItems)
        .innerJoin(deliveries, eq(deliveries.id, deliveryItems.deliveryId))
        .leftJoin(materials, eq(materials.id, deliveryItems.materialId))
        .leftJoin(deliverySources, eq(deliverySources.deliveryId, deliveries.id))
        .leftJoin(sourceDocuments, eq(sourceDocuments.id, deliverySources.sourceDocumentId))
        .leftJoin(counterparties, eq(counterparties.id, sourceDocuments.supplierId))
        .where(where);

      return {
        items: rows.map((r) => ({
          id: `${r.itemId}:${r.sourceDocumentId ?? 'none'}`,
          deliveryId: r.deliveryId,
          materialId: r.materialId,
          materialName: r.materialName ?? r.nameRaw,
          unit: r.unit,
          qty: r.qtyActual ?? r.qtyPlanned ?? '0',
          supplierId: r.supplierId,
          supplierName: r.supplierName,
          sourceDocumentId: r.sourceDocumentId,
          docNumber: r.docNumber,
          docDate: r.docDate ? r.docDate.toISOString().slice(0, 10) : null,
          arrivedAt: r.arrivedAt ? r.arrivedAt.toISOString() : null,
        })),
        total: count,
      };
    },
  );

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
