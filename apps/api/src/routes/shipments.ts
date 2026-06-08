import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, inArray, isNotNull, isNull, ne, or, sql as drSql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import {
  BulkDeleteRequestSchema,
  BulkDeleteResponseSchema,
  ErrorResponseSchema,
  ShipmentConflictResponseSchema,
  ShipmentKindSchema,
  ShipmentListResponseSchema,
  ShipmentMarkDeletionSchema,
  ShipmentSchema,
  ShipmentStatusCodeSchema,
  ShipmentUpsertSchema,
} from '@matcheck/contracts';
import {
  entityDeletions,
  shipments,
  shipmentItems,
  shipmentPhotos,
  shipmentSources,
  sourceDocumentItems,
  statuses,
  users,
} from '../db/schema.js';
import { deleteObject } from '../domain/storage/s3.signer.js';
import {
  getStatusCodeById,
  resolveStatusId as resolveStatusIdShared,
} from '../domain/statuses/lookup.js';
import { syncPairedTransferDelivery } from '../domain/transfers/pair.js';
import { publishEvent } from './events.js';

const ListQuerySchema = z.object({
  status: ShipmentStatusCodeSchema.optional(),
  kind: ShipmentKindSchema.optional(),
  siteId: z.string().uuid().optional(),
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

// УПД должна быть привязана не более чем к одной отгрузке. Проверяем, что
// заявленные source_document_id не заняты другой отгрузкой. excludeShipmentId
// нужен для обновления: те же УПД могут уже быть привязаны к текущей отгрузке.
async function assertSourcesAvailableForShipment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  sourceDocumentIds: string[],
  excludeShipmentId: string | null,
) {
  if (!sourceDocumentIds.length) return;
  const conds = [inArray(shipmentSources.sourceDocumentId, sourceDocumentIds)];
  if (excludeShipmentId) conds.push(ne(shipmentSources.shipmentId, excludeShipmentId));
  const taken = await app.db
    .select({ sourceDocumentId: shipmentSources.sourceDocumentId })
    .from(shipmentSources)
    .where(and(...conds));
  if (taken.length) {
    throw new SourceAlreadyLinkedError(taken.map((r: { sourceDocumentId: string }) => r.sourceDocumentId));
  }
}

function isSourceDocumentUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; constraint?: string; constraint_name?: string };
  if (e.code !== '23505') return false;
  const name = e.constraint ?? e.constraint_name ?? '';
  return name.endsWith('_source_document_id_unique');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolveStatusId = (app: any, code: string) =>
  resolveStatusIdShared(app, 'shipment', code);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildShipmentDto(app: any, id: string) {
  // Два независимых join на users: один на МОЛ, другой на автора soft-delete пометки.
  const pendingUser = alias(users, 'pending_user');
  const rows = await app.db
    .select({
      s: shipments,
      st: statuses,
      molEmail: users.email,
      pendingEmail: pendingUser.email,
    })
    .from(shipments)
    .innerJoin(statuses, eq(shipments.statusId, statuses.id))
    .leftJoin(users, eq(shipments.confirmedByMolUserId, users.id))
    .leftJoin(pendingUser, eq(shipments.pendingDeletionByUserId, pendingUser.id))
    .where(eq(shipments.id, id))
    .limit(1);
  const r = rows[0] as
    | {
        s: typeof shipments.$inferSelect;
        st: StatusRow;
        molEmail: string | null;
        pendingEmail: string | null;
      }
    | undefined;
  if (!r) return null;
  const s = r.s;
  const st = r.st;
  const items: (typeof shipmentItems.$inferSelect)[] = await app.db
    .select()
    .from(shipmentItems)
    .where(eq(shipmentItems.shipmentId, id))
    .orderBy(shipmentItems.lineNo);
  const photos: (typeof shipmentPhotos.$inferSelect)[] = await app.db
    .select()
    .from(shipmentPhotos)
    .where(eq(shipmentPhotos.shipmentId, id));
  const sources: { sourceDocumentId: string }[] = await app.db
    .select({ sourceDocumentId: shipmentSources.sourceDocumentId })
    .from(shipmentSources)
    .where(eq(shipmentSources.shipmentId, id));
  return {
    id: s.id,
    status: {
      id: st.id,
      entityType: st.entityType,
      code: st.code,
      label: st.label,
      color: st.color,
      sortOrder: st.sortOrder,
    },
    kind: s.kind,
    purpose: s.purpose,
    inTransit: s.inTransit,
    siteId: s.siteId,
    receiverCounterpartyId: s.receiverCounterpartyId,
    receiverMolId: s.receiverMolId,
    destSiteId: s.destSiteId,
    vehiclePlate: s.vehiclePlate,
    driverName: s.driverName,
    shippedAt: s.shippedAt?.toISOString() ?? null,
    inspectorId: s.inspectorId,
    comment: s.comment,
    confirmedByMolUserId: s.confirmedByMolUserId,
    confirmedByMolUserEmail: r.molEmail,
    confirmedByMolAt: s.confirmedByMolAt?.toISOString() ?? null,
    pendingDeletionAt: s.pendingDeletionAt?.toISOString() ?? null,
    pendingDeletionByUserId: s.pendingDeletionByUserId,
    pendingDeletionByUserEmail: r.pendingEmail,
    pendingDeletionReason: s.pendingDeletionReason,
    version: s.version,
    sourceDocumentIds: sources.map((x) => x.sourceDocumentId),
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
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

export async function shipmentRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);

  app.get(
    '/api/v1/shipments',
    {
      preHandler: [app.authenticate],
      schema: { querystring: ListQuerySchema, response: { 200: ShipmentListResponseSchema } },
    },
    async (req) => {
      const { status, kind, siteId, inspectorId, changedSince, trash, noDocument, limit, offset } = req.query;
      const filters = [];
      filters.push(
        trash ? isNotNull(shipments.pendingDeletionAt) : isNull(shipments.pendingDeletionAt),
      );
      if (status) {
        const statusId = await resolveStatusId(app, status);
        filters.push(eq(shipments.statusId, statusId));
      }
      if (noDocument !== undefined) {
        filters.push(
          noDocument
            ? drSql`not exists (select 1 from shipment_sources ss where ss.shipment_id = ${shipments.id})`
            : drSql`exists (select 1 from shipment_sources ss where ss.shipment_id = ${shipments.id})`,
        );
      }
      if (kind) filters.push(eq(shipments.kind, kind));
      // inspector_kpp видит отгрузки своего объекта-источника (включая чужие).
      // Без назначенного объекта — пустой результат. Для admin/manager
      // siteId из query — обычный опциональный фильтр.
      if (req.user?.role === 'inspector_kpp') {
        if (!req.user.siteId) {
          filters.push(drSql`false`);
        } else {
          filters.push(eq(shipments.siteId, req.user.siteId));
        }
      } else {
        if (siteId) filters.push(eq(shipments.siteId, siteId));
        if (inspectorId) filters.push(eq(shipments.inspectorId, inspectorId));
      }
      if (!status && req.user?.role !== 'inspector_kpp' && req.user) {
        const draftId = await resolveStatusId(app, 'draft');
        filters.push(
          or(ne(shipments.statusId, draftId), eq(shipments.inspectorId, req.user.id))!,
        );
      }
      if (changedSince) filters.push(gte(shipments.updatedAt, new Date(changedSince)));
      const where = filters.length ? and(...filters) : undefined;

      const rows = await app.db
        .select({ id: shipments.id })
        .from(shipments)
        .where(where)
        .orderBy(desc(shipments.updatedAt))
        .limit(limit)
        .offset(offset);
      const [{ count } = { count: 0 }] = await app.db
        .select({ count: drSql<number>`count(*)::int` })
        .from(shipments)
        .where(where);

      const items = (await Promise.all(rows.map((r) => buildShipmentDto(app, r.id)))).filter(
        (x): x is NonNullable<typeof x> => x !== null,
      );
      return { items, total: count };
    },
  );

  app.get(
    '/api/v1/shipments/:id',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: ShipmentSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const dto = await buildShipmentDto(app, req.params.id);
      if (!dto) return reply.code(404).send({ error: 'not_found' });
      // inspector_kpp видит только отгрузки своего объекта-источника.
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
    '/api/v1/shipments',
    {
      preHandler: [app.authenticate],
      schema: {
        body: ShipmentUpsertSchema,
        response: {
          200: ShipmentSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          // 409 — либо OCC-конфликт (Conflict), либо pending_deletion (Error).
          409: z.union([ShipmentConflictResponseSchema, ErrorResponseSchema]),
          // 422 — receiver_required (документ не дозаполнен), отдельно от
          // 400, чтобы mobile-MutationProcessor мог различать «дозаполните
          // данные» от «клиент послал мусор» (без ретраев).
          422: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const input = req.body;
      const inspectorId = req.user?.role === 'inspector_kpp' ? req.user.id : (req.user?.id ?? null);

      // inspector_kpp всегда работает в рамках своего объекта-источника;
      // вход из body игнорируется и заменяется значением из БД.
      if (req.user?.role === 'inspector_kpp') {
        if (!req.user.siteId) {
          return reply.code(400).send({
            error: 'no_site_assigned',
            message: 'Объект не назначен — обратитесь к администратору',
          });
        }
        input.siteId = req.user.siteId;
      }

      // Статус процесса и наличие УПД — независимые измерения.
      // См. комментарий в /api/v1/deliveries.
      const statusId = await resolveStatusId(app, input.statusCode);

      // Дополнительная валидация согласованности kind ↔ receiver/destSite,
      // BD-CHECK даст более грубое сообщение — отдадим клиенту что-то понятное.
      // receiver_required → 422 (документ не дозаполнен, mobile показывает
      // понятный текст и НЕ ретраит). invalid_kind_links → 400 (клиент послал
      // несовместимые поля). Разделение нужно mobile-MutationProcessor'у.
      const linksError = validateKindLinks(input);
      if (linksError) {
        const statusCode = linksError.code === 'receiver_required' ? 422 : 400;
        return reply
          .code(statusCode)
          .send({ error: linksError.code, message: linksError.message });
      }

      try {
        if (input.id) {
          const [existing] = await app.db
            .select()
            .from(shipments)
            .where(eq(shipments.id, input.id))
            .limit(1);
          if (!existing) {
            await createShipment(app, input, statusId, inspectorId);
          } else {
            // Помеченные документы — read-only до восстановления или окончательного удаления.
            if (existing.pendingDeletionAt !== null) {
              return reply.code(409).send({
                error: 'pending_deletion',
                message: 'Документ помечен на удаление — сначала снимите пометку',
              });
            }
            if (input.baseVersion !== undefined && input.baseVersion !== existing.version) {
              const server = await buildShipmentDto(app, existing.id);
              return reply.code(409).send({
                error: 'conflict' as const,
                serverVersion: existing.version,
                server: server!,
              });
            }
            await updateShipment(app, existing, input, statusId, req.user?.id ?? null);
          }
          if (input.kind === 'transfer') {
            await syncPairedTransferDelivery(app, input.id);
          }
          const dto = await buildShipmentDto(app, input.id);
          if (!dto) return reply.code(404).send({ error: 'not_found' });
          publishEvent(app, { type: 'shipment_updated', entityId: dto.id, ts: new Date().toISOString() });
          return dto;
        }

        const created = await createShipment(app, input, statusId, inspectorId);
        if (input.kind === 'transfer') {
          await syncPairedTransferDelivery(app, created.id);
        }
        const dto = await buildShipmentDto(app, created.id);
        if (!dto) throw new Error('Shipment missing after create');
        publishEvent(app, { type: 'shipment_updated', entityId: dto.id, ts: new Date().toISOString() });
        return dto;
      } catch (err) {
        if (err instanceof SourceAlreadyLinkedError) {
          return reply.code(400).send({
            error: 'source_document_already_linked',
            message: 'УПД уже привязана к другой отгрузке',
            details: { sourceDocumentIds: err.sourceDocumentIds },
          });
        }
        throw err;
      }
    },
  );

  app.delete(
    '/api/v1/shipments/:id',
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
        .from(shipments)
        .where(eq(shipments.id, req.params.id))
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
        const code = (await getStatusCodeById(app, existing.statusId)) ?? '';
        if (!HARD_DELETE_STATUSES.has(code)) {
          return reply.code(409).send({
            error: 'must_mark_first',
            message: 'Сначала пометьте документ на удаление',
          });
        }
        if (role === 'inspector_kpp') {
          if (!req.user?.siteId || existing.siteId !== req.user.siteId) {
            return reply.code(403).send({ error: 'forbidden' });
          }
        } else if (role !== 'admin' && role !== 'manager') {
          return reply.code(403).send({ error: 'forbidden' });
        }
      }

      if (isPending) {
        req.log.info(
          {
            event: 'shipment_hard_deleted',
            shipmentId: existing.id,
            deletedByUserId: req.user?.id ?? null,
            originallyMarkedBy: existing.pendingDeletionByUserId,
            markedAt: existing.pendingDeletionAt?.toISOString() ?? null,
          },
          'shipment hard delete after soft-delete mark',
        );
      }

      const photos = await app.db
        .select({ s3Key: shipmentPhotos.s3Key, thumbS3Key: shipmentPhotos.thumbS3Key })
        .from(shipmentPhotos)
        .where(eq(shipmentPhotos.shipmentId, req.params.id));
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
          entityType: 'shipment',
          entityId: existing.id,
          siteId: existing.siteId,
          deletedByUserId: req.user?.id ?? null,
        });
        await tx.delete(shipments).where(eq(shipments.id, req.params.id));
      });
      publishEvent(app, {
        type: 'shipment_deleted',
        entityId: req.params.id,
        ts: new Date().toISOString(),
      });
      return { ok: true as const };
    },
  );

  // Soft-delete: пометить отгрузку на удаление.
  app.post(
    '/api/v1/shipments/:id/mark-deletion',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: ShipmentMarkDeletionSchema,
        response: {
          200: ShipmentSchema,
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
        .from(shipments)
        .where(eq(shipments.id, req.params.id))
        .limit(1);
      if (!existing) return reply.code(404).send({ error: 'not_found' });

      const role = req.user?.role;
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
        .update(shipments)
        .set({
          pendingDeletionAt: new Date(),
          pendingDeletionByUserId: req.user?.id ?? null,
          pendingDeletionReason: req.body.reason ?? null,
          version: drSql`${shipments.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(shipments.id, existing.id));
      const dto = await buildShipmentDto(app, existing.id);
      if (!dto) return reply.code(404).send({ error: 'not_found' });
      publishEvent(app, { type: 'shipment_updated', entityId: dto.id, ts: new Date().toISOString() });
      return dto;
    },
  );

  // Soft-delete: снять пометку об удалении (восстановить).
  app.post(
    '/api/v1/shipments/:id/unmark-deletion',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: ShipmentSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [existing] = await app.db
        .select()
        .from(shipments)
        .where(eq(shipments.id, req.params.id))
        .limit(1);
      if (!existing) return reply.code(404).send({ error: 'not_found' });

      const role = req.user?.role;
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
        .update(shipments)
        .set({
          pendingDeletionAt: null,
          pendingDeletionByUserId: null,
          pendingDeletionReason: null,
          version: drSql`${shipments.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(shipments.id, existing.id));
      const dto = await buildShipmentDto(app, existing.id);
      if (!dto) return reply.code(404).send({ error: 'not_found' });
      publishEvent(app, { type: 'shipment_updated', entityId: dto.id, ts: new Date().toISOString() });
      return dto;
    },
  );

  // ──────────── Bulk: пометить N отгрузок на удаление ────────────
  // Симметрично deliveries.bulk-mark-deletion: те же правила (видимость
  // inspector_kpp, проверка статуса, already_pending), best-effort.
  app.post(
    '/api/v1/shipments/bulk-mark-deletion',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        body: BulkDeleteRequestSchema,
        response: { 200: BulkDeleteResponseSchema },
      },
    },
    async (req) => {
      const ids = req.body.ids;
      const deleted: string[] = [];
      const skipped: Array<{
        id: string;
        reason:
          | 'not_found'
          | 'already_pending'
          | 'wrong_status'
          | 'forbidden'
          | 'internal_error';
      }> = [];

      for (const id of ids) {
        try {
          const [existing] = await app.db
            .select()
            .from(shipments)
            .where(eq(shipments.id, id))
            .limit(1);
          if (!existing) {
            skipped.push({ id, reason: 'not_found' });
            continue;
          }
          if (req.user?.role === 'inspector_kpp') {
            if (!req.user.siteId || existing.siteId !== req.user.siteId) {
              skipped.push({ id, reason: 'not_found' });
              continue;
            }
          }
          if (existing.pendingDeletionAt !== null) {
            skipped.push({ id, reason: 'already_pending' });
            continue;
          }
          const code = (await getStatusCodeById(app, existing.statusId)) ?? '';
          if (!SOFT_DELETE_STATUSES.has(code)) {
            skipped.push({ id, reason: 'wrong_status' });
            continue;
          }
          await app.db
            .update(shipments)
            .set({
              pendingDeletionAt: new Date(),
              pendingDeletionByUserId: req.user?.id ?? null,
              pendingDeletionReason: null,
              version: drSql`${shipments.version} + 1`,
              updatedAt: new Date(),
            })
            .where(eq(shipments.id, id));
          publishEvent(app, {
            type: 'shipment_updated',
            entityId: id,
            ts: new Date().toISOString(),
          });
          deleted.push(id);
        } catch (err) {
          req.log.error({ err, id }, 'bulk-mark-deletion: failed (shipment)');
          skipped.push({ id, reason: 'internal_error' });
        }
      }
      return { deleted, skipped };
    },
  );

  // ──────────── Bulk: восстановить N отгрузок ────────────
  app.post(
    '/api/v1/shipments/bulk-unmark-deletion',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        body: BulkDeleteRequestSchema,
        response: { 200: BulkDeleteResponseSchema },
      },
    },
    async (req) => {
      const ids = req.body.ids;
      const deleted: string[] = [];
      const skipped: Array<{
        id: string;
        reason: 'not_found' | 'not_pending' | 'forbidden' | 'internal_error';
      }> = [];

      for (const id of ids) {
        try {
          const [existing] = await app.db
            .select()
            .from(shipments)
            .where(eq(shipments.id, id))
            .limit(1);
          if (!existing) {
            skipped.push({ id, reason: 'not_found' });
            continue;
          }
          const isAuthor =
            existing.pendingDeletionByUserId !== null &&
            existing.pendingDeletionByUserId === req.user?.id;
          if (!isAuthor && req.user?.role !== 'admin') {
            skipped.push({ id, reason: 'forbidden' });
            continue;
          }
          if (req.user?.role === 'inspector_kpp') {
            if (!req.user.siteId || existing.siteId !== req.user.siteId) {
              skipped.push({ id, reason: 'not_found' });
              continue;
            }
          }
          if (existing.pendingDeletionAt === null) {
            skipped.push({ id, reason: 'not_pending' });
            continue;
          }
          await app.db
            .update(shipments)
            .set({
              pendingDeletionAt: null,
              pendingDeletionByUserId: null,
              pendingDeletionReason: null,
              version: drSql`${shipments.version} + 1`,
              updatedAt: new Date(),
            })
            .where(eq(shipments.id, id));
          publishEvent(app, {
            type: 'shipment_updated',
            entityId: id,
            ts: new Date().toISOString(),
          });
          deleted.push(id);
        } catch (err) {
          req.log.error({ err, id }, 'bulk-unmark-deletion: failed (shipment)');
          skipped.push({ id, reason: 'internal_error' });
        }
      }
      return { deleted, skipped };
    },
  );

  // ──────────── Bulk: удалить N отгрузок навсегда (admin) ────────────
  app.post(
    '/api/v1/shipments/bulk-hard-delete',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        body: BulkDeleteRequestSchema,
        response: { 200: BulkDeleteResponseSchema },
      },
    },
    async (req) => {
      const ids = req.body.ids;
      const deleted: string[] = [];
      const skipped: Array<{
        id: string;
        reason: 'not_found' | 'must_mark_first' | 'forbidden' | 'internal_error';
      }> = [];

      for (const id of ids) {
        try {
          const [existing] = await app.db
            .select()
            .from(shipments)
            .where(eq(shipments.id, id))
            .limit(1);
          if (!existing) {
            skipped.push({ id, reason: 'not_found' });
            continue;
          }
          const isPending = existing.pendingDeletionAt !== null;
          if (!isPending) {
            const code = (await getStatusCodeById(app, existing.statusId)) ?? '';
            if (!HARD_DELETE_STATUSES.has(code)) {
              skipped.push({ id, reason: 'must_mark_first' });
              continue;
            }
          }
          const photos = await app.db
            .select({
              s3Key: shipmentPhotos.s3Key,
              thumbS3Key: shipmentPhotos.thumbS3Key,
            })
            .from(shipmentPhotos)
            .where(eq(shipmentPhotos.shipmentId, id));
          for (const p of photos) {
            try {
              await deleteObject(p.s3Key);
              if (p.thumbS3Key) await deleteObject(p.thumbS3Key);
            } catch (s3Err) {
              req.log.warn({ err: s3Err, s3Key: p.s3Key }, 'bulk-hard-delete: s3 delete failed (shipment)');
            }
          }
          await app.db.transaction(async (tx) => {
            await tx.insert(entityDeletions).values({
              entityType: 'shipment',
              entityId: id,
              siteId: existing.siteId,
              deletedByUserId: req.user?.id ?? null,
            });
            await tx.delete(shipments).where(eq(shipments.id, id));
          });
          publishEvent(app, {
            type: 'shipment_deleted',
            entityId: id,
            ts: new Date().toISOString(),
          });
          deleted.push(id);
        } catch (err) {
          req.log.error({ err, id }, 'bulk-hard-delete: failed (shipment)');
          skipped.push({ id, reason: 'internal_error' });
        }
      }
      return { deleted, skipped };
    },
  );
}

/**
 * Результат проверки согласованности kind ↔ receiver/destSite.
 * `code='receiver_required'` нужен mobile, чтобы отличить «документ
 * не дозаполнен — попросить менеджера» от «клиент послал мусор».
 * Остальные ошибки — обычные `invalid_kind_links` (400).
 */
type KindLinksError = {
  code: 'receiver_required' | 'invalid_kind_links';
  message: string;
};
function validateKindLinks(input: z.infer<typeof ShipmentUpsertSchema>): KindLinksError | null {
  const { kind, receiverCounterpartyId, receiverMolId, destSiteId, siteId, sourceDocumentIds } = input;
  // Получатель указан XOR через counterparty или МОЛ (двух одновременно — нельзя).
  const hasContractorReceiver = Boolean(receiverCounterpartyId);
  const hasMolReceiver = Boolean(receiverMolId);
  const hasAnyReceiver = hasContractorReceiver || hasMolReceiver;
  const hasBothReceivers = hasContractorReceiver && hasMolReceiver;
  const bad = (message: string): KindLinksError => ({ code: 'invalid_kind_links', message });
  const noReceiver = (message: string): KindLinksError => ({
    code: 'receiver_required',
    message,
  });
  // Empty-draft = отгрузка без привязанной УПД (создана инспектором через
  // «Создать отгрузку» на мобиле). У таких отгрузок получатель может быть
  // не указан — менеджер дозaпoлнит на портале. Конфликт с DB-CHECK
  // shipments_kind_links_chk решается тем, что для contractor допускается
  // запись без receiver (CHECK не запрещает оба NULL).
  const isEmptyDraft = !sourceDocumentIds || sourceDocumentIds.length === 0;

  if (kind === 'contractor') {
    if (hasBothReceivers) return bad('Укажите получателя одним способом: подрядчик или МОЛ');
    if (!hasAnyReceiver && !isEmptyDraft) {
      return noReceiver('Для отгрузки нужен получатель (подрядчик или МОЛ)');
    }
    if (destSiteId) return bad('destSiteId допустим только для перемещения');
    return null;
  }
  if (kind === 'return') {
    if (hasMolReceiver) return bad('Возврат поставщику оформляется только на контрагента');
    if (!hasContractorReceiver) return noReceiver('Для возврата нужен получатель-поставщик');
    if (destSiteId) return bad('destSiteId допустим только для перемещения');
    return null;
  }
  if (kind === 'transfer') {
    if (!destSiteId) return bad('Для перемещения нужен объект-получатель');
    if (destSiteId === siteId) return bad('Объект-получатель не может совпадать с источником');
    if (hasBothReceivers) return bad('Укажите получателя одним способом: подрядчик или МОЛ');
    if (!hasAnyReceiver)
      return noReceiver('Для перемещения нужен получатель на новом объекте (подрядчик или МОЛ)');
    return null;
  }
  // writeoff
  if (hasAnyReceiver || destSiteId) return bad('Для списания получатель не указывается');
  return null;
}

async function createShipment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  input: z.infer<typeof ShipmentUpsertSchema>,
  statusId: string,
  inspectorId: string | null,
) {
  const [created] = await app.db
    .insert(shipments)
    .values({
      id: input.id,
      statusId,
      kind: input.kind,
      purpose: input.purpose ?? null,
      inTransit: input.inTransit ?? false,
      siteId: input.siteId,
      receiverCounterpartyId: input.receiverCounterpartyId ?? null,
      receiverMolId: input.receiverMolId ?? null,
      destSiteId: input.destSiteId ?? null,
      vehiclePlate: input.vehiclePlate ?? null,
      driverName: input.driverName ?? null,
      shippedAt: input.shippedAt ? new Date(input.shippedAt) : null,
      inspectorId,
      comment: input.comment ?? null,
      version: 1,
    })
    .returning();
  if (!created) throw new Error('Failed to insert shipment');
  if (input.items.length) {
    await app.db.insert(shipmentItems).values(
      input.items.map((i) => ({
        shipmentId: created.id,
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
    await assertSourcesAvailableForShipment(app, input.sourceDocumentIds, created.id);
    try {
      await app.db
        .insert(shipmentSources)
        .values(
          input.sourceDocumentIds.map((sid) => ({ shipmentId: created.id, sourceDocumentId: sid })),
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

async function updateShipment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  existing: typeof shipments.$inferSelect,
  input: z.infer<typeof ShipmentUpsertSchema>,
  statusId: string,
  userId: string | null,
) {
  const id = existing.id;
  const existingCode = await getStatusCodeById(app, existing.statusId);
  const effectiveStatusId =
    existingCode === 'confirmed_mol' && input.statusCode !== 'confirmed_mol'
      ? existing.statusId
      : statusId;
  const isFirstConfirm =
    input.statusCode === 'confirmed_mol' && existing.confirmedByMolUserId === null;

  // Ручная привязка УПД к отгрузке без документа на портале: клиент шлёт
  // непустой sourceDocumentIds и пустой items — сервер подтягивает позиции
  // из УПД. См. updateDelivery (симметрично).
  const [existingSourcesCount] = await app.db
    .select({ c: drSql<number>`count(*)::int` })
    .from(shipmentSources)
    .where(eq(shipmentSources.shipmentId, id));
  const existingHadNoDocs = (existingSourcesCount?.c ?? 0) === 0;
  const itemsForInsert =
    existingHadNoDocs &&
    input.sourceDocumentIds.length > 0 &&
    input.items.length === 0
      ? await buildShipmentItemsFromSources(app, input.sourceDocumentIds)
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
    .update(shipments)
    .set({
      statusId: effectiveStatusId,
      kind: input.kind,
      purpose: input.purpose ?? null,
      inTransit: input.inTransit ?? false,
      siteId: input.siteId,
      receiverCounterpartyId: input.receiverCounterpartyId ?? null,
      receiverMolId: input.receiverMolId ?? null,
      destSiteId: input.destSiteId ?? null,
      vehiclePlate: input.vehiclePlate ?? null,
      driverName: input.driverName ?? null,
      shippedAt: input.shippedAt ? new Date(input.shippedAt) : null,
      comment: input.comment ?? null,
      ...(isFirstConfirm && {
        confirmedByMolUserId: userId,
        confirmedByMolAt: new Date(),
      }),
      version: drSql`${shipments.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(shipments.id, id));
  await app.db.delete(shipmentItems).where(eq(shipmentItems.shipmentId, id));
  if (itemsForInsert.length) {
    await app.db.insert(shipmentItems).values(
      itemsForInsert.map((i) => ({ ...i, shipmentId: id })),
    );
  }
  if (input.sourceDocumentIds.length) {
    await assertSourcesAvailableForShipment(app, input.sourceDocumentIds, id);
  }
  await app.db.delete(shipmentSources).where(eq(shipmentSources.shipmentId, id));
  if (input.sourceDocumentIds.length) {
    try {
      await app.db
        .insert(shipmentSources)
        .values(input.sourceDocumentIds.map((sid) => ({ shipmentId: id, sourceDocumentId: sid })));
    } catch (err) {
      if (isSourceDocumentUniqueViolation(err)) {
        throw new SourceAlreadyLinkedError(input.sourceDocumentIds);
      }
      throw err;
    }
  }
}

// Подтягивает позиции из привязываемых УПД в формате shipment_items.
// Симметрично buildDeliveryItemsFromSources в routes/deliveries.ts.
async function buildShipmentItemsFromSources(
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
