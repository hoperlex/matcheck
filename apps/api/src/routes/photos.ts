import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import {
  PhotoConfirmResponseSchema,
  PhotoDeleteResponseSchema,
  PhotoGetUrlResponseSchema,
  PhotoPatchRequestSchema,
  PhotoPatchResponseSchema,
  PhotoPresignRequestSchema,
  PhotoPresignResponseSchema,
  PhotoRecognitionSchema,
  ErrorResponseSchema,
} from '@matcheck/contracts';
import {
  counterparties,
  deliveries,
  deliveryPhotos,
  photoRecognizedItems,
  shipments,
  shipmentPhotos,
  sites,
} from '../db/schema.js';
import { deleteObject, getObject, headObject, presign } from '../domain/storage/s3.signer.js';
import { buildS3Key } from '../domain/storage/s3.path.js';
import { recognizePhotoItems } from '../domain/photos/recognize.js';
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

  // Стрим фото через API — миниатюра или оригинал. Веб-портал использует
  // именно его (не presigned), потому что прямой <img src="https://s3...">
  // в Cloud.ru нестабилен: часть параллельных GET к одному bucket'у
  // получает ERR_CONNECTION_RESET и висит до браузерного таймаута. Через
  // сервер же запросы идут из соседнего датацентра — стабильно.
  //
  // Стримит то же тело, что прямой S3, и форвардит conditional headers
  // (If-None-Match/If-Modified-Since/Range), чтобы браузер мог отдавать
  // 304 и не качать миниатюру повторно. Cache-Control: private, чтобы
  // ответ не оседал в общих прокси и не утекал между пользователями.
  app.get(
    '/api/v1/photos/:id/content',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({ thumb: z.coerce.boolean().default(false) }),
      },
    },
    async (req, reply) => {
      const found = await findPhoto(app, req.params.id);
      if (!found) return reply.code(404).send({ error: 'not_found' });
      if (
        req.user?.role === 'inspector_kpp' &&
        (!req.user.siteId || found.parentSiteId !== req.user.siteId)
      ) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const key = req.query.thumb && found.thumbS3Key ? found.thumbS3Key : found.s3Key;

      let signedUrl: string;
      try {
        // Короткий TTL — URL используется сразу в server-side fetch, на клиент
        // не уходит, поэтому большой запас не нужен.
        signedUrl = await presign({ method: 'GET', key, expiresIn: 60 });
      } catch (err) {
        req.log.warn({ err, key }, 'presign failed for photo content');
        return reply.code(404).send({ error: 'presign_failed' });
      }

      const upstreamHeaders: Record<string, string> = {};
      const range = req.headers.range;
      if (typeof range === 'string') upstreamHeaders.range = range;
      const inm = req.headers['if-none-match'];
      if (typeof inm === 'string') upstreamHeaders['if-none-match'] = inm;
      const ims = req.headers['if-modified-since'];
      if (typeof ims === 'string') upstreamHeaders['if-modified-since'] = ims;

      // Жёсткий таймаут 8 сек на upstream-fetch к S3. Без него зависший
      // Cloud.ru держал бы Node-сокет и file descriptor до системного
      // таймаута (минуты), а при многих параллельных пользователях это
      // быстро упирается в ulimit и event-loop. 8 сек выбраны как «больше
      // нормального p99 thumb-загрузки, но меньше человеческого терпения»:
      // если S3 не ответил за это время — отдаём 504, клиент покажет
      // broken-state с кнопкой «Повторить».
      let upstream: Response;
      try {
        upstream = await fetch(signedUrl, {
          headers: upstreamHeaders,
          signal: AbortSignal.timeout(8000),
        });
      } catch (err) {
        const aborted =
          err instanceof DOMException && err.name === 'TimeoutError';
        req.log.warn({ err, key, aborted }, 'S3 fetch failed for photo content');
        return reply
          .code(aborted ? 504 : 502)
          .send({ error: aborted ? 's3_timeout' : 's3_unavailable' });
      }

      const ok = upstream.ok || upstream.status === 206 || upstream.status === 304;
      if (!ok) {
        req.log.warn({ status: upstream.status, key }, 'S3 returned non-OK for photo content');
        return reply.code(502).send({ error: 's3_unavailable' });
      }

      reply.code(upstream.status);
      for (const h of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        const v = upstream.headers.get(h);
        if (v) reply.header(h, v);
      }

      const ext = key.split('.').pop()?.toLowerCase() ?? 'jpg';
      const mimeFromExt =
        ext === 'png' ? 'image/png'
          : ext === 'webp' ? 'image/webp'
          : ext === 'heic' ? 'image/heic'
          : ext === 'heif' ? 'image/heif'
          : 'image/jpeg';
      reply.header('content-type', upstream.headers.get('content-type') ?? mimeFromExt);
      // 1 час браузерного кэша. Фото immutable по photoId — после
      // удаления оно физически исчезает из БД, а новый объект получает
      // новый UUID и не попадёт в этот кэш.
      reply.header('cache-control', 'private, max-age=3600');

      if (upstream.status === 304 || !upstream.body) {
        return reply.send();
      }
      return reply.send(Readable.fromWeb(upstream.body as never));
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

  // PATCH /api/v1/photos/:id — изменение только метаданных фото
  // (сейчас — только kind). Менеджер на портале может исправить тип,
  // если инспектор на мобиле выбрал не ту кнопку («Груз» вместо
  // «Документ»). Не трогает stage, файл, takenAt, attachment.
  //
  // Мобильный клиент это поле не пишет (только читает), поэтому
  // безопасно менять с веба — следующий /sync отдаст обновлённый kind,
  // мобила upsertнет в Room и UI на 2 Этапе/в Архиве подхватит.
  //
  // Авторизация — admin/manager (как у большинства мутаций приёмки).
  // Inspector_kpp не редактирует чужие фото; своё фото он может только
  // удалить и переснять.
  app.patch(
    '/api/v1/photos/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: PhotoPatchRequestSchema,
        response: {
          200: PhotoPatchResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const found = await findPhoto(app, req.params.id);
      if (!found) return reply.code(404).send({ error: 'not_found' });

      // pendingDeletionAt-check симметричен DELETE: пока документ в
      // отложенном удалении — мутации фото блокируем, чтобы не плодить
      // изменения, которые через час исчезнут вместе с приёмкой.
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
        await app.db
          .update(deliveryPhotos)
          .set({ kind: req.body.kind })
          .where(eq(deliveryPhotos.id, req.params.id));
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
        await app.db
          .update(shipmentPhotos)
          .set({ kind: req.body.kind })
          .where(eq(shipmentPhotos.id, req.params.id));
      }
      TABLES[found.kind].publishUpdated(app, found.operationId);
      return { ok: true as const, kind: req.body.kind };
    },
  );

  // ── Распознавание материалов из фото-документа ────────────────────────
  // Используется split-view модалкой в Принятых (клик на фото с
  // kind='document'). Логика:
  //   GET  → отдаёт кэш (если есть), иначе 404.
  //   POST → если кэш есть и без ошибки — отдаёт его без LLM-вызова;
  //          если нет/failed — синхронно запускает LLM и кэширует.
  // Идемпотентность: уникальные partial-индексы на (delivery_photo_id) и
  // (shipment_photo_id) — попытка двойного POST увидит существующую запись.

  app.get(
    '/api/v1/photos/:id/recognition',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: PhotoRecognitionSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const found = await findPhoto(app, req.params.id);
      if (!found) return reply.code(404).send({ error: 'not_found' });
      if (
        req.user?.role === 'inspector_kpp' &&
        (!req.user.siteId || found.parentSiteId !== req.user.siteId)
      ) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const cached = await loadRecognition(app, found.kind, req.params.id);
      if (!cached) return reply.code(404).send({ error: 'not_found' });
      return cached;
    },
  );

  app.post(
    '/api/v1/photos/:id/recognize',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({
          // ?force=true — заново распознать, даже если кэш есть.
          force: z.coerce.boolean().optional(),
        }),
        response: {
          200: PhotoRecognitionSchema,
          404: ErrorResponseSchema,
          422: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const found = await findPhoto(app, req.params.id);
      if (!found) return reply.code(404).send({ error: 'not_found' });

      // Кэш-хит без force и без error_message — отдаём без LLM-вызова.
      if (!req.query.force) {
        const cached = await loadRecognition(app, found.kind, req.params.id);
        if (cached && cached.status === 'done') return cached;
      }

      // Проверка типа фото: распознаём только документы.
      const photoKind = await getPhotoKind(app, found.kind, req.params.id);
      if (photoKind !== 'document') {
        return reply.code(422).send({
          error: 'not_a_document',
          message: 'Распознавание доступно только для фото с kind="document"',
        });
      }

      // Скачиваем оригинал из S3 (полное разрешение для LLM; thumb
      // обрезает и снижает качество). Размер ~1-5 МБ.
      let buffer: Buffer;
      try {
        buffer = await getObject(found.s3Key);
      } catch (err) {
        req.log.error({ err, key: found.s3Key }, 's3 get failed for recognize');
        return reply
          .code(500)
          .send({ error: 's3_unavailable', message: 'Не удалось загрузить фото из хранилища' });
      }

      // Расширение → MIME. Если не угадать, по дефолту image/jpeg —
      // подавляющее большинство фото с мобилы именно так.
      const ext = found.s3Key.split('.').pop()?.toLowerCase() ?? 'jpg';
      const mimeType =
        ext === 'png' ? 'image/png' :
        ext === 'webp' ? 'image/webp' :
        ext === 'heic' ? 'image/heic' :
        ext === 'heif' ? 'image/heif' :
        'image/jpeg';

      // Используем отдельный, более терпимый промпт под split-view
      // (domain/photos/recognize.ts) — он не требует жёсткой классификации
      // формы и лучше работает на наклонных фото и нестандартных
      // накладных, чем parseWaybillBatch.
      let llmResult;
      try {
        llmResult = await recognizePhotoItems(buffer, mimeType);
      } catch (err) {
        req.log.error({ err }, 'recognizePhotoItems failed');
        const message = err instanceof Error ? err.message : 'Распознавание не удалось';
        await upsertRecognition(app, found.kind, req.params.id, {
          status: 'failed',
          items: [],
          docForm: null,
          docNumber: null,
          docDate: null,
          totalSum: null,
          confidence: null,
          model: null,
          errorMessage: message,
        });
        return reply.code(500).send({ error: 'recognition_failed', message });
      }

      const saved = await upsertRecognition(app, found.kind, req.params.id, {
        status: 'done',
        items: llmResult.items.map((it) => ({
          nameRaw: it.nameRaw,
          qty: it.qty ?? null,
          unit: it.unit ?? null,
          invNumber: it.invNumber ?? null,
          price: it.price ?? null,
          sum: it.sum ?? null,
        })),
        docForm: llmResult.docForm,
        docNumber: llmResult.docNumber,
        docDate: llmResult.docDate,
        totalSum: llmResult.totalSum,
        confidence: llmResult.confidence,
        model: llmResult.model,
        errorMessage: null,
      });
      return saved;
    },
  );
}

// Читает кэш распознавания фото. Возвращает null, если кэша нет.
async function loadRecognition(
  app: ReturnType<typeof asZod>,
  kind: OperationKind,
  photoId: string,
): Promise<z.infer<typeof PhotoRecognitionSchema> | null> {
  const col = kind === 'delivery'
    ? photoRecognizedItems.deliveryPhotoId
    : photoRecognizedItems.shipmentPhotoId;
  const [row] = await app.db
    .select()
    .from(photoRecognizedItems)
    .where(eq(col, photoId))
    .limit(1);
  if (!row) return null;
  return {
    status: row.errorMessage ? 'failed' : 'done',
    items: (row.items as z.infer<typeof PhotoRecognitionSchema>['items']) ?? [],
    docForm: row.docForm,
    docNumber: row.docNumber,
    docDate: row.docDate,
    totalSum: row.totalSum !== null ? Number(row.totalSum) : null,
    confidence: row.confidence !== null ? Number(row.confidence) : null,
    model: row.model,
    errorMessage: row.errorMessage,
    recognizedAt: row.updatedAt.toISOString(),
  };
}

// UPSERT кэша распознавания. Уникальный partial-индекс по
// delivery_photo_id/shipment_photo_id гарантирует одну запись на фото.
async function upsertRecognition(
  app: ReturnType<typeof asZod>,
  kind: OperationKind,
  photoId: string,
  data: {
    status: 'done' | 'failed';
    items: z.infer<typeof PhotoRecognitionSchema>['items'];
    docForm: string | null;
    docNumber: string | null;
    docDate: string | null;
    totalSum: number | null;
    confidence: number | null;
    model: string | null;
    errorMessage: string | null;
  },
): Promise<z.infer<typeof PhotoRecognitionSchema>> {
  const values = {
    deliveryPhotoId: kind === 'delivery' ? photoId : null,
    shipmentPhotoId: kind === 'shipment' ? photoId : null,
    items: data.items,
    docForm: data.docForm,
    docNumber: data.docNumber,
    docDate: data.docDate,
    totalSum: data.totalSum !== null ? String(data.totalSum) : null,
    confidence: data.confidence !== null ? String(data.confidence) : null,
    model: data.model,
    errorMessage: data.errorMessage,
    updatedAt: new Date(),
  };
  const conflictCol = kind === 'delivery'
    ? photoRecognizedItems.deliveryPhotoId
    : photoRecognizedItems.shipmentPhotoId;
  await app.db
    .insert(photoRecognizedItems)
    .values(values)
    .onConflictDoUpdate({
      target: conflictCol,
      targetWhere: kind === 'delivery'
        ? eq(photoRecognizedItems.deliveryPhotoId, photoId)
        : eq(photoRecognizedItems.shipmentPhotoId, photoId),
      set: {
        items: values.items,
        docForm: values.docForm,
        docNumber: values.docNumber,
        docDate: values.docDate,
        totalSum: values.totalSum,
        confidence: values.confidence,
        model: values.model,
        errorMessage: values.errorMessage,
        updatedAt: values.updatedAt,
      },
    });
  const result = await loadRecognition(app, kind, photoId);
  if (!result) throw new Error('upsertRecognition: запись пропала после insert');
  return result;
}

async function getPhotoKind(
  app: ReturnType<typeof asZod>,
  opKind: OperationKind,
  photoId: string,
): Promise<string | null> {
  if (opKind === 'delivery') {
    const [r] = await app.db
      .select({ kind: deliveryPhotos.kind })
      .from(deliveryPhotos)
      .where(eq(deliveryPhotos.id, photoId))
      .limit(1);
    return r?.kind ?? null;
  }
  const [r] = await app.db
    .select({ kind: shipmentPhotos.kind })
    .from(shipmentPhotos)
    .where(eq(shipmentPhotos.id, photoId))
    .limit(1);
  return r?.kind ?? null;
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
