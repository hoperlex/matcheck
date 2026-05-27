import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, inArray, isNotNull, isNull, ne, or, sql as drSql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import {
  ConflictResponseSchema,
  DeliveryListResponseSchema,
  DeliveryMarkDeletionSchema,
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
  entityDeletions,
  shipments,
  sites,
  sourceDocumentItems,
  statuses,
  users,
} from '../db/schema.js';
import { deleteObject } from '../domain/storage/s3.signer.js';
import {
  getStatusCodeById,
  resolveStatusId as resolveStatusIdShared,
} from '../domain/statuses/lookup.js';
import { publishEvent } from './events.js';

const ListQuerySchema = z.object({
  status: DeliveryStatusCodeSchema.optional(),
  inspectorId: z.string().uuid().optional(),
  changedSince: z.string().datetime().optional(),
  // По умолчанию (false/unset) скрывает помеченные на удаление; trash=true показывает корзину.
  trash: z.coerce.boolean().optional(),
  // Фильтр по наличию привязанной УПД: true — только без документа,
  // false — только с документом, undefined — без фильтра.
  noDocument: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

// Статусы, при которых разрешён hard-delete без предварительной пометки.
const HARD_DELETE_STATUSES = new Set(['draft', 'not_filled']);
// Статусы, для которых соответственно требуется soft-delete (mark → admin hard).
const SOFT_DELETE_STATUSES = new Set(['filled', 'confirmed_mol']);

type StatusRow = typeof statuses.$inferSelect;

class SourceAlreadyLinkedError extends Error {
  constructor(public readonly sourceDocumentIds: string[]) {
    super('source_document_already_linked');
  }
}

// УПД должна быть привязана не более чем к одной приёмке. Проверяем, что
// заявленные source_document_id не заняты другой приёмкой. excludeDeliveryId
// нужен для обновления: те же УПД могут уже быть привязаны к текущей приёмке.
async function assertSourcesAvailableForDelivery(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  sourceDocumentIds: string[],
  excludeDeliveryId: string | null,
) {
  if (!sourceDocumentIds.length) return;
  const conds = [inArray(deliverySources.sourceDocumentId, sourceDocumentIds)];
  if (excludeDeliveryId) conds.push(ne(deliverySources.deliveryId, excludeDeliveryId));
  const taken = await app.db
    .select({ sourceDocumentId: deliverySources.sourceDocumentId })
    .from(deliverySources)
    .where(and(...conds));
  if (taken.length) {
    throw new SourceAlreadyLinkedError(taken.map((r: { sourceDocumentId: string }) => r.sourceDocumentId));
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolveStatusId = (app: any, code: string) =>
  resolveStatusIdShared(app, 'delivery', code);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildDeliveryDto(app: any, id: string) {
  // Два независимых join на users: один на МОЛ, другой на автора soft-delete пометки.
  // Для парных приёмок (transfer) подтягиваем плоско дату отгрузки и
  // объект-источник из связанного shipment + sites.
  const pendingUser = alias(users, 'pending_user');
  const rows = await app.db
    .select({
      d: deliveries,
      s: statuses,
      molEmail: users.email,
      pendingEmail: pendingUser.email,
      srcShippedAt: shipments.shippedAt,
      srcSiteId: shipments.siteId,
      srcSiteCode: sites.code,
    })
    .from(deliveries)
    .innerJoin(statuses, eq(deliveries.statusId, statuses.id))
    .leftJoin(users, eq(deliveries.confirmedByMolUserId, users.id))
    .leftJoin(pendingUser, eq(deliveries.pendingDeletionByUserId, pendingUser.id))
    .leftJoin(shipments, eq(deliveries.sourceShipmentId, shipments.id))
    .leftJoin(sites, eq(shipments.siteId, sites.id))
    .where(eq(deliveries.id, id))
    .limit(1);
  const r = rows[0] as
    | {
        d: typeof deliveries.$inferSelect;
        s: StatusRow;
        molEmail: string | null;
        pendingEmail: string | null;
        srcShippedAt: Date | null;
        srcSiteId: string | null;
        srcSiteCode: string | null;
      }
    | undefined;
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
    siteId: d.siteId,
    supplierId: d.supplierId,
    contractorId: d.contractorId,
    recipientMolId: d.recipientMolId,
    vehiclePlate: d.vehiclePlate,
    driverName: d.driverName,
    arrivedAt: d.arrivedAt?.toISOString() ?? null,
    inspectorId: d.inspectorId,
    comment: d.comment,
    confirmedByMolUserId: d.confirmedByMolUserId,
    confirmedByMolUserEmail: r.molEmail,
    confirmedByMolAt: d.confirmedByMolAt?.toISOString() ?? null,
    pendingDeletionAt: d.pendingDeletionAt?.toISOString() ?? null,
    pendingDeletionByUserId: d.pendingDeletionByUserId,
    pendingDeletionByUserEmail: r.pendingEmail,
    pendingDeletionReason: d.pendingDeletionReason,
    version: d.version,
    sourceDocumentIds: sources.map((x) => x.sourceDocumentId),
    sourceShipmentId: d.sourceShipmentId,
    sourceShipmentShippedAt: r.srcShippedAt?.toISOString() ?? null,
    sourceShipmentSiteId: r.srcSiteId,
    sourceShipmentSiteCode: r.srcSiteCode,
    items: items.map((i) => ({
      id: i.id,
      itemKind: i.itemKind,
      materialId: i.materialId,
      assetId: i.assetId,
      inventoryNumber: i.inventoryNumber,
      serialNumber: i.serialNumber,
      nameRaw: i.nameRaw,
      qtyPlanned: i.qtyPlanned,
      qtyActual: i.qtyActual,
      unit: i.unit,
      comment: i.comment,
      lineNo: i.lineNo,
      volumeM3: i.volumeM3,
      massKg: i.massKg,
      price: i.price,
      vatRate: i.vatRate,
      vatSum: i.vatSum,
      volumeConfidence: i.volumeConfidence as 'low' | 'medium' | 'high' | null,
      groupName: i.groupName,
    })),
    photos: photos.map((p) => ({
      id: p.id,
      kind: p.kind,
      stage: p.stage,
      s3Key: p.s3Key,
      thumbS3Key: p.thumbS3Key,
      contentHash: p.contentHash,
      takenAt: p.takenAt.toISOString(),
      uploadedAt: p.uploadedAt?.toISOString() ?? null,
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
      const { status, inspectorId, changedSince, trash, noDocument, limit, offset } = req.query;
      const filters = [];
      // По умолчанию показываем только активные документы; trash=true даёт корзину.
      filters.push(
        trash ? isNotNull(deliveries.pendingDeletionAt) : isNull(deliveries.pendingDeletionAt),
      );
      if (status) {
        const statusId = await resolveStatusId(app, status);
        filters.push(eq(deliveries.statusId, statusId));
      }
      if (noDocument !== undefined) {
        filters.push(
          noDocument
            ? drSql`not exists (select 1 from delivery_sources ds where ds.delivery_id = ${deliveries.id})`
            : drSql`exists (select 1 from delivery_sources ds where ds.delivery_id = ${deliveries.id})`,
        );
      }
      // inspector_kpp видит приёмки своего объекта (включая созданные другими).
      // Без назначенного объекта — пустой результат.
      if (req.user?.role === 'inspector_kpp') {
        if (!req.user.siteId) {
          filters.push(drSql`false`);
        } else {
          filters.push(eq(deliveries.siteId, req.user.siteId));
        }
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
      // inspector_kpp видит только приёмки своего объекта.
      if (
        req.user?.role === 'inspector_kpp' &&
        (!req.user.siteId || dto.siteId !== req.user.siteId)
      ) {
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
          // 409 — либо OCC-конфликт (Conflict), либо pending_deletion (Error).
          409: z.union([ConflictResponseSchema, ErrorResponseSchema]),
          400: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const input = req.body;
      const inspectorId = req.user?.role === 'inspector_kpp' ? req.user.id : (req.user?.id ?? null);

      // inspector_kpp всегда создаёт/редактирует приёмки своего объекта,
      // независимо от того, что прислал клиент.
      if (req.user?.role === 'inspector_kpp') {
        if (!req.user.siteId) {
          return reply.code(400).send({
            error: 'no_site_assigned',
            message: 'Объект не назначен — обратитесь к администратору',
          });
        }
        input.siteId = req.user.siteId;
      }

      // Статус процесса и наличие УПД — независимые измерения: инспектор
      // может оформить приёмку (filled) и без оригинала (например, мобилка
      // «Завершить 1 этап» по фото и госномеру, документ подгрузят позже).
      // Признак «нет документа» отображается отдельным тегом на основании
      // sourceDocumentIds и не занимает слот статуса.
      const statusId = await resolveStatusId(app, input.statusCode);

      try {
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
            // Помеченные документы — read-only до восстановления или окончательного удаления.
            if (existing.pendingDeletionAt !== null) {
              return reply.code(409).send({
                error: 'pending_deletion',
                message: 'Документ помечен на удаление — сначала снимите пометку',
              });
            }
            if (input.baseVersion !== undefined && input.baseVersion !== existing.version) {
              const server = await buildDeliveryDto(app, existing.id);
              return reply.code(409).send({
                error: 'conflict' as const,
                serverVersion: existing.version,
                server: server!,
              });
            }
            await updateDelivery(app, existing, input, statusId, req.user?.id ?? null);
          }
          const dto = await buildDeliveryDto(app, input.id);
          if (!dto) return reply.code(404).send({ error: 'not_found' });
          publishEvent(app, { type: 'delivery_updated', entityId: dto.id, ts: new Date().toISOString() });
          return dto;
        }

        const created = await createDelivery(app, input, statusId, inspectorId);
        const dto = await buildDeliveryDto(app, created.id);
        if (!dto) throw new Error('Delivery missing after create');
        publishEvent(app, { type: 'delivery_updated', entityId: dto.id, ts: new Date().toISOString() });
        return dto;
      } catch (err) {
        if (err instanceof SourceAlreadyLinkedError) {
          return reply.code(400).send({
            error: 'source_document_already_linked',
            message: 'УПД уже привязана к другой приёмке',
            details: { sourceDocumentIds: err.sourceDocumentIds },
          });
        }
        throw err;
      }
    },
  );

  app.delete(
    '/api/v1/deliveries/:id',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: z.object({ ok: z.literal(true) }),
          404: ErrorResponseSchema,
          403: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [existing] = await app.db
        .select()
        .from(deliveries)
        .where(eq(deliveries.id, req.params.id))
        .limit(1);
      if (!existing) return reply.code(404).send({ error: 'not_found' });

      const role = req.user?.role;
      const isPending = existing.pendingDeletionAt !== null;

      if (isPending) {
        // Окончательное удаление помеченного документа — только админ.
        if (role !== 'admin') {
          return reply.code(403).send({ error: 'forbidden' });
        }
      } else {
        // Hard-delete без пометки разрешён только для draft/not_filled
        // (черновики и не оформленные приёмки удаляются как раньше).
        const code = (await getStatusCodeById(app, existing.statusId)) ?? '';
        if (!HARD_DELETE_STATUSES.has(code)) {
          return reply.code(409).send({
            error: 'must_mark_first',
            message: 'Сначала пометьте документ на удаление',
          });
        }
        // Для draft/not_filled — прежняя ролевая модель.
        if (role === 'inspector_kpp') {
          if (!req.user?.siteId || existing.siteId !== req.user.siteId) {
            return reply.code(403).send({ error: 'forbidden' });
          }
        } else if (role !== 'admin' && role !== 'manager') {
          return reply.code(403).send({ error: 'forbidden' });
        }
      }

      // Аудит для трассировки: pending_deletion_* теряются вместе с записью.
      if (isPending) {
        req.log.info(
          {
            event: 'delivery_hard_deleted',
            deliveryId: existing.id,
            deletedByUserId: req.user?.id ?? null,
            originallyMarkedBy: existing.pendingDeletionByUserId,
            markedAt: existing.pendingDeletionAt?.toISOString() ?? null,
          },
          'delivery hard delete after soft-delete mark',
        );
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

      // Журнал hard-delete + физическое удаление одной транзакцией:
      // офлайн-клиент узнаёт об удалении через /sync.deletedIds.
      await app.db.transaction(async (tx) => {
        await tx.insert(entityDeletions).values({
          entityType: 'delivery',
          entityId: existing.id,
          siteId: existing.siteId,
          deletedByUserId: req.user?.id ?? null,
        });
        await tx.delete(deliveries).where(eq(deliveries.id, req.params.id));
      });
      publishEvent(app, {
        type: 'delivery_deleted',
        entityId: req.params.id,
        ts: new Date().toISOString(),
      });
      return { ok: true as const };
    },
  );

  // Soft-delete: пометить документ на удаление.
  app.post(
    '/api/v1/deliveries/:id/mark-deletion',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: DeliveryMarkDeletionSchema,
        response: {
          200: DeliverySchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [existing] = await app.db
        .select()
        .from(deliveries)
        .where(eq(deliveries.id, req.params.id))
        .limit(1);
      if (!existing) return reply.code(404).send({ error: 'not_found' });

      const role = req.user?.role;
      // Видимость как при обычном чтении: inspector_kpp — только свой site.
      if (role === 'inspector_kpp') {
        if (!req.user?.siteId || existing.siteId !== req.user.siteId) {
          return reply.code(404).send({ error: 'not_found' });
        }
      } else if (role !== 'admin' && role !== 'manager') {
        return reply.code(403).send({ error: 'forbidden' });
      }

      if (existing.pendingDeletionAt !== null) {
        return reply.code(409).send({
          error: 'already_pending',
          message: 'Документ уже помечен на удаление',
        });
      }

      const code = (await getStatusCodeById(app, existing.statusId)) ?? '';
      if (!SOFT_DELETE_STATUSES.has(code)) {
        return reply.code(400).send({
          error: 'cannot_mark_status',
          message: 'Пометка на удаление возможна только для статусов «Оформлена» и «Подтверждено МОЛ»',
        });
      }

      await app.db
        .update(deliveries)
        .set({
          pendingDeletionAt: new Date(),
          pendingDeletionByUserId: req.user?.id ?? null,
          pendingDeletionReason: req.body.reason ?? null,
          version: drSql`${deliveries.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(deliveries.id, existing.id));
      const dto = await buildDeliveryDto(app, existing.id);
      if (!dto) return reply.code(404).send({ error: 'not_found' });
      publishEvent(app, { type: 'delivery_updated', entityId: dto.id, ts: new Date().toISOString() });
      return dto;
    },
  );

  // Soft-delete: снять пометку об удалении (восстановить).
  app.post(
    '/api/v1/deliveries/:id/unmark-deletion',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: DeliverySchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [existing] = await app.db
        .select()
        .from(deliveries)
        .where(eq(deliveries.id, req.params.id))
        .limit(1);
      if (!existing) return reply.code(404).send({ error: 'not_found' });

      const role = req.user?.role;
      // Восстановить может админ или тот, кто пометил (с учётом видимости для inspector_kpp).
      const isAuthor =
        existing.pendingDeletionByUserId !== null &&
        existing.pendingDeletionByUserId === req.user?.id;
      if (!isAuthor && role !== 'admin') {
        return reply.code(403).send({ error: 'forbidden' });
      }
      if (role === 'inspector_kpp') {
        if (!req.user?.siteId || existing.siteId !== req.user.siteId) {
          return reply.code(404).send({ error: 'not_found' });
        }
      }

      if (existing.pendingDeletionAt === null) {
        return reply.code(409).send({
          error: 'not_pending',
          message: 'Документ не помечен на удаление',
        });
      }

      await app.db
        .update(deliveries)
        .set({
          pendingDeletionAt: null,
          pendingDeletionByUserId: null,
          pendingDeletionReason: null,
          version: drSql`${deliveries.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(deliveries.id, existing.id));
      const dto = await buildDeliveryDto(app, existing.id);
      if (!dto) return reply.code(404).send({ error: 'not_found' });
      publishEvent(app, { type: 'delivery_updated', entityId: dto.id, ts: new Date().toISOString() });
      return dto;
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
      siteId: input.siteId,
      supplierId: input.supplierId ?? null,
      contractorId: input.contractorId ?? null,
      recipientMolId: input.recipientMolId ?? null,
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
        itemKind: i.itemKind,
        materialId: i.itemKind === 'asset' ? null : (i.materialId ?? null),
        assetId: i.itemKind === 'asset' ? (i.assetId ?? null) : null,
        inventoryNumber: i.inventoryNumber ?? null,
        serialNumber: i.serialNumber ?? null,
        nameRaw: i.nameRaw,
        qtyPlanned: i.qtyPlanned ?? null,
        qtyActual: i.qtyActual ?? null,
        unit: i.unit,
        comment: i.comment ?? null,
        lineNo: i.lineNo,
        volumeM3: i.volumeM3 ?? null,
        massKg: i.massKg ?? null,
        price: i.price ?? null,
        vatRate: i.vatRate ?? null,
        vatSum: i.vatSum ?? null,
        volumeConfidence: i.volumeConfidence ?? null,
        groupName: i.groupName ?? null,
      })),
    );
  }
  if (input.sourceDocumentIds.length) {
    await assertSourcesAvailableForDelivery(app, input.sourceDocumentIds, created.id);
    try {
      await app.db
        .insert(deliverySources)
        .values(
          input.sourceDocumentIds.map((sid) => ({ deliveryId: created.id, sourceDocumentId: sid })),
        );
    } catch (err) {
      if (isSourceDocumentUniqueViolation(err)) {
        throw new SourceAlreadyLinkedError(input.sourceDocumentIds);
      }
      throw err;
    }
  }
  return created;
}

async function updateDelivery(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  existing: typeof deliveries.$inferSelect,
  input: z.infer<typeof DeliveryUpsertSchema>,
  statusId: string,
  userId: string | null,
) {
  const id = existing.id;
  // Защита от отката: если документ уже подтверждён МОЛ, обычное «Сохранить»
  // не должно понижать статус обратно до filled/draft.
  const existingCode = await getStatusCodeById(app, existing.statusId);
  const effectiveStatusId =
    existingCode === 'confirmed_mol' && input.statusCode !== 'confirmed_mol'
      ? existing.statusId
      : statusId;
  // Первичная фиксация аудита подтверждения (идемпотентно: повторное
  // подтверждение не перезаписывает кто/когда).
  const isFirstConfirm =
    input.statusCode === 'confirmed_mol' && existing.confirmedByMolUserId === null;

  // Ручная привязка УПД к приёмке без документа на портале: клиент шлёт
  // непустой sourceDocumentIds и пустой items — сервер подтягивает позиции
  // из УПД (qtyPlanned из qty, qtyActual=null). Дальше оператор/инспектор
  // доводит приёмку до filled штатным путём.
  const [existingSourcesCount] = await app.db
    .select({ c: drSql<number>`count(*)::int` })
    .from(deliverySources)
    .where(eq(deliverySources.deliveryId, id));
  const existingHadNoDocs = (existingSourcesCount?.c ?? 0) === 0;
  const itemsForInsert =
    existingHadNoDocs &&
    input.sourceDocumentIds.length > 0 &&
    input.items.length === 0
      ? await buildDeliveryItemsFromSources(app, input.sourceDocumentIds)
      : input.items.map((i) => ({
          itemKind: i.itemKind,
          materialId: i.itemKind === 'asset' ? null : (i.materialId ?? null),
          assetId: i.itemKind === 'asset' ? (i.assetId ?? null) : null,
          inventoryNumber: i.inventoryNumber ?? null,
          serialNumber: i.serialNumber ?? null,
          nameRaw: i.nameRaw,
          qtyPlanned: i.qtyPlanned ?? null,
          qtyActual: i.qtyActual ?? null,
          unit: i.unit,
          comment: i.comment ?? null,
          lineNo: i.lineNo,
          volumeM3: i.volumeM3 ?? null,
          massKg: i.massKg ?? null,
          price: i.price ?? null,
          vatRate: i.vatRate ?? null,
          vatSum: i.vatSum ?? null,
          volumeConfidence: i.volumeConfidence ?? null,
          groupName: i.groupName ?? null,
        }));

  await app.db
    .update(deliveries)
    .set({
      statusId: effectiveStatusId,
      siteId: input.siteId,
      supplierId: input.supplierId ?? null,
      contractorId: input.contractorId ?? null,
      recipientMolId: input.recipientMolId ?? null,
      vehiclePlate: input.vehiclePlate ?? null,
      driverName: input.driverName ?? null,
      arrivedAt: input.arrivedAt ? new Date(input.arrivedAt) : null,
      comment: input.comment ?? null,
      ...(isFirstConfirm && {
        confirmedByMolUserId: userId,
        confirmedByMolAt: new Date(),
      }),
      version: drSql`${deliveries.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(deliveries.id, id));
  await app.db.delete(deliveryItems).where(eq(deliveryItems.deliveryId, id));
  if (itemsForInsert.length) {
    await app.db.insert(deliveryItems).values(
      itemsForInsert.map((i) => ({ ...i, deliveryId: id })),
    );
  }
  if (input.sourceDocumentIds.length) {
    await assertSourcesAvailableForDelivery(app, input.sourceDocumentIds, id);
  }
  await app.db.delete(deliverySources).where(eq(deliverySources.deliveryId, id));
  if (input.sourceDocumentIds.length) {
    try {
      await app.db
        .insert(deliverySources)
        .values(input.sourceDocumentIds.map((sid) => ({ deliveryId: id, sourceDocumentId: sid })));
    } catch (err) {
      if (isSourceDocumentUniqueViolation(err)) {
        throw new SourceAlreadyLinkedError(input.sourceDocumentIds);
      }
      throw err;
    }
  }
}

function isSourceDocumentUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; constraint?: string; constraint_name?: string };
  if (e.code !== '23505') return false;
  const name = e.constraint ?? e.constraint_name ?? '';
  return name.endsWith('_source_document_id_unique');
}

// Подтягивает позиции из привязываемых УПД в формате delivery_items.
// Используется при ручной привязке УПД к приёмке «Без документа» на портале:
// диспетчер указывает только sourceDocumentId, а сервер копирует позиции
// (qtyPlanned из source_document_items.qty, qtyActual=null). lineNo пересчитываем
// сквозным образом, чтобы при нескольких УПД получился непрерывный список.
async function buildDeliveryItemsFromSources(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  sourceDocumentIds: string[],
): Promise<
  Array<{
    itemKind: 'material';
    materialId: string | null;
    assetId: null;
    inventoryNumber: null;
    serialNumber: null;
    nameRaw: string;
    qtyPlanned: string | null;
    qtyActual: null;
    unit: string;
    comment: null;
    lineNo: number;
    volumeM3: string | null;
    massKg: string | null;
    price: string | null;
    vatRate: string | null;
    vatSum: string | null;
    volumeConfidence: 'low' | 'medium' | 'high' | null;
    groupName: string | null;
  }>
> {
  if (!sourceDocumentIds.length) return [];
  const rows: (typeof sourceDocumentItems.$inferSelect)[] = await app.db
    .select()
    .from(sourceDocumentItems)
    .where(inArray(sourceDocumentItems.sourceDocumentId, sourceDocumentIds))
    .orderBy(sourceDocumentItems.lineNo);
  return rows.map((r, idx) => ({
    itemKind: 'material' as const,
    materialId: r.materialId,
    assetId: null,
    inventoryNumber: null,
    serialNumber: null,
    nameRaw: r.nameRaw,
    qtyPlanned: r.qty,
    qtyActual: null,
    unit: r.unit,
    comment: null,
    lineNo: idx + 1,
    volumeM3: r.volumeM3,
    massKg: r.massKg,
    price: r.price,
    vatRate: r.vatRate,
    vatSum: r.vatSum,
    volumeConfidence: r.volumeConfidence as 'low' | 'medium' | 'high' | null,
    groupName: r.groupName,
  }));
}
