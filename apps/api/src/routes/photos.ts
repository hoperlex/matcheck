import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import { assertPermission } from '../lib/permissions/assert.js';
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
import {
  deleteObject,
  getObject,
  headObject,
  presign,
  putObject,
} from '../domain/storage/s3.signer.js';
import { buildS3Key } from '../domain/storage/s3.path.js';
import { recognizePhotoItems } from '../domain/photos/recognize.js';
import { buildExistingPhotoPresign } from '../domain/photos/presign-existing.js';
import { publishEvent } from './events.js';
import { FOREIGN_SITE_RESPONSE } from '../domain/operations/foreign-site.js';
import { resolveConfirmedAt } from '../domain/operations/confirmed-at.js';
import {
  resolveContractorOpIds,
  deliveryVisibleToContractor,
} from '../lib/contractor-scope.js';
import type { AuthUser } from '../plugins/auth.js';

// TTL presigned URL для GET/PUT в S3. Поднят с 300с до 900с, чтобы
// компенсировать возможный дрейф системных часов API-сервера: при
// расхождении на минуту-две раньше эффективное окно валидности URL
// сужалось до 3-4 мин, и react-query успевал отдать «свежий» URL,
// который S3 уже считал истёкшим (Request has expired). 15 мин — типовой
// безопасный для production TTL: подпись валидна только на конкретный
// объект, бакет не светим.
const URL_TTL = 900; // 15 min

// Пределы для POST /photos/:id/content (загрузка через API-прокси).
// Веб жмёт кадр до ~1,5 МБ и миниатюру до ~0,1 МБ (photoPipeline.capturePhoto:
// compressInWorker(blob, 1.5, 2048) и (blob, 0.1, 320)), так что запас двукратный.
// Держим низко осознанно: у контейнера API mem_limit 700m, а буфер каждой части
// живёт в памяти целиком — дефолтные 10 МБ на файл дали бы до 20 МБ на запрос.
const PHOTO_MAIN_MAX_BYTES = 2 * 1024 * 1024;
const PHOTO_THUMB_MAX_BYTES = 256 * 1024;

// limits.fileSize у @fastify/multipart один на все части запроса, поэтому
// парсеру отдаём предел кадра, а миниатюру проверяем вручную после toBuffer().
const PHOTO_UPLOAD_PART_LIMITS = { files: 2, fileSize: PHOTO_MAIN_MAX_BYTES };

/**
 * Ошибки лимитов @fastify/multipart несут statusCode 413, но общий
 * error-handler намеренно его игнорирует и отдаёт 500 (lib/error-handler.ts).
 * Для загрузки фото это особенно вредно: веб классифицирует 5xx как retriable
 * (uploadRetryPolicy.classifyUploadError) и уходит в бесконечный backoff вместо
 * показа внятной ошибки. Поэтому распознаём коды здесь и отвечаем 413 сами.
 * Дублирует limitErrorOf из domain/sourceDocuments/collect-upload.ts — тот не
 * экспортирован и завязан на свой тип CollectError.
 */
function multipartLimitMessage(err: unknown): string | null {
  switch ((err as { code?: string } | null)?.code ?? '') {
    case 'FST_REQ_FILE_TOO_LARGE':
      return 'Файл больше допустимого размера';
    case 'FST_FILES_LIMIT':
    case 'FST_PARTS_LIMIT':
    case 'FST_FIELDS_LIMIT':
      return 'Слишком много частей в запросе';
    default:
      return null;
  }
}

/** JPEG начинается с FF D8 FF — проверяем сигнатуру, а не только заявленный MIME. */
function isJpeg(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

/** Минимальный контракт @fastify/multipart, который нужен этому роуту. */
type MultipartPart =
  | { type: 'file'; fieldname: string; toBuffer: () => Promise<Buffer> }
  | { type: 'field'; fieldname: string };
type MultipartRequest = {
  parts: (opts: { limits: { files: number; fileSize: number } }) => AsyncIterableIterator<MultipartPart>;
};

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
 * нужную таблицу фото и проверку доступа по объекту для inspector_kpp.
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

/**
 * Бампает ТОЛЬКО updatedAt родительской приёмки/отгрузки при фото-мутации.
 *
 * Зачем: фото лежат в отдельной таблице (delivery_photos/shipment_photos), и
 * чистое добавление/удаление/смена типа фото раньше не сдвигало
 * deliveries/shipments.updatedAt. А delta-sync (/api/v1/sync) выбирает
 * операции именно по updatedAt ≥ since. Поэтому фото, добавленное менеджером
 * на портале, не попадало в дельту и не доезжало на мобильный планшет —
 * хотя SSE-событие мобила и получала.
 *
 * ВАЖНО — что НЕ делаем:
 *  - НЕ инкрементируем version: иначе у мобильного draft 2 этапа, держащего
 *    baseVersion, при следующем upsert возник бы ложный OCC-конфликт.
 *    updatedAt достаточно, чтобы попасть в delta-выборку.
 *  - НЕ трогаем статус, items, sourceDocumentIds, pendingDeletionAt.
 */
async function touchPhotoParent(
  app: ReturnType<typeof asZod>,
  kind: OperationKind,
  operationId: string,
): Promise<void> {
  if (kind === 'delivery') {
    await app.db
      .update(deliveries)
      .set({ updatedAt: new Date() })
      .where(eq(deliveries.id, operationId));
  } else {
    await app.db
      .update(shipments)
      .set({ updatedAt: new Date() })
      .where(eq(shipments.id, operationId));
  }
}

export async function photoRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);

  app.post(
    '/api/v1/photos/presign',
    {
      // contractor/monitor — read-only роли: загрузка фото им недоступна.
      preHandler: [app.authenticate, app.authorize('admin', 'manager', 'inspector_kpp')],
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
            pendingDeletionAt: deliveries.pendingDeletionAt,
            siteId: deliveries.siteId,
            contractorId: deliveries.contractorId,
            supplierId: deliveries.supplierId,
          })
          .from(deliveries)
          .where(eq(deliveries.id, operationId))
          .limit(1);
        if (!d) return reply.code(404).send({ error: 'delivery_not_found' });
        // Скоуп — объект, а не автор. Инспектор после перевода на другой объект
        // остаётся автором прежних приёмок, и без site-check он мог бы догружать
        // фото туда, где уже не работает (см. domain/operations/foreign-site.ts).
        //
        // Автор НЕ проверяется намеренно: POST /api/v1/deliveries его тоже не
        // проверяет, а на одном объекте штатно работают несколько аккаунтов
        // (Этап 1 и Этап 2 закрывают разные смены). Пока owner-check тут был,
        // получалась расходящаяся модель доступа — данные и статус чужой приёмки
        // своего объекта менять можно, а фото к ней добавить нельзя: статус
        // доезжал до портала, фото 2 этапа молча оставались на планшете.
        if (req.user?.role === 'inspector_kpp' && d.siteId !== req.user.siteId) {
          await app.logUnauthorized(req, 403, 'photo_foreign_site', req.user.id);
          return reply.code(403).send(FOREIGN_SITE_RESPONSE);
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
          return buildExistingPhotoPresign(existing, URL_TTL, (s3Key, thumbS3Key) =>
            presignBoth(app, s3Key, thumbS3Key, body.contentType),
          );
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
            // Время съёмки — с планшета. Без него (старые сборки, веб-фронт)
            // остаётся defaultNow(), то есть прежнее поведение.
            ...(body.takenAt
              ? {
                  takenAt: resolveConfirmedAt({
                    raw: body.takenAt,
                    log: app.log,
                    entity: 'delivery',
                    id: photoId,
                  }),
                }
              : {}),
          })
          .returning();
        if (!created) throw new Error('Failed to insert photo');

        const { uploadUrl, thumbUploadUrl } = await presignBoth(
          app,
          s3Key,
          thumbS3Key,
          body.contentType,
        );
        await touchPhotoParent(app, 'delivery', operationId);
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
      // Скоуп по объекту, без owner-check — зеркало ветки приёмок выше.
      if (req.user?.role === 'inspector_kpp' && s.siteId !== req.user.siteId) {
        await app.logUnauthorized(req, 403, 'photo_foreign_site', req.user.id);
        return reply.code(403).send(FOREIGN_SITE_RESPONSE);
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
        return buildExistingPhotoPresign(existing, URL_TTL, (s3Key, thumbS3Key) =>
          presignBoth(app, s3Key, thumbS3Key, body.contentType),
        );
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
          // Симметрично приёмкам: время съёмки с планшета, иначе defaultNow().
          ...(body.takenAt
            ? {
                takenAt: resolveConfirmedAt({
                  raw: body.takenAt,
                  log: app.log,
                  entity: 'shipment',
                  id: photoId,
                }),
              }
            : {}),
        })
        .returning();
      if (!created) throw new Error('Failed to insert shipment photo');

      const { uploadUrl, thumbUploadUrl } = await presignBoth(
        app,
        s3Key,
        thumbS3Key,
        body.contentType,
      );
      await touchPhotoParent(app, 'shipment', operationId);
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
      // contractor — только фото своих приёмок/отгрузок (по прямому id иначе
      // достал бы чужое фото; read-only guard GET не ловит).
      if (
        req.user?.role === 'contractor' &&
        !(await photoVisibleToContractor(app, found, req.user))
      ) {
        return reply.code(404).send({ error: 'not_found' });
      }
      // Матрица прав — ПОСЛЕ проверок видимости выше и до обращения к S3.
      // Порядок принципиален: проверки выше намеренно отвечают 404, чтобы не
      // раскрывать существование чужого фото. Поставив права первыми, мы
      // превратили бы этот 404 в 403 и слили бы сам факт наличия записи.
      await assertPermission(req, pageOfKind(found.kind), 'view');
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
      if (
        req.user?.role === 'contractor' &&
        !(await photoVisibleToContractor(app, found, req.user))
      ) {
        return reply.code(404).send({ error: 'not_found' });
      }
      // См. комментарий о порядке в GET /api/v1/photos/:id/url.
      await assertPermission(req, pageOfKind(found.kind), 'view');
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

  // Загрузка файла через API-прокси: браузер → наш домен → S3. Зеркало GET
  // выше (GET читает, POST пишет).
  //
  // Зачем нужен отдельно от presign+PUT: у бакета cloud.ru нет CORS-правила для
  // origin портала, поэтому preflight браузерного PUT на s3.cloud.ru не проходит
  // и файл до S3 не доезжает вовсе. Строка при этом уже создана presign'ом, и
  // получался тихий сценарий «фото добавилось, но исчезло»: uploaded_at остаётся
  // null → портал прячет строку своим фильтром → через час её сносит
  // cleanupPhotoOrphans. Мобильный клиент ходит через OkHttp, preflight не делает
  // и на presigned PUT остаётся — его поток эта ручка не затрагивает.
  app.post(
    '/api/v1/photos/:id/content',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager', 'inspector_kpp')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: PhotoConfirmResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          413: ErrorResponseSchema,
          // 500 — неожиданный сбой БД; 503 — контролируемая недоступность S3.
          500: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const found = await findPhoto(app, req.params.id);
      if (!found) return reply.code(404).send({ error: 'not_found' });
      // Скоуп и коды — как у presign/confirm: только объект, автор не проверяется.
      if (
        req.user?.role === 'inspector_kpp' &&
        (!req.user.siteId || found.parentSiteId !== req.user.siteId)
      ) {
        await app.logUnauthorized(req, 403, 'photo_foreign_site', req.user.id);
        return reply.code(403).send(FOREIGN_SITE_RESPONSE);
      }
      // Право то же, что у presign: загрузка файла — часть создания фото.
      await assertPermission(req, pageOfKind(found.kind), 'create');

      const parentTable = found.kind === 'delivery' ? deliveries : shipments;
      const [parentBefore] = await app.db
        .select({ pendingDeletionAt: parentTable.pendingDeletionAt })
        .from(parentTable)
        .where(eq(parentTable.id, found.operationId))
        .limit(1);
      if (parentBefore?.pendingDeletionAt != null) {
        return reply.code(409).send({
          error: 'pending_deletion',
          message: 'Документ помечен на удаление — мутации фото запрещены',
        });
      }

      const table = found.kind === 'delivery' ? deliveryPhotos : shipmentPhotos;
      const [row] = await app.db
        .select({ uploadedAt: table.uploadedAt, contentHash: table.contentHash })
        .from(table)
        .where(eq(table.id, req.params.id))
        .limit(1);
      // Уже подтверждено — идемпотентно отдаём прежний uploaded_at, S3 не трогаем.
      if (row?.uploadedAt) {
        return { ok: true as const, uploadedAt: row.uploadedAt.toISOString() };
      }

      // Разбор частей. Читаем поток ДО КОНЦА даже при ошибке: ранний return из
      // цикла оставил бы незавершённый запрос висеть. Поэтому копим reject и
      // отвечаем после цикла, а лишние файловые части сливаем в toBuffer().
      let main: Buffer | null = null;
      let thumb: Buffer | null = null;
      // Поле именно `error` — таков контракт ErrorResponseSchema; с `code`
      // zod-сериализатор ответа падает, и клиент вместо 400 получает 500.
      let reject: { error: string; message: string } | null = null;
      const rejectOnce = (error: string, message: string) => {
        if (!reject) reject = { error, message };
      };
      try {
        for await (const part of (req as unknown as MultipartRequest).parts({
          limits: PHOTO_UPLOAD_PART_LIMITS,
        })) {
          if (part.type !== 'file') {
            rejectOnce('unexpected_part', `Неожиданное поле «${part.fieldname}»`);
            continue;
          }
          const buf = await part.toBuffer();
          if (part.fieldname === 'file') {
            if (main) rejectOnce('duplicate_part', 'Часть «file» передана дважды');
            else main = buf;
          } else if (part.fieldname === 'thumb') {
            if (thumb) rejectOnce('duplicate_part', 'Часть «thumb» передана дважды');
            else thumb = buf;
          } else {
            rejectOnce('unexpected_part', `Неожиданная часть «${part.fieldname}»`);
          }
        }
      } catch (err) {
        const limit = multipartLimitMessage(err);
        if (limit) return reply.code(413).send({ error: 'file_too_large', message: limit });
        throw err;
      }
      if (reject) {
        return reply.code(400).send(reject);
      }
      if (!main) {
        return reply.code(400).send({ error: 'no_file', message: 'Файл не приложен' });
      }
      if (main.length === 0) {
        return reply.code(400).send({ error: 'empty_file', message: 'Файл пуст' });
      }
      if (!isJpeg(main)) {
        return reply
          .code(400)
          .send({ error: 'unsupported_type', message: 'Ожидается JPEG' });
      }
      if (thumb && thumb.length > PHOTO_THUMB_MAX_BYTES) {
        return reply
          .code(413)
          .send({ error: 'file_too_large', message: 'Миниатюра больше допустимого размера' });
      }
      // Хэш строки посчитан клиентом при захвате — сверяем, чтобы битая передача
      // не осела в S3 под видом валидного кадра.
      if (row?.contentHash) {
        const actual = createHash('sha256').update(main).digest('hex');
        if (actual !== row.contentHash) {
          return reply
            .code(400)
            .send({ error: 'content_hash_mismatch', message: 'Содержимое не совпадает с заявленным' });
        }
      }

      try {
        await putObject(found.s3Key, main, 'image/jpeg');
      } catch (err) {
        req.log.error({ err, key: found.s3Key }, 's3 putObject failed for photo content');
        return reply.code(503).send({ error: 's3_unavailable', message: 'S3 недоступен' });
      }
      // Миниатюра — не «просто необязательная»: GET /content?thumb=true выбирает
      // thumbS3Key, если он непустой, поэтому ключ без объекта в S3 даёт битую
      // плитку вместо отката на полный кадр. Не сохранили — зануляем ключ ниже.
      const writtenKeys = [found.s3Key];
      let thumbStored = false;
      if (thumb && found.thumbS3Key) {
        try {
          await putObject(found.thumbS3Key, thumb, 'image/jpeg');
          writtenKeys.push(found.thumbS3Key);
          thumbStored = true;
        } catch (err) {
          req.log.warn(
            { err, key: found.thumbS3Key },
            'photo thumb upload failed — сбрасываем thumb_s3_key',
          );
        }
      }

      // Финал одной транзакцией: разрыв между uploaded_at и updatedAt родителя
      // означал бы, что повторный запрос закоротится по заполненному uploaded_at,
      // а delta-sync это фото уже никогда не отдаст на планшет.
      const now = new Date();
      const outcome = await app.db.transaction(async (tx) => {
        const [parentNow] = await tx
          .select({ pendingDeletionAt: parentTable.pendingDeletionAt })
          .from(parentTable)
          .where(eq(parentTable.id, found.operationId))
          .limit(1);
        // Пометить на удаление могли, пока шёл PUT в S3.
        if (parentNow?.pendingDeletionAt != null) return 'pending_deletion' as const;

        const updated = await tx
          .update(table)
          .set({ uploadedAt: now, ...(thumbStored ? {} : { thumbS3Key: null }) })
          .where(and(eq(table.id, req.params.id), isNull(table.uploadedAt)))
          .returning({ id: table.id });
        if (updated.length === 0) return 'no_rows' as const;

        await tx
          .update(parentTable)
          .set({ updatedAt: now })
          .where(eq(parentTable.id, found.operationId));
        return 'ok' as const;
      });

      if (outcome === 'ok') {
        TABLES[found.kind].publishUpdated(app, found.operationId);
        return { ok: true as const, uploadedAt: now.toISOString() };
      }

      // Ноль обновлённых строк сам по себе НЕ означает «запись удалили»: ровно
      // так же выглядит выигранная гонка параллельного POST. Удалять объекты по
      // одному этому признаку нельзя — остались бы подтверждённые фото без файла.
      const [after] = await app.db
        .select({ uploadedAt: table.uploadedAt })
        .from(table)
        .where(eq(table.id, req.params.id))
        .limit(1);
      if (outcome === 'no_rows' && after?.uploadedAt) {
        // Конкурент успел раньше и записал те же байты — отдаём его результат.
        return { ok: true as const, uploadedAt: after.uploadedAt.toISOString() };
      }
      // Запись исчезла или родителя пометили на удаление — только что записанные
      // объекты осиротели, подчищаем best-effort.
      if (!after || outcome === 'pending_deletion') {
        for (const key of writtenKeys) {
          await deleteObject(key).catch((err: unknown) =>
            req.log.warn({ err, key }, 'cleanup after failed photo upload'),
          );
        }
        if (outcome === 'pending_deletion') {
          return reply.code(409).send({
            error: 'pending_deletion',
            message: 'Документ помечен на удаление — мутации фото запрещены',
          });
        }
        return reply.code(404).send({ error: 'not_found' });
      }
      // Строка на месте и всё ещё не подтверждена — записать не удалось.
      req.log.warn({ photoId: req.params.id }, 'photo content upload: update affected no rows');
      return reply
        .code(503)
        .send({ error: 'not_confirmed', message: 'Не удалось подтвердить загрузку, повторите' });
    },
  );

  // Confirm: клиент вызывает после успешного PUT в S3 — сервер проверяет
  // S3.HEAD и проставляет uploaded_at = now(). Cleanup-job не тронет
  // подтверждённые записи. Idempotent: повторный вызов возвращает прежний
  // uploaded_at без новой проверки S3 (по существующему значению).
  app.post(
    '/api/v1/photos/:id/confirm',
    {
      // contractor/monitor — read-only роли (симметрично presign).
      preHandler: [app.authenticate, app.authorize('admin', 'manager', 'inspector_kpp')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: PhotoConfirmResponseSchema,
          // 403 — foreign_site (чужой объект): тот же контракт, что у presign,
          // иначе клиент не отличает «нельзя» от «нет такого фото».
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const found = await findPhoto(app, req.params.id);
      if (!found) return reply.code(404).send({ error: 'not_found' });
      // Скоуп и коды — как в presign: только объект, автор не проверяется
      // (несколько аккаунтов одного объекта работают как один). Раньше здесь
      // был 404 на чужой объект, затем 404 сменился на 403 и добавился
      // owner-check — он и ломал передачу Этапа 2 между сменами.
      if (
        req.user?.role === 'inspector_kpp' &&
        (!req.user.siteId || found.parentSiteId !== req.user.siteId)
      ) {
        await app.logUnauthorized(req, 403, 'photo_foreign_site', req.user.id);
        return reply.code(403).send(FOREIGN_SITE_RESPONSE);
      }

      // Матрица прав — после проверки объекта выше. Подтверждение загрузки —
      // часть создания фото, поэтому право то же, что у presign.
      await assertPermission(req, pageOfKind(found.kind), 'create');

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
      // Фото стало реальным (uploaded_at проставлен) — бампаем updatedAt
      // родителя, чтобы delta-sync отдал приёмку/отгрузку с этим фото на
      // мобилу, и будим клиента SSE-событием (раньше confirm их не слал).
      await touchPhotoParent(app, found.kind, found.operationId);
      TABLES[found.kind].publishUpdated(app, found.operationId);
      return { ok: true as const, uploadedAt: now.toISOString() };
    },
  );

  app.delete(
    '/api/v1/photos/:id',
    {
      // admin + manager: оба могут редактировать приёмки/отгрузки и
      // привязывать УПД; удаление отдельного фото — естественная часть
      // этих прав. Inspector_kpp не правит чужие фото с веба; на мобиле
      // он удаляет/переснимает через свой UI. pendingDeletionAt-check
      // ниже сохраняет иммутабельность фото у документов, помеченных
      // на удаление.
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
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

      await assertPermission(req, pageOfKind(found.kind), 'delete');

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
      await touchPhotoParent(app, found.kind, found.operationId);
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

      await assertPermission(req, pageOfKind(found.kind), 'edit');

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
      await touchPhotoParent(app, found.kind, found.operationId);
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
      if (
        req.user?.role === 'contractor' &&
        !(await photoVisibleToContractor(app, found, req.user))
      ) {
        return reply.code(404).send({ error: 'not_found' });
      }
      // См. комментарий о порядке в GET /api/v1/photos/:id/url.
      await assertPermission(req, pageOfKind(found.kind), 'view');
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

      await assertPermission(req, pageOfKind(found.kind), 'edit');

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

/**
 * Вид операции → страница матрицы прав. Отдельного права на фото нет:
 * выбранная гранулярность — «разделы и вкладки», поэтому фото приёмки
 * управляются правами страницы «Приёмки», фото отгрузки — «Отгрузки».
 */
function pageOfKind(kind: OperationKind): 'operations.deliveries' | 'operations.shipments' {
  return kind === 'shipment' ? 'operations.shipments' : 'operations.deliveries';
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
      // Получатель родительской отгрузки (для скоупа роли contractor у
      // shipment-фото). Для delivery-фото всегда null — видимость приёмки
      // проверяется через deliveryVisibleToContractor по operationId.
      parentReceiverCounterpartyId: string | null;
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
      parentReceiverCounterpartyId: null,
    };

  const [s] = await app.db
    .select({
      s3Key: shipmentPhotos.s3Key,
      thumbS3Key: shipmentPhotos.thumbS3Key,
      operationId: shipmentPhotos.shipmentId,
      parentSiteId: shipments.siteId,
      parentReceiverCounterpartyId: shipments.receiverCounterpartyId,
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
      parentReceiverCounterpartyId: s.parentReceiverCounterpartyId,
    };

  return null;
}

// Видимо ли фото роли contractor: для delivery-фото — через видимость приёмки
// (с наследованием подрядчика от УПД), для shipment-фото — по получателю
// отгрузки. Вызывать только когда req.user.role === 'contractor'.
async function photoVisibleToContractor(
  app: FastifyInstance,
  found: NonNullable<Awaited<ReturnType<typeof findPhoto>>>,
  user: AuthUser,
): Promise<boolean> {
  const opIds = await resolveContractorOpIds(app, user);
  if (!opIds || opIds.length === 0) return false;
  if (found.kind === 'delivery') {
    return deliveryVisibleToContractor(app, found.operationId, opIds);
  }
  return (
    !!found.parentReceiverCounterpartyId &&
    opIds.includes(found.parentReceiverCounterpartyId)
  );
}
