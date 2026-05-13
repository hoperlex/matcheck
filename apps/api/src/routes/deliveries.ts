import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, sql as drSql } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import {
  ConflictResponseSchema,
  DeliveryListResponseSchema,
  DeliverySchema,
  DeliveryUpsertSchema,
  ErrorResponseSchema,
} from '@matcheck/contracts';
import { deliveries, deliveryItems, deliveryPhotos, deliverySources } from '../db/schema.js';
import { publishEvent } from './events.js';

const ListQuerySchema = z.object({
  status: z.enum(['expected', 'arrived', 'verified', 'rejected']).optional(),
  inspectorId: z.string().uuid().optional(),
  changedSince: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildDeliveryDto(app: any, id: string) {
  const [d] = await app.db.select().from(deliveries).where(eq(deliveries.id, id)).limit(1);
  if (!d) return null;
  const items: (typeof deliveryItems.$inferSelect)[] = await app.db
    .select()
    .from(deliveryItems)
    .where(eq(deliveryItems.deliveryId, id))
    .orderBy(deliveryItems.lineNo);
  const photos: (typeof deliveryPhotos.$inferSelect)[] = await app.db
    .select()
    .from(deliveryPhotos)
    .where(eq(deliveryPhotos.deliveryId, id));
  const sources: { sourceDocumentId: string }[] = await app.db
    .select({ sourceDocumentId: deliverySources.sourceDocumentId })
    .from(deliverySources)
    .where(eq(deliverySources.deliveryId, id));
  return {
    id: d.id,
    status: d.status,
    supplierId: d.supplierId,
    vehiclePlate: d.vehiclePlate,
    driverName: d.driverName,
    arrivedAt: d.arrivedAt?.toISOString() ?? null,
    inspectorId: d.inspectorId,
    comment: d.comment,
    version: d.version,
    sourceDocumentIds: sources.map((s) => s.sourceDocumentId),
    items: items.map((i) => ({
      id: i.id,
      materialId: i.materialId,
      nameRaw: i.nameRaw,
      qtyPlanned: i.qtyPlanned,
      qtyActual: i.qtyActual,
      unit: i.unit,
      comment: i.comment,
      lineNo: i.lineNo,
    })),
    photos: photos.map((p) => ({
      id: p.id,
      kind: p.kind,
      s3Key: p.s3Key,
      thumbS3Key: p.thumbS3Key,
      contentHash: p.contentHash,
      takenAt: p.takenAt.toISOString(),
    })),
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

export async function deliveryRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);
  app.get(
    '/api/v1/deliveries',
    {
      preHandler: [app.authenticate],
      schema: { querystring: ListQuerySchema, response: { 200: DeliveryListResponseSchema } },
    },
    async (req) => {
      const { status, inspectorId, changedSince, limit, offset } = req.query;
      const filters = [];
      if (status) filters.push(eq(deliveries.status, status));
      // inspector_kpp видит только свои приёмки
      if (req.user?.role === 'inspector_kpp') {
        filters.push(eq(deliveries.inspectorId, req.user.id));
      } else if (inspectorId) {
        filters.push(eq(deliveries.inspectorId, inspectorId));
      }
      if (changedSince) filters.push(gte(deliveries.updatedAt, new Date(changedSince)));
      const where = filters.length ? and(...filters) : undefined;

      const rows = await app.db
        .select({ id: deliveries.id })
        .from(deliveries)
        .where(where)
        .orderBy(desc(deliveries.updatedAt))
        .limit(limit)
        .offset(offset);
      const [{ count } = { count: 0 }] = await app.db
        .select({ count: drSql<number>`count(*)::int` })
        .from(deliveries)
        .where(where);

      const items = (await Promise.all(rows.map((r) => buildDeliveryDto(app, r.id)))).filter(
        (x): x is NonNullable<typeof x> => x !== null,
      );
      return { items, total: count };
    },
  );

  app.get(
    '/api/v1/deliveries/:id',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: DeliverySchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const dto = await buildDeliveryDto(app, req.params.id);
      if (!dto) return reply.code(404).send({ error: 'not_found' });
      if (req.user?.role === 'inspector_kpp' && dto.inspectorId !== req.user.id) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return dto;
    },
  );

  app.post(
    '/api/v1/deliveries',
    {
      preHandler: [app.authenticate],
      schema: {
        body: DeliveryUpsertSchema,
        response: {
          200: DeliverySchema,
          404: ErrorResponseSchema,
          409: ConflictResponseSchema,
          400: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const input = req.body;
      const inspectorId = req.user?.role === 'inspector_kpp' ? req.user.id : (req.user?.id ?? null);

      // OCC update
      if (input.id) {
        const [existing] = await app.db
          .select()
          .from(deliveries)
          .where(eq(deliveries.id, input.id))
          .limit(1);
        if (!existing) {
          // Create as upsert with explicit id (for offline-created drafts that got assigned id locally)
          await createDelivery(app, input, inspectorId);
        } else {
          if (input.baseVersion !== undefined && input.baseVersion !== existing.version) {
            const server = await buildDeliveryDto(app, existing.id);
            return reply.code(409).send({
              error: 'conflict' as const,
              serverVersion: existing.version,
              server: server!,
            });
          }
          await updateDelivery(app, existing.id, input);
        }
        const dto = await buildDeliveryDto(app, input.id);
        if (!dto) return reply.code(404).send({ error: 'not_found' });
        publishEvent(app, { type: 'delivery_updated', id: dto.id, ts: new Date().toISOString() });
        return dto;
      }

      const created = await createDelivery(app, input, inspectorId);
      const dto = await buildDeliveryDto(app, created.id);
      if (!dto) throw new Error('Delivery missing after create');
      publishEvent(app, { type: 'delivery_updated', id: dto.id, ts: new Date().toISOString() });
      return dto;
    },
  );

  app.delete(
    '/api/v1/deliveries/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const deleted = await app.db
        .delete(deliveries)
        .where(eq(deliveries.id, req.params.id))
        .returning({ id: deliveries.id });
      if (deleted.length === 0) return reply.code(404).send({ error: 'not_found' });
      publishEvent(app, {
        type: 'delivery_deleted',
        id: req.params.id,
        ts: new Date().toISOString(),
      });
      return { ok: true };
    },
  );
}

async function createDelivery(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  input: z.infer<typeof DeliveryUpsertSchema>,
  inspectorId: string | null,
) {
  const [created] = await app.db
    .insert(deliveries)
    .values({
      id: input.id,
      status: input.status,
      supplierId: input.supplierId ?? null,
      vehiclePlate: input.vehiclePlate ?? null,
      driverName: input.driverName ?? null,
      arrivedAt: input.arrivedAt ? new Date(input.arrivedAt) : null,
      inspectorId,
      comment: input.comment ?? null,
      version: 1,
    })
    .returning();
  if (!created) throw new Error('Failed to insert delivery');
  if (input.items.length) {
    await app.db.insert(deliveryItems).values(
      input.items.map((i) => ({
        deliveryId: created.id,
        materialId: i.materialId ?? null,
        nameRaw: i.nameRaw,
        qtyPlanned: i.qtyPlanned ?? null,
        qtyActual: i.qtyActual ?? null,
        unit: i.unit,
        comment: i.comment ?? null,
        lineNo: i.lineNo,
      })),
    );
  }
  if (input.sourceDocumentIds.length) {
    await app.db
      .insert(deliverySources)
      .values(
        input.sourceDocumentIds.map((sid) => ({ deliveryId: created.id, sourceDocumentId: sid })),
      );
  }
  return created;
}

async function updateDelivery(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  id: string,
  input: z.infer<typeof DeliveryUpsertSchema>,
) {
  await app.db
    .update(deliveries)
    .set({
      status: input.status,
      supplierId: input.supplierId ?? null,
      vehiclePlate: input.vehiclePlate ?? null,
      driverName: input.driverName ?? null,
      arrivedAt: input.arrivedAt ? new Date(input.arrivedAt) : null,
      comment: input.comment ?? null,
      version: drSql`${deliveries.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(deliveries.id, id));
  await app.db.delete(deliveryItems).where(eq(deliveryItems.deliveryId, id));
  if (input.items.length) {
    await app.db.insert(deliveryItems).values(
      input.items.map((i) => ({
        deliveryId: id,
        materialId: i.materialId ?? null,
        nameRaw: i.nameRaw,
        qtyPlanned: i.qtyPlanned ?? null,
        qtyActual: i.qtyActual ?? null,
        unit: i.unit,
        comment: i.comment ?? null,
        lineNo: i.lineNo,
      })),
    );
  }
  await app.db.delete(deliverySources).where(eq(deliverySources.deliveryId, id));
  if (input.sourceDocumentIds.length) {
    await app.db
      .insert(deliverySources)
      .values(input.sourceDocumentIds.map((sid) => ({ deliveryId: id, sourceDocumentId: sid })));
  }
}
