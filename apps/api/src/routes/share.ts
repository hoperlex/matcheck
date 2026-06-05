import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import {
  ShareLinkSchema,
  ShareLinkListResponseSchema,
  PublicSharedShipmentSchema,
  PublicSharedEntitySchema,
  PublicShareMessageListResponseSchema,
  PublicShareMessageCreateRequestSchema,
  PublicShareMessageCreateResponseSchema,
  ErrorResponseSchema,
} from '@matcheck/contracts';
import {
  counterparties,
  deliveries,
  deliveryItems,
  deliveryPhotos,
  deliverySources,
  responsiblePersons,
  shareMessages,
  shareTokens,
  shipments,
  shipmentItems,
  shipmentPhotos,
  sites,
  sourceDocuments,
  statuses,
} from '../db/schema.js';
import { getObject } from '../domain/storage/s3.signer.js';

const TTL_DAYS = 10;
const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;

function newToken(): string {
  // 16 байт = 128 бит энтропии (астрономически сложно перебрать через
  // brute-force). base64url даёт 22 символа без padding — в 3 раза короче
  // прежнего 64-символьного hex. Старые длинные токены остаются валидны
  // до истечения TTL — схема валидации min(20).max(64) принимает оба.
  return randomBytes(16).toString('base64url');
}

function publicBaseUrl(): string {
  // Базовый URL для построения ссылки. В проде стоит передавать через env,
  // в dev/staging fallback — request.protocol/host (см. использование).
  return process.env.PUBLIC_BASE_URL ?? '';
}

function buildShareUrl(req: { protocol: string; hostname: string }, token: string): string {
  const base = publicBaseUrl();
  if (base) return `${base.replace(/\/$/, '')}/share/${token}`;
  return `${req.protocol}://${req.hostname}/share/${token}`;
}

function rowToShareLink(
  r: typeof shareTokens.$inferSelect,
  url: string,
): z.infer<typeof ShareLinkSchema> {
  return {
    id: r.id,
    entityType: r.entityType as 'delivery' | 'shipment',
    entityId: r.entityId,
    token: r.token,
    url,
    createdByUserId: r.createdByUserId,
    expiresAt: r.expiresAt.toISOString(),
    revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
    accessedCount: r.accessedCount,
    lastAccessedAt: r.lastAccessedAt ? r.lastAccessedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function shareRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);

  // ─── Auth: создание / получение / отзыв ссылок ───────────────────────────

  // POST /deliveries/:id/share-link → создаёт или переиспользует активную.
  // Идемпотентно: повторный клик «Поделиться» не плодит токены, отдаёт
  // тот же активный (если есть). Так UX «копирую ссылку дважды» не создаёт
  // двух токенов с одинаковым доступом, которые потом надо обоих отзывать.
  const CreateForDeliverySchema = z.object({ id: z.string().uuid() });

  async function createOrReuse(
    entityType: 'delivery' | 'shipment',
    entityId: string,
    userId: string,
    req: { protocol: string; hostname: string },
  ): Promise<z.infer<typeof ShareLinkSchema>> {
    const now = new Date();
    const [active] = await app.db
      .select()
      .from(shareTokens)
      .where(
        and(
          eq(shareTokens.entityType, entityType),
          eq(shareTokens.entityId, entityId),
          isNull(shareTokens.revokedAt),
          gt(shareTokens.expiresAt, now),
        ),
      )
      .orderBy(desc(shareTokens.createdAt))
      .limit(1);
    if (active) return rowToShareLink(active, buildShareUrl(req, active.token));

    const token = newToken();
    const expiresAt = new Date(now.getTime() + TTL_MS);
    const [created] = await app.db
      .insert(shareTokens)
      .values({
        entityType,
        entityId,
        token,
        createdByUserId: userId,
        expiresAt,
      })
      .returning();
    if (!created) throw new Error('share-token insert failed');
    return rowToShareLink(created, buildShareUrl(req, created.token));
  }

  app.post(
    '/api/v1/deliveries/:id/share-link',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager', 'inspector_kpp')],
      schema: {
        params: CreateForDeliverySchema,
        response: { 200: ShareLinkSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const [d] = await app.db
        .select({ id: deliveries.id, siteId: deliveries.siteId })
        .from(deliveries)
        .where(eq(deliveries.id, req.params.id))
        .limit(1);
      if (!d) return reply.code(404).send({ error: 'not_found' });
      const user = req.user!;
      // inspector_kpp может шарить только приёмки своего объекта.
      if (user.role === 'inspector_kpp' && d.siteId !== user.siteId) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return createOrReuse('delivery', d.id, user.id, req);
    },
  );

  app.post(
    '/api/v1/shipments/:id/share-link',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager', 'inspector_kpp')],
      schema: {
        params: CreateForDeliverySchema,
        response: { 200: ShareLinkSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const [s] = await app.db
        .select({ id: shipments.id, siteId: shipments.siteId })
        .from(shipments)
        .where(eq(shipments.id, req.params.id))
        .limit(1);
      if (!s) return reply.code(404).send({ error: 'not_found' });
      const user = req.user!;
      if (user.role === 'inspector_kpp' && s.siteId !== user.siteId) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return createOrReuse('shipment', s.id, user.id, req);
    },
  );

  // GET список активных ссылок для конкретной сущности (для UI «вижу ли
  // я уже свои ссылки и их статистику»).
  const ListQuerySchema = z.object({
    entityType: z.enum(['delivery', 'shipment']),
    entityId: z.string().uuid(),
  });
  app.get(
    '/api/v1/share-links',
    {
      preHandler: [app.authenticate],
      schema: {
        querystring: ListQuerySchema,
        response: { 200: ShareLinkListResponseSchema },
      },
    },
    async (req) => {
      const rows = await app.db
        .select()
        .from(shareTokens)
        .where(
          and(
            eq(shareTokens.entityType, req.query.entityType),
            eq(shareTokens.entityId, req.query.entityId),
          ),
        )
        .orderBy(desc(shareTokens.createdAt));
      return {
        items: rows.map((r) => rowToShareLink(r, buildShareUrl(req, r.token))),
      };
    },
  );

  // Отзыв ссылки — может любой admin или manager (командная модель: ссылки
  // принадлежат «компании», а не конкретному менеджеру; коллеги должны мочь
  // прибрать чужие ссылки, например при увольнении автора или просто чтобы
  // прервать утечку). Inspector_kpp — нет, защита от случайных кликов.
  app.post(
    '/api/v1/share-links/:id/revoke',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: ShareLinkSchema, 403: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const [existing] = await app.db
        .select()
        .from(shareTokens)
        .where(eq(shareTokens.id, req.params.id))
        .limit(1);
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      const [upd] = await app.db
        .update(shareTokens)
        .set({ revokedAt: new Date() })
        .where(eq(shareTokens.id, req.params.id))
        .returning();
      if (!upd) return reply.code(404).send({ error: 'not_found' });
      return rowToShareLink(upd, buildShareUrl(req, upd.token));
    },
  );

  // ─── Public: чтение по токену ────────────────────────────────────────────

  // Все public endpoints — без preHandler authenticate. Доступ по знанию
  // unguessable токена. Проверки: токен существует, не revoked, не истёк.
  async function findActiveToken(token: string): Promise<typeof shareTokens.$inferSelect | null> {
    const [t] = await app.db
      .select()
      .from(shareTokens)
      .where(eq(shareTokens.token, token))
      .limit(1);
    if (!t) return null;
    if (t.revokedAt) return null;
    if (t.expiresAt.getTime() <= Date.now()) return null;
    return t;
  }

  async function bumpAccessCounter(
    tokenRow: typeof shareTokens.$inferSelect,
    req: { ip?: string; headers?: Record<string, unknown> },
  ) {
    await app.db
      .update(shareTokens)
      .set({
        accessedCount: tokenRow.accessedCount + 1,
        lastAccessedAt: new Date(),
        lastAccessedIp: req.ip ?? null,
        lastAccessedUserAgent: (req.headers?.['user-agent'] as string | undefined) ?? null,
      })
      .where(eq(shareTokens.id, tokenRow.id));
  }

  app.get(
    '/api/v1/share/:token',
    {
      schema: {
        params: z.object({ token: z.string().min(20).max(64) }),
        response: { 200: PublicSharedEntitySchema, 404: ErrorResponseSchema, 410: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const t = await findActiveToken(req.params.token);
      if (!t) return reply.code(410).send({ error: 'link_expired_or_revoked' });

      if (t.entityType === 'delivery') {
        const supplier = alias(counterparties, 'supplier');
        const contractor = alias(counterparties, 'contractor');
        const [row] = await app.db
          .select({
            d: deliveries,
            statusCode: statuses.code,
            statusLabel: statuses.label,
            supplierName: supplier.name,
            contractorName: contractor.name,
            molName: responsiblePersons.fullName,
            siteName: sites.name,
          })
          .from(deliveries)
          .innerJoin(statuses, eq(deliveries.statusId, statuses.id))
          .leftJoin(supplier, eq(deliveries.supplierId, supplier.id))
          .leftJoin(contractor, eq(deliveries.contractorId, contractor.id))
          .leftJoin(
            responsiblePersons,
            eq(deliveries.recipientMolId, responsiblePersons.id),
          )
          .leftJoin(sites, eq(deliveries.siteId, sites.id))
          .where(eq(deliveries.id, t.entityId))
          .limit(1);
        if (!row) return reply.code(404).send({ error: 'not_found' });

        // Привязанный документ (УПД/Накладная) — для отображения № и даты.
        // Связь через delivery_sources (multi-to-multi). Берём первый.
        const sdLinks = await app.db
          .select({ sourceDocumentId: deliverySources.sourceDocumentId })
          .from(deliverySources)
          .where(eq(deliverySources.deliveryId, t.entityId))
          .limit(1);
        const firstSdId = sdLinks[0]?.sourceDocumentId ?? null;
        const [firstSd] = firstSdId
          ? await app.db
              .select({
                docNumber: sourceDocuments.docNumber,
                docDate: sourceDocuments.docDate,
                expectedDate: sourceDocuments.expectedDate,
              })
              .from(sourceDocuments)
              .where(eq(sourceDocuments.id, firstSdId))
              .limit(1)
          : [];

        const items = await app.db
          .select()
          .from(deliveryItems)
          .where(eq(deliveryItems.deliveryId, t.entityId))
          .orderBy(deliveryItems.lineNo);
        const photos = await app.db
          .select()
          .from(deliveryPhotos)
          .where(eq(deliveryPhotos.deliveryId, t.entityId))
          .orderBy(deliveryPhotos.takenAt);

        void bumpAccessCounter(t, req);

        const baseUrl = `/api/v1/share/${t.token}/photos`;
        return {
          entityType: 'delivery' as const,
          id: row.d.id,
          status: { code: row.statusCode, label: row.statusLabel },
          siteName: row.siteName,
          supplierName: row.supplierName,
          contractorName: row.contractorName,
          recipientMolName: row.molName,
          vehiclePlate: row.d.vehiclePlate,
          driverName: row.d.driverName,
          arrivedAt: row.d.arrivedAt ? row.d.arrivedAt.toISOString() : null,
          comment: row.d.comment,
          docNumber: firstSd?.docNumber ?? null,
          docDate: firstSd?.docDate ? firstSd.docDate.toISOString() : null,
          expectedDate: firstSd?.expectedDate ? firstSd.expectedDate.toISOString() : null,
          items: items.map((it) => ({
            lineNo: it.lineNo,
            nameRaw: it.nameRaw,
            unit: it.unit,
            qtyPlanned: it.qtyPlanned,
            qtyActual: it.qtyActual,
            price: it.price,
            vatRate: it.vatRate,
            vatSum: it.vatSum,
          })),
          photos: photos
            .filter((p) => p.uploadedAt !== null) // orphan-фото не показываем
            .map((p) => ({
              id: p.id,
              stage: p.stage,
              takenAt: p.takenAt.toISOString(),
              url: `${baseUrl}/${p.id}`,
              thumbUrl: `${baseUrl}/${p.id}/thumb`,
            })),
          shareExpiresAt: t.expiresAt.toISOString(),
        };
      }

      // entityType === 'shipment'
      // Получатель отгрузки — либо counterparty (контрагент/подрядчик),
      // либо МОЛ. Поля: receiverCounterpartyId, receiverMolId.
      const receiver = alias(counterparties, 'receiver');
      const [row] = await app.db
        .select({
          s: shipments,
          statusCode: statuses.code,
          statusLabel: statuses.label,
          receiverName: receiver.name,
          molName: responsiblePersons.fullName,
          siteName: sites.name,
        })
        .from(shipments)
        .innerJoin(statuses, eq(shipments.statusId, statuses.id))
        .leftJoin(receiver, eq(shipments.receiverCounterpartyId, receiver.id))
        .leftJoin(
          responsiblePersons,
          eq(shipments.receiverMolId, responsiblePersons.id),
        )
        .leftJoin(sites, eq(shipments.siteId, sites.id))
        .where(eq(shipments.id, t.entityId))
        .limit(1);
      if (!row) return reply.code(404).send({ error: 'not_found' });

      const items = await app.db
        .select()
        .from(shipmentItems)
        .where(eq(shipmentItems.shipmentId, t.entityId))
        .orderBy(shipmentItems.lineNo);
      const photos = await app.db
        .select()
        .from(shipmentPhotos)
        .where(eq(shipmentPhotos.shipmentId, t.entityId))
        .orderBy(shipmentPhotos.takenAt);

      void bumpAccessCounter(t, req);

      const baseUrl = `/api/v1/share/${t.token}/photos`;
      const out: z.infer<typeof PublicSharedShipmentSchema> = {
        entityType: 'shipment' as const,
        id: row.s.id,
        status: { code: row.statusCode, label: row.statusLabel },
        kind: row.s.kind,
        siteName: row.siteName,
        // У отгрузки нет отдельных supplier/contractor — есть один receiver
        // (либо counterparty, либо МОЛ). Рендерим как contractorName для
        // совместимости со схемой; supplierName всегда null.
        supplierName: null,
        contractorName: row.receiverName,
        recipientMolName: row.molName,
        vehiclePlate: row.s.vehiclePlate,
        driverName: row.s.driverName,
        shippedAt: row.s.shippedAt ? row.s.shippedAt.toISOString() : null,
        comment: row.s.comment,
        docNumber: null,
        docDate: null,
        items: items.map((it) => ({
          lineNo: it.lineNo,
          nameRaw: it.nameRaw,
          unit: it.unit,
          qtyPlanned: it.qtyPlanned,
          qtyActual: it.qtyActual,
          price: it.price,
          vatRate: it.vatRate,
          vatSum: it.vatSum,
        })),
        photos: photos
          .filter((p) => p.uploadedAt !== null)
          .map((p) => ({
            id: p.id,
            stage: p.stage,
            takenAt: p.takenAt.toISOString(),
            url: `${baseUrl}/${p.id}`,
            thumbUrl: `${baseUrl}/${p.id}/thumb`,
          })),
        shareExpiresAt: t.expiresAt.toISOString(),
      };
      return out;
    },
  );

  // Прокси-фото: сервер сам идёт в S3 (приватным IAM) и стримит байты.
  // S3-URL клиенту не виден ни в одном виде. URL для frontend:
  // /api/v1/share/{token}/photos/{photoId}[/thumb] — больше нигде не
  // светим этот шаблон, кроме как в `photos[].url` ответа GET /share/{token}.
  app.get(
    '/api/v1/share/:token/photos/:photoId',
    {
      schema: {
        params: z.object({
          token: z.string().min(20).max(64),
          photoId: z.string().uuid(),
        }),
        querystring: z.object({ thumb: z.coerce.boolean().optional() }),
      },
    },
    async (req, reply) => {
      const t = await findActiveToken(req.params.token);
      if (!t) return reply.code(410).send({ error: 'link_expired_or_revoked' });

      // Фото должно принадлежать той же сущности, что и токен. Иначе
      // владелец токена на одну приёмку мог бы вытащить фото другой
      // приёмки, зная только photoId.
      let s3Key: string | null = null;
      let thumbKey: string | null = null;
      if (t.entityType === 'delivery') {
        const [p] = await app.db
          .select({ s3Key: deliveryPhotos.s3Key, thumbS3Key: deliveryPhotos.thumbS3Key })
          .from(deliveryPhotos)
          .where(
            and(
              eq(deliveryPhotos.id, req.params.photoId),
              eq(deliveryPhotos.deliveryId, t.entityId),
            ),
          )
          .limit(1);
        if (p) {
          s3Key = p.s3Key;
          thumbKey = p.thumbS3Key;
        }
      } else {
        const [p] = await app.db
          .select({ s3Key: shipmentPhotos.s3Key, thumbS3Key: shipmentPhotos.thumbS3Key })
          .from(shipmentPhotos)
          .where(
            and(
              eq(shipmentPhotos.id, req.params.photoId),
              eq(shipmentPhotos.shipmentId, t.entityId),
            ),
          )
          .limit(1);
        if (p) {
          s3Key = p.s3Key;
          thumbKey = p.thumbS3Key;
        }
      }
      if (!s3Key) return reply.code(404).send({ error: 'not_found' });

      const url = new URL(req.url, `http://${req.hostname}`);
      const wantsThumb = url.pathname.endsWith('/thumb') || url.searchParams.get('thumb') === 'true';
      const keyToFetch = wantsThumb ? thumbKey ?? s3Key : s3Key;

      try {
        const buf = await getObject(keyToFetch);
        // Полагаемся на расширение ключа для Content-Type (фото у нас — image/jpeg).
        const ct = keyToFetch.toLowerCase().endsWith('.png')
          ? 'image/png'
          : keyToFetch.toLowerCase().endsWith('.webp')
            ? 'image/webp'
            : 'image/jpeg';
        return reply
          .header('Content-Type', ct)
          // Кеш на 5 минут — токен живёт долго, фото неизменяемое.
          // private — потому что доступно только по знанию токена.
          .header('Cache-Control', 'private, max-age=300')
          .send(buf);
      } catch (err) {
        req.log.warn({ err, key: keyToFetch }, 'share: failed to fetch photo from s3');
        return reply.code(502).send({ error: 's3_fetch_failed' });
      }
    },
  );

  // Альтернативный path для thumb (на случай если фронт собирает URL
  // с /thumb суффиксом, без query-параметра).
  app.get(
    '/api/v1/share/:token/photos/:photoId/thumb',
    {
      schema: {
        params: z.object({
          token: z.string().min(20).max(64),
          photoId: z.string().uuid(),
        }),
      },
    },
    async (req, reply) => {
      // Делегируем основному handler-у через query-параметр.
      const url = `/api/v1/share/${req.params.token}/photos/${req.params.photoId}?thumb=true`;
      const res = await app.inject({ method: 'GET', url });
      return reply
        .code(res.statusCode)
        .headers(res.headers as Record<string, string>)
        .send(res.rawPayload);
    },
  );

  // ─── Public: чат с менеджером ───────────────────────────────────────────
  //
  // Без preHandler authenticate — доступ по знанию токена. В выдаче никогда
  // не светится senderEmail (даже для external — это поле для менеджера в
  // защищённой части). bumpAccessCounter не делаем — это не «открытие
  // ссылки», а внутренняя сетевая активность чата.

  app.get(
    '/api/v1/share/:token/messages',
    {
      schema: {
        params: z.object({ token: z.string().min(20).max(64) }),
        response: {
          200: PublicShareMessageListResponseSchema,
          410: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const t = await findActiveToken(req.params.token);
      if (!t) return reply.code(410).send({ error: 'gone', message: 'Ссылка недоступна' });
      const rows = await app.db
        .select()
        .from(shareMessages)
        .where(eq(shareMessages.shareTokenId, t.id))
        .orderBy(shareMessages.createdAt);
      return {
        items: rows.map((m) => ({
          id: m.id,
          senderType: m.senderType as 'external' | 'manager',
          senderName: m.senderName,
          // Email внешним пользователям не отдаём (это пишет тот же человек,
          // ничего нового он не узнает; для менеджеров мы тут не светим
          // их email тоже — на публичной странице это лишний канал утечки).
          senderEmail: null,
          body: m.body,
          createdAt: m.createdAt.toISOString(),
          isRead: m.isRead,
        })),
      };
    },
  );

  app.post(
    '/api/v1/share/:token/messages',
    {
      // Защита от спама: 5 сообщений в минуту на IP. @fastify/rate-limit
      // зарегистрирован глобально в plugins/security.ts.
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        params: z.object({ token: z.string().min(20).max(64) }),
        body: PublicShareMessageCreateRequestSchema,
        response: {
          200: PublicShareMessageCreateResponseSchema,
          410: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const t = await findActiveToken(req.params.token);
      if (!t) return reply.code(410).send({ error: 'gone', message: 'Ссылка недоступна' });
      const [created] = await app.db
        .insert(shareMessages)
        .values({
          shareTokenId: t.id,
          senderType: 'external',
          senderUserId: null,
          senderName: req.body.senderName.trim(),
          // senderEmail в форме больше не запрашиваем — поле в БД
          // оставлено nullable для старых записей и на будущее.
          senderEmail: req.body.senderEmail?.trim() || null,
          body: req.body.body.trim(),
          isRead: false,
        })
        .returning();
      if (!created) throw new Error('Failed to insert share message');
      return {
        message: {
          id: created.id,
          senderType: 'external' as const,
          senderName: created.senderName,
          senderEmail: null, // см. комментарий выше — наружу не светим
          body: created.body,
          createdAt: created.createdAt.toISOString(),
          isRead: created.isRead,
        },
      };
    },
  );
}

