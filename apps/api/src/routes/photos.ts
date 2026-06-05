import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import {
  PhotoConfirmResponseSchema,
  PhotoDeleteResponseSchema,
  PhotoGetUrlResponseSchema,
  PhotoPresignRequestSchema,
  PhotoPresignResponseSchema,
  ErrorResponseSchema,
} from '@matcheck/contracts';
import {
  counterparties,
  deliveries,
  deliveryPhotos,
  shipments,
  shipmentPhotos,
  sites,
} from '../db/schema.js';
import { deleteObject, headObject, presign } from '../domain/storage/s3.signer.js';
import { buildS3Key } from '../domain/storage/s3.path.js';
import { publishEvent } from './events.js';

// TTL presigned URL для GET/PUT в S3. Поднят с 300с до 900с, чтобы
// компенсировать возможный дрейф системных часов API-сервера: при
// расхождении на минуту-две раньше эффективное окно валидности URL
// сужалось до 3-4 мин, и react-query успевал отдать «свежий» URL,
// который S3 уже считал истёкшим (Request has expired). 15 мин — типовой
// безопасный для production TTL: подпись валидна только на конкретный
// объект, бакет не светим.
const URL_TTL = 900; // 15 min

type OperationKind = 'delivery' | 'shipment';

// Расширение файла в S3-ключе по реальному MIME. Для неизвестного типа —
// 'bin' (S3 хранит как application/octet-stream). Сервер не валидирует
// контент, только использует расширение для удобства админ-просмотра.
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/webp': 'webp',
};
function extensionFor(mime: string): string {
  return EXT_BY_MIME[mime.toLowerCase()] ?? 'bin';
}

/**
 * Тонкая абстракция: для каждой стороны (delivery|shipment) фиксируем
 * нужную таблицу фото и проверку доступа owner-only для inspector_kpp.
 */
type PhotoTable = {
  kind: OperationKind;
  prefix: string;
  publishUpdated: (app: ReturnType<typeof asZod>, opId: string) => void;
};

const TABLES: Record<OperationKind, PhotoTable> = {
  delivery: {
    kind: 'delivery',
    prefix: 'photos',
    publishUpdated: (app, id) =>
      publishEvent(app, { type: 'delivery_updated', entityId: id, ts: new Date().toISOString() }),
  },
  shipment: {
    kind: 'shipment',
    prefix: 'shipment_photos',
    publishUpdated: (app, id) =>
      publishEvent(app, { type: 'shipment_updated', entityId: id, ts: new Date().toISOString() }),
  },
};

export async function photoRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);

  app.post(
    '/api/v1/photos/presign',
    {
      preHandler: [app.authenticate],
      schema: {
        body: PhotoPresignRequestSchema,
        response: {
          200: PhotoPresignResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const body = req.body;
      const operationKind: OperationKind = body.operationKind ?? 'delivery';
      const operationId = body.operationId ?? body.deliveryId;
      if (!operationId) {
        return reply
          .code(400)
          .send({ error: 'bad_request', message: 'operationId is required' });
      }

      if (operationKind === 'delivery') {
        const [d] = await app.db
          .select({
            id: deliveries.id,
            inspectorId: deliveries.inspectorId,
            pendingDeletionAt: deliveries.pendingDeletionAt,
            siteId: deliveries.siteId,
            contractorId: deliveries.contractorId,
            supplierId: deliveries.supplierId,
          })
          .from(deliveries)
          .where(eq(deliveries.id, operationId))
          .limit(1);
        if (!d) return reply.code(404).send({ error: 'delivery_not_found' });
        if (req.user?.role === 'inspector_kpp' && d.inspectorId !== req.user.id) {
          return reply.code(403).send({ error: 'forbidden' });
        }
        // Помеченный на удаление документ — read-only.
        if (d.pendingDeletionAt !== null) {
          return reply.code(409).send({
            error: 'pending_deletion',
            message: 'Документ помечен на удаление — мутации фото запрещены',
          });
        }

        const [existing] = await app.db
          .select()
          .from(deliveryPhotos)
          .where(
            and(
              eq(deliveryPhotos.deliveryId, operationId),
              eq(deliveryPhotos.contentHash, body.contentHash),
            ),
          )
          .limit(1);
        if (existing) {
          const uploadUrl = await presign({
            method: 'PUT',
            key: existing.s3Key,
            expiresIn: URL_TTL,
            contentType: body.contentType,
          }).catch(() => '');
          return {
            photoId: existing.id,
            s3Key: existing.s3Key,
            thumbS3Key: existing.thumbS3Key,
            uploadUrl: uploadUrl || '',
            thumbUploadUrl: null,
            expiresIn: URL_TTL,
            alreadyExists: true,
          };
        }

        // Подтягиваем site.code и контрагента для иерархии в S3:
        // {site.code}/{counterparty}/deliveries/{id}/{filename}.
        // Приёмка: contractor (если есть) → supplier → 'unknown'.
        const cpId = d.contractorId ?? d.supplierId;
        const [site] = await app.db
          .select({ code: sites.code })
          .from(sites)
          .where(eq(sites.id, d.siteId))
          .limit(1);
        const [cp] = cpId
          ? await app.db
              .select({ inn: counterparties.inn, name: counterparties.name })
              .from(counterparties)
              .where(eq(counterparties.id, cpId))
              .limit(1)
          : [undefined];

        const photoId = crypto.randomUUID();
        const ext = extensionFor(body.contentType);
        const s3Key = buildS3Key({
          site: site ?? null,
          counterparty: cp ?? null,
          entityType: 'deliveries',
          entityId: operationId,
          filename: `${photoId}.${ext}`,
        });
        const thumbS3Key = body.thumbContentHash
          ? buildS3Key({
              site: site ?? null,
              counterparty: cp ?? null,
              entityType: 'deliveries',
              entityId: operationId,
              filename: `${photoId}-thumb.${ext}`,
            })
          : null;
        const [created] = await app.db
          .insert(deliveryPhotos)
          .values({
            id: photoId,
            deliveryId: operationId,
            kind: body.kind,
            stage: body.stage ?? 'before',
            s3Key,
            thumbS3Key,
            contentHash: body.contentHash,
            idempotencyKey: body.idempotencyKey,
          })
          .returning();
        if (!created) throw new Error('Failed to insert photo');

        const { uploadUrl, thumbUploadUrl } = await presignBoth(
          app,
          s3Key,
          thumbS3Key,
          body.contentType,
        );
        TABLES.delivery.publishUpdated(app, operationId);
        return {
          photoId,
          s3Key,
          thumbS3Key,
          uploadUrl,
          thumbUploadUrl,
          expiresIn: URL_TTL,
          alreadyExists: false,
        };
      }

      // operationKind === 'shipment'
      const [s] = await app.db
        .select({
          id: shipments.id,
          inspectorId: shipments.inspectorId,
          pendingDeletionAt: shipments.pendingDeletionAt,
          siteId: shipments.siteId,
          kind: shipments.kind,
          receiverCounterpartyId: shipments.receiverCounterpartyId,
          destSiteId: shipments.destSiteId,
        })
        .from(shipments)
        .where(eq(shipments.id, operationId))
        .limit(1);
      if (!s) return reply.code(404).send({ error: 'shipment_not_found' });
      if (req.user?.role === 'inspector_kpp' && s.inspectorId !== req.user.id) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      if (s.pendingDeletionAt !== null) {
        return reply.code(409).send({
          error: 'pending_deletion',
          message: 'Документ помечен на удаление — мутации фото запрещены',
        });
      }

      const [existing] = await app.db
        .select()
        .from(shipmentPhotos)
        .where(
          and(
            eq(shipmentPhotos.shipmentId, operationId),
            eq(shipmentPhotos.contentHash, body.contentHash),
          ),
        )
        .limit(1);
      if (existing) {
        const uploadUrl = await presign({
          method: 'PUT',
          key: existing.s3Key,
          expiresIn: URL_TTL,
          contentType: body.contentType,
        }).catch(() => '');
        return {
          photoId: existing.id,
          s3Key: existing.s3Key,
          thumbS3Key: existing.thumbS3Key,
          uploadUrl: uploadUrl || '',
          thumbUploadUrl: null,
          expiresIn: URL_TTL,
          alreadyExists: true,
        };
      }

      // Иерархия S3 для отгрузки: контрагент определяется по kind.
      const [shSite] = await app.db
        .select({ code: sites.code })
        .from(sites)
        .where(eq(sites.id, s.siteId))
        .limit(1);
      const [shCp] = s.receiverCounterpartyId
        ? await app.db
            .select({ inn: counterparties.inn, name: counterparties.name })
            .from(counterparties)
            .where(eq(counterparties.id, s.receiverCounterpartyId))
            .limit(1)
        : [undefined];
      let shFallback: string | undefined;
      if (!shCp) {
        if (s.kind === 'transfer' && s.destSiteId) {
          const [dest] = await app.db
            .select({ code: sites.code })
            .from(sites)
            .where(eq(sites.id, s.destSiteId))
            .limit(1);
          shFallback = `transfer-to-${dest?.code ?? 'unknown'}`;
        } else if (s.kind === 'writeoff') {
          shFallback = 'writeoff';
        }
      }

      const photoId = crypto.randomUUID();
      const ext = extensionFor(body.contentType);
      const s3Key = buildS3Key({
        site: shSite ?? null,
        counterparty: shCp ?? null,
        fallbackCounterparty: shFallback,
        entityType: 'shipments',
        entityId: operationId,
        filename: `${photoId}.${ext}`,
      });
      const thumbS3Key = body.thumbContentHash
        ? buildS3Key({
            site: shSite ?? null,
            counterparty: shCp ?? null,
            fallbackCounterparty: shFallback,
            entityType: 'shipments',
            entityId: operationId,
            filename: `${photoId}-thumb.${ext}`,
          })
        : null;
      const [created] = await app.db
        .insert(shipmentPhotos)
        .values({
          id: photoId,
          shipmentId: operationId,
          kind: body.kind,
          stage: body.stage ?? 'before',
          s3Key,
          thumbS3Key,
          contentHash: body.contentHash,
          idempotencyKey: body.idempotencyKey,
        })
        .returning();
      if (!created) throw new Error('Failed to insert shipment photo');

      const { uploadUrl, thumbUploadUrl } = await presignBoth(
        app,
        s3Key,
        thumbS3Key,
        body.contentType,
      );
      TABLES.shipment.publishUpdated(app, operationId);
      return {
        photoId,
        s3Key,
        thumbS3Key,
        uploadUrl,
        thumbUploadUrl,
        expiresIn: URL_TTL,
        alreadyExists: false,
      };
    },
  );

  // Backward-compatible GET без operationKind в пути — ищем сначала в deliveryPhotos,
  // потом в shipmentPhotos.
  app.get(
    '/api/v1/photos/:id/url',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({ thumb: z.coerce.boolean().default(false) }),
        response: {
          200: PhotoGetUrlResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const found = await findPhoto(app, req.params.id);
      if (!found) return reply.code(404).send({ error: 'not_found' });
      // Inspector_kpp может скачивать только фото своего объекта. Возвращаем
      // 404 (а не 403), чтобы не раскрывать существование чужих фото.
      if (
        req.user?.role === 'inspector_kpp' &&
        (!req.user.siteId || found.parentSiteId !== req.user.siteId)
      ) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const key = req.query.thumb && found.thumbS3Key ? found.thumbS3Key : found.s3Key;
      try {
        const url = await presign({ method: 'GET', key, expiresIn: URL_TTL });
        return { url, expiresIn: URL_TTL };
      } catch {
        return reply.code(500).send({ error: 's3_unavailable', message: 'S3 not configured' });
      }
    },
  );

  // Confirm: клиент вызывает после успешного PUT в S3 — сервер проверяет
  // S3.HEAD и проставляет uploaded_at = now(). Cleanup-job не тронет
  // подтверждённые записи. Idempotent: повторный вызов возвращает прежний
  // uploaded_at без новой проверки S3 (по существующему значению).
  app.post(
    '/api/v1/photos/:id/confirm',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: PhotoConfirmResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const found = await findPhoto(app, req.params.id);
      if (!found) return reply.code(404).send({ error: 'not_found' });
      // Та же owner-проверка, что и в GET URL.
      if (
        req.user?.role === 'inspector_kpp' &&
        (!req.user.siteId || found.parentSiteId !== req.user.siteId)
      ) {
        return reply.code(404).send({ error: 'not_found' });
      }

      // Если уже подтверждено — отдаём существующий uploaded_at без S3-вызова.
      const table = found.kind === 'delivery' ? deliveryPhotos : shipmentPhotos;
      const [row] = await app.db
        .select({ uploadedAt: table.uploadedAt })
        .from(table)
        .where(eq(table.id, req.params.id))
        .limit(1);
      if (row?.uploadedAt) {
        return { ok: true as const, uploadedAt: row.uploadedAt.toISOString() };
      }

      let exists: boolean;
      try {
        exists = await headObject(found.s3Key);
      } catch (err) {
        req.log.error({ err, key: found.s3Key }, 's3 HEAD failed in confirm');
        return reply
          .code(500)
          .send({ error: 's3_unavailable', message: 'S3 проверка недоступна' });
      }
      if (!exists) {
        return reply.code(404).send({
          error: 'not_in_s3',
          message: 'PUT в S3 ещё не завершён — повторите загрузку',
        });
      }
      const now = new Date();
      if (found.kind === 'delivery') {
        await app.db
          .update(deliveryPhotos)
          .set({ uploadedAt: now })
          .where(eq(deliveryPhotos.id, req.params.id));
      } else {
        await app.db
          .update(shipmentPhotos)
          .set({ uploadedAt: now })
          .where(eq(shipmentPhotos.id, req.params.id));
      }
      return { ok: true as const, uploadedAt: now.toISOString() };
    },
  );

  app.delete(
    '/api/v1/photos/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: PhotoDeleteResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const found = await findPhoto(app, req.params.id);
      if (!found) return reply.code(404).send({ error: 'not_found' });

      // Помеченный документ — read-only; удаление целиком идёт через DELETE /deliveries|shipments/:id.
      if (found.kind === 'delivery') {
        const [parent] = await app.db
          .select({ pendingDeletionAt: deliveries.pendingDeletionAt })
          .from(deliveries)
          .where(eq(deliveries.id, found.operationId))
          .limit(1);
        if (parent?.pendingDeletionAt !== null && parent?.pendingDeletionAt !== undefined) {
          return reply.code(409).send({
            error: 'pending_deletion',
            message: 'Документ помечен на удаление — мутации фото запрещены',
          });
        }
        await app.db.delete(deliveryPhotos).where(eq(deliveryPhotos.id, req.params.id));
      } else {
        const [parent] = await app.db
          .select({ pendingDeletionAt: shipments.pendingDeletionAt })
          .from(shipments)
          .where(eq(shipments.id, found.operationId))
          .limit(1);
        if (parent?.pendingDeletionAt !== null && parent?.pendingDeletionAt !== undefined) {
          return reply.code(409).send({
            error: 'pending_deletion',
            message: 'Документ помечен на удаление — мутации фото запрещены',
          });
        }
        await app.db.delete(shipmentPhotos).where(eq(shipmentPhotos.id, req.params.id));
      }
      await deleteObject(found.s3Key).catch((err) =>
        app.log.warn({ err, key: found.s3Key }, 's3 delete failed'),
      );
      if (found.thumbS3Key) {
        await deleteObject(found.thumbS3Key).catch((err) =>
          app.log.warn({ err, key: found.thumbS3Key }, 's3 thumb delete failed'),
        );
      }
      TABLES[found.kind].publishUpdated(app, found.operationId);
      return { ok: true as const };
    },
  );
}

async function presignBoth(
  app: ReturnType<typeof asZod>,
  s3Key: string,
  thumbS3Key: string | null,
  contentType: string,
): Promise<{ uploadUrl: string; thumbUploadUrl: string | null }> {
  let uploadUrl = '';
  let thumbUploadUrl: string | null = null;
  try {
    uploadUrl = await presign({ method: 'PUT', key: s3Key, expiresIn: URL_TTL, contentType });
    if (thumbS3Key) {
      thumbUploadUrl = await presign({
        method: 'PUT',
        key: thumbS3Key,
        expiresIn: URL_TTL,
        contentType,
      });
    }
  } catch (err) {
    app.log.warn({ err }, 'presign failed — returning empty URLs');
  }
  return { uploadUrl, thumbUploadUrl };
}

async function findPhoto(
  app: ReturnType<typeof asZod>,
  id: string,
): Promise<
  | {
      kind: OperationKind;
      operationId: string;
      s3Key: string;
      thumbS3Key: string | null;
      parentSiteId: string | null;
    }
  | null
> {
  const [d] = await app.db
    .select({
      s3Key: deliveryPhotos.s3Key,
      thumbS3Key: deliveryPhotos.thumbS3Key,
      operationId: deliveryPhotos.deliveryId,
      parentSiteId: deliveries.siteId,
    })
    .from(deliveryPhotos)
    .innerJoin(deliveries, eq(deliveries.id, deliveryPhotos.deliveryId))
    .where(eq(deliveryPhotos.id, id))
    .limit(1);
  if (d)
    return {
      kind: 'delivery',
      operationId: d.operationId,
      s3Key: d.s3Key,
      thumbS3Key: d.thumbS3Key,
      parentSiteId: d.parentSiteId,
    };

  const [s] = await app.db
    .select({
      s3Key: shipmentPhotos.s3Key,
      thumbS3Key: shipmentPhotos.thumbS3Key,
      operationId: shipmentPhotos.shipmentId,
      parentSiteId: shipments.siteId,
    })
    .from(shipmentPhotos)
    .innerJoin(shipments, eq(shipments.id, shipmentPhotos.shipmentId))
    .where(eq(shipmentPhotos.id, id))
    .limit(1);
  if (s)
    return {
      kind: 'shipment',
      operationId: s.operationId,
      s3Key: s.s3Key,
      thumbS3Key: s.thumbS3Key,
      parentSiteId: s.parentSiteId,
    };

  return null;
}
