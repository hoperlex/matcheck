import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, ne, or, sql as drSql } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import {
  ConflictResponseSchema,
  DeliveryListResponseSchema,
  DeliverySchema,
  DeliveryStatusCodeSchema,
  DeliveryUpsertSchema,
  ErrorResponseSchema,
} from '@matcheck/contracts';
import {
  deliveries,
  deliveryItems,
  deliveryPhotos,
  deliverySources,
  statuses,
} from '../db/schema.js';
import { deleteObject } from '../domain/storage/s3.signer.js';
import { resolveStatusId as resolveStatusIdShared } from '../domain/statuses/lookup.js';
import { publishEvent } from './events.js';

const ListQuerySchema = z.object({
  status: DeliveryStatusCodeSchema.optional(),
  inspectorId: z.string().uuid().optional(),
  changedSince: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

type StatusRow = typeof statuses.$inferSelect;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolveStatusId = (app: any, code: string) =>
  resolveStatusIdShared(app, 'delivery', code);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildDeliveryDto(app: any, id: string) {
  const rows = await app.db
    .select({ d: deliveries, s: statuses })
    .from(deliveries)
    .innerJoin(statuses, eq(deliveries.statusId, statuses.id))
    .where(eq(deliveries.id, id))
    .limit(1);
  const r = rows[0] as { d: typeof deliveries.$inferSelect; s: StatusRow } | undefined;
  if (!r) return null;
  const d = r.d;
  const s = r.s;
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
    status: {
      id: s.id,
      entityType: s.entityType,
      code: s.code,
      label: s.label,
      color: s.color,
      sortOrder: s.sortOrder,
    },
    supplierId: d.supplierId,
    vehiclePlate: d.vehiclePlate,
    driverName: d.driverName,
    arrivedAt: d.arrivedAt?.toISOString() ?? null,
    inspectorId: d.inspectorId,
    comment: d.comment,
    version: d.version,
    sourceDocumentIds: sources.map((x) => x.sourceDocumentId),
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
      if (status) {
        const statusId = await resolveStatusId(app, status);
        filters.push(eq(deliveries.statusId, statusId));
      }
      // inspector_kpp видит только свои приёмки
      if (req.user?.role === 'inspector_kpp') {
        filters.push(eq(deliveries.inspectorId, req.user.id));
      } else if (inspectorId) {
        filters.push(eq(deliveries.inspectorId, inspectorId));
      }
      // Чужие черновики (draft) скрыты, если status не указан явно
      if (!status && req.user?.role !== 'inspector_kpp' && req.user) {
        const draftId = await resolveStatusId(app, 'draft');
        filters.push(
          or(ne(deliveries.statusId, draftId), eq(deliveries.inspectorId, req.user.id))!,
        );
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
      const statusId = await resolveStatusId(app, input.statusCode);

      // OCC update
      if (input.id) {
        const [existing] = await app.db
          .select()
          .from(deliveries)
          .where(eq(deliveries.id, input.id))
          .limit(1);
        if (!existing) {
          // Create as upsert with explicit id (для офлайн-черновиков с локально сгенерированным id)
          await createDelivery(app, input, statusId, inspectorId);
        } else {
          if (input.baseVersion !== undefined && input.baseVersion !== existing.version) {
            const server = await buildDeliveryDto(app, existing.id);
            return reply.code(409).send({
              error: 'conflict' as const,
              serverVersion: existing.version,
              server: server!,
            });
          }
          await updateDelivery(app, existing.id, input, statusId);
        }
        const dto = await buildDeliveryDto(app, input.id);
        if (!dto) return reply.code(404).send({ error: 'not_found' });
        publishEvent(app, { type: 'delivery_updated', id: dto.id, ts: new Date().toISOString() });
        return dto;
      }

      const created = await createDelivery(app, input, statusId, inspectorId);
      const dto = await buildDeliveryDto(app, created.id);
      if (!dto) throw new Error('Delivery missing after create');
      publishEvent(app, { type: 'delivery_updated', id: dto.id, ts: new Date().toISOString() });
      return dto;
    },
  );

  app.delete(
    '/api/v1/deliveries/:id',
    {
      preHandler: [app.authenticate],
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const [existing] = await app.db
        .select()
        .from(deliveries)
        .where(eq(deliveries.id, req.params.id))
        .limit(1);
      if (!existing) return reply.code(404).send({ error: 'not_found' });

      // inspector_kpp может удалять только свои приёмки.
      // admin/manager — любые.
      const role = req.user?.role;
      const isOwner = existing.inspectorId === req.user?.id;
      if (role === 'inspector_kpp' && !isOwner) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      if (role !== 'admin' && role !== 'manager' && role !== 'inspector_kpp') {
        return reply.code(403).send({ error: 'forbidden' });
      }

      // Удаляем S3-объекты фото перед каскадным удалением записей.
      const photos = await app.db
        .select({ s3Key: deliveryPhotos.s3Key, thumbS3Key: deliveryPhotos.thumbS3Key })
        .from(deliveryPhotos)
        .where(eq(deliveryPhotos.deliveryId, req.params.id));
      for (const p of photos) {
        try {
          await deleteObject(p.s3Key);
          if (p.thumbS3Key) await deleteObject(p.thumbS3Key);
        } catch (err) {
          req.log.warn({ err, s3Key: p.s3Key }, 'failed to delete s3 object');
        }
      }

      await app.db.delete(deliveries).where(eq(deliveries.id, req.params.id));
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
  statusId: string,
  inspectorId: string | null,
) {
  const [created] = await app.db
    .insert(deliveries)
    .values({
      id: input.id,
      statusId,
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
  statusId: string,
) {
  await app.db
    .update(deliveries)
    .set({
      statusId,
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
