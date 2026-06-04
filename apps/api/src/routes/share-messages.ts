import type { FastifyInstance } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import {
  ErrorResponseSchema,
  ShareMessageThreadDetailResponseSchema,
  ShareMessageThreadListResponseSchema,
  ShareMessageUnreadCountResponseSchema,
  ManagerShareMessageCreateRequestSchema,
  ManagerShareMessageCreateResponseSchema,
} from '@matcheck/contracts';
import {
  deliveries,
  shareMessages,
  shareTokens,
  shipments,
  sourceDocuments,
  users,
} from '../db/schema.js';

/**
 * Защищённые endpoint'ы для менеджера-автора share-ссылки: список тредов,
 * детали треда, ответ внешнему пользователю, mark-read. Авторизация —
 * `share_tokens.created_by_user_id = req.user.id` (admin может видеть всё
 * через ту же логику в проверке).
 *
 * Публичная сторона (внешний пользователь без логина) лежит в share.ts.
 */
export async function shareMessageRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);

  // Командная модель: любой admin/manager видит все треды и может отвечать
  // — ссылки и переписки принадлежат «компании», а не конкретному автору.
  // Это совпадает с поведением revoke в share.ts.
  async function findTokenForManager(
    tokenId: string,
  ): Promise<typeof shareTokens.$inferSelect | null> {
    const [row] = await app.db
      .select()
      .from(shareTokens)
      .where(eq(shareTokens.id, tokenId))
      .limit(1);
    return row ?? null;
  }

  // Имя отправителя для manager-сообщений: ФИО, иначе email. На клиенте
  // тот же fallback в `inspectorName` — единая логика отображения.
  function managerDisplayName(u: { fullName: string | null; email: string }): string {
    return u.fullName?.trim() || u.email;
  }

  app.get(
    '/api/v1/share-messages/unread-count',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: { response: { 200: ShareMessageUnreadCountResponseSchema } },
    },
    async () => {
      // Любой manager/admin видит общий счётчик непрочитанных от внешних
      // пользователей — командная модель, см. findTokenForManager выше.
      const [row] = await app.db
        .select({ count: sql<number>`count(*)::int` })
        .from(shareMessages)
        .innerJoin(shareTokens, eq(shareTokens.id, shareMessages.shareTokenId))
        .where(
          and(
            eq(shareMessages.isRead, false),
            eq(shareMessages.senderType, 'external'),
          ),
        );
      return { count: Number(row?.count ?? 0) };
    },
  );

  app.get(
    '/api/v1/share-messages/threads',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: { response: { 200: ShareMessageThreadListResponseSchema } },
    },
    async () => {
      // Командная модель: manager/admin видят все треды, обогащаем
      // entity-label из deliveries/shipments. Используем сырые SQL для
      // агрегации по треду — компактнее, чем CTE.
      const rowsRaw = await app.db.execute(sql`
        WITH last_msgs AS (
          SELECT
            sm.share_token_id,
            sm.id AS msg_id,
            sm.body,
            sm.sender_type,
            sm.sender_name,
            sm.sender_user_id,
            sm.created_at,
            ROW_NUMBER() OVER (
              PARTITION BY sm.share_token_id
              ORDER BY sm.created_at DESC
            ) AS rn
          FROM share_messages sm
        ),
        unread_counts AS (
          SELECT share_token_id, COUNT(*)::int AS cnt
          FROM share_messages
          WHERE is_read = false AND sender_type = 'external'
          GROUP BY share_token_id
        )
        SELECT
          st.id              AS "tokenId",
          st.entity_type     AS "entityType",
          st.entity_id       AS "entityId",
          st.expires_at      AS "expiresAt",
          st.revoked_at      AS "revokedAt",
          lm.body            AS "lastBody",
          lm.sender_type     AS "lastSenderType",
          lm.sender_name     AS "lastSenderName",
          lm.created_at      AS "lastMessageAt",
          COALESCE(u.full_name, u.email) AS "lastManagerName",
          COALESCE(uc.cnt, 0)::int AS "unreadCount",
          d.vehicle_plate    AS "deliveryPlate",
          sd1.doc_number     AS "deliveryDocNumber",
          sh.vehicle_plate   AS "shipmentPlate",
          sd2.doc_number     AS "shipmentDocNumber"
        FROM share_tokens st
        INNER JOIN last_msgs lm ON lm.share_token_id = st.id AND lm.rn = 1
        LEFT JOIN unread_counts uc ON uc.share_token_id = st.id
        LEFT JOIN users u ON u.id = lm.sender_user_id
        LEFT JOIN deliveries d ON st.entity_type = 'delivery' AND d.id = st.entity_id
        LEFT JOIN LATERAL (
          SELECT sdoc.doc_number
          FROM delivery_sources ds
          JOIN source_documents sdoc ON sdoc.id = ds.source_document_id
          WHERE ds.delivery_id = st.entity_id
          ORDER BY sdoc.doc_date DESC NULLS LAST
          LIMIT 1
        ) sd1 ON st.entity_type = 'delivery'
        LEFT JOIN shipments sh ON st.entity_type = 'shipment' AND sh.id = st.entity_id
        LEFT JOIN LATERAL (
          SELECT sdoc.doc_number
          FROM shipment_sources ss
          JOIN source_documents sdoc ON sdoc.id = ss.source_document_id
          WHERE ss.shipment_id = st.entity_id
          ORDER BY sdoc.doc_date DESC NULLS LAST
          LIMIT 1
        ) sd2 ON st.entity_type = 'shipment'
        ORDER BY (COALESCE(uc.cnt, 0) > 0) DESC, lm.created_at DESC
        LIMIT 100
      `);
      // postgres-js драйвер возвращает массив напрямую, а node-postgres —
      // объект { rows: [...] }. Делаем fallback на «сам массив», иначе
      // тредов не видно даже когда в БД сообщения есть.
      const rows =
        (rowsRaw as { rows?: Record<string, unknown>[] }).rows ??
        (rowsRaw as unknown as Record<string, unknown>[]);
      const items = rows.map((r) => {
        const entityType = String(r.entityType) as 'delivery' | 'shipment';
        const docNumber =
          entityType === 'delivery' ? r.deliveryDocNumber : r.shipmentDocNumber;
        const plate =
          entityType === 'delivery' ? r.deliveryPlate : r.shipmentPlate;
        // Лейбл: «Приёмка УПД №1796» / «Отгрузка авто P563РК97» / fallback.
        const label = docNumber
          ? `${entityType === 'delivery' ? 'Приёмка' : 'Отгрузка'} УПД №${docNumber}`
          : plate
            ? `${entityType === 'delivery' ? 'Приёмка' : 'Отгрузка'} авто ${plate}`
            : `${entityType === 'delivery' ? 'Приёмка' : 'Отгрузка'} ${String(r.tokenId).slice(0, 8)}`;
        const lastSenderType = String(r.lastSenderType) as 'external' | 'manager';
        const lastSenderName =
          lastSenderType === 'manager'
            ? (r.lastManagerName as string | null) ?? 'Менеджер'
            : (r.lastSenderName as string | null) ?? '—';
        const body = String(r.lastBody ?? '');
        const preview = body.length > 80 ? body.slice(0, 80) + '…' : body;
        const revokedAt = r.revokedAt ? new Date(r.revokedAt as Date).toISOString() : null;
        return {
          tokenId: String(r.tokenId),
          entityType,
          entityId: String(r.entityId),
          entityLabel: label,
          lastMessageAt: new Date(r.lastMessageAt as Date).toISOString(),
          lastSenderName,
          lastBodyPreview: preview,
          unreadCount: Number(r.unreadCount),
          tokenRevokedAt: revokedAt,
          tokenExpiresAt: new Date(r.expiresAt as Date).toISOString(),
        };
      });
      return { items };
    },
  );

  app.get(
    '/api/v1/share-messages/threads/:tokenId',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ tokenId: z.string().uuid() }),
        response: {
          200: ShareMessageThreadDetailResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const token = await findTokenForManager(req.params.tokenId);
      if (!token) return reply.code(404).send({ error: 'not_found' });

      const messages = await app.db
        .select({
          m: shareMessages,
          uName: users.fullName,
          uEmail: users.email,
        })
        .from(shareMessages)
        .leftJoin(users, eq(users.id, shareMessages.senderUserId))
        .where(eq(shareMessages.shareTokenId, token.id))
        .orderBy(shareMessages.createdAt);

      // entityLabel — переиспользуем ту же логику что в /threads. Тут проще
      // отдельным запросом, потому что один тред.
      let entityLabel = `${token.entityType === 'delivery' ? 'Приёмка' : 'Отгрузка'} ${token.id.slice(0, 8)}`;
      if (token.entityType === 'delivery') {
        const [d] = await app.db
          .select({ plate: deliveries.vehiclePlate })
          .from(deliveries)
          .where(eq(deliveries.id, token.entityId))
          .limit(1);
        const sdRaw = await app.db.execute(sql`
          SELECT sdoc.doc_number AS "docNumber"
          FROM delivery_sources ds
          JOIN source_documents sdoc ON sdoc.id = ds.source_document_id
          WHERE ds.delivery_id = ${token.entityId}
          ORDER BY sdoc.doc_date DESC NULLS LAST
          LIMIT 1
        `);
        const sdArr =
          (sdRaw as { rows?: Array<{ docNumber: string | null }> }).rows ??
          (sdRaw as unknown as Array<{ docNumber: string | null }>);
        const docNumber = sdArr[0]?.docNumber;
        if (docNumber) entityLabel = `Приёмка УПД №${docNumber}`;
        else if (d?.plate) entityLabel = `Приёмка авто ${d.plate}`;
      } else {
        const [s] = await app.db
          .select({ plate: shipments.vehiclePlate })
          .from(shipments)
          .where(eq(shipments.id, token.entityId))
          .limit(1);
        const sdRaw = await app.db.execute(sql`
          SELECT sdoc.doc_number AS "docNumber"
          FROM shipment_sources ss
          JOIN source_documents sdoc ON sdoc.id = ss.source_document_id
          WHERE ss.shipment_id = ${token.entityId}
          ORDER BY sdoc.doc_date DESC NULLS LAST
          LIMIT 1
        `);
        const sdArr =
          (sdRaw as { rows?: Array<{ docNumber: string | null }> }).rows ??
          (sdRaw as unknown as Array<{ docNumber: string | null }>);
        const docNumber = sdArr[0]?.docNumber;
        if (docNumber) entityLabel = `Отгрузка УПД №${docNumber}`;
        else if (s?.plate) entityLabel = `Отгрузка авто ${s.plate}`;
      }

      // Превью последнего сообщения для самого треда
      const last = messages[messages.length - 1];
      const lastBody = last?.m.body ?? '';
      const lastSender =
        last?.m.senderType === 'manager'
          ? last.uName?.trim() || last.uEmail || 'Менеджер'
          : last?.m.senderName ?? '—';
      const unreadCount = messages.filter(
        (x) => x.m.senderType === 'external' && !x.m.isRead,
      ).length;

      // suppress unused-import warnings for tables only referenced via sql template
      void sourceDocuments;

      return {
        thread: {
          tokenId: token.id,
          entityType: token.entityType as 'delivery' | 'shipment',
          entityId: token.entityId,
          entityLabel,
          lastMessageAt: (last?.m.createdAt ?? token.createdAt).toISOString(),
          lastSenderName: lastSender,
          lastBodyPreview: lastBody.length > 80 ? lastBody.slice(0, 80) + '…' : lastBody,
          unreadCount,
          tokenRevokedAt: token.revokedAt ? token.revokedAt.toISOString() : null,
          tokenExpiresAt: token.expiresAt.toISOString(),
        },
        messages: messages.map(({ m, uName, uEmail }) => ({
          id: m.id,
          senderType: m.senderType as 'external' | 'manager',
          senderName:
            m.senderType === 'manager'
              ? (uName?.trim() || uEmail || 'Менеджер')
              : m.senderName,
          // Email во внутренней выдаче возвращаем — менеджеру полезно
          // (для копирования и фолоуапа). На публичной части — null.
          senderEmail:
            m.senderType === 'external'
              ? m.senderEmail
              : (uEmail as string | null) ?? null,
          body: m.body,
          createdAt: m.createdAt.toISOString(),
          isRead: m.isRead,
        })),
      };
    },
  );

  app.post(
    '/api/v1/share-messages/threads/:tokenId',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ tokenId: z.string().uuid() }),
        body: ManagerShareMessageCreateRequestSchema,
        response: {
          200: ManagerShareMessageCreateResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const token = await findTokenForManager(req.params.tokenId);
      if (!token) return reply.code(404).send({ error: 'not_found' });
      const me = req.user!.id;

      const [u] = await app.db
        .select({ fullName: users.fullName, email: users.email })
        .from(users)
        .where(eq(users.id, me))
        .limit(1);

      // Транзакция: вставка ответа + mark-read всех external предыдущих.
      // Открытие чата = факт прочтения.
      const created = await app.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(shareMessages)
          .values({
            shareTokenId: token.id,
            senderType: 'manager',
            senderUserId: me,
            senderName: null,
            senderEmail: null,
            body: req.body.body.trim(),
            isRead: true,
          })
          .returning();
        if (!row) throw new Error('Failed to insert manager message');
        await tx
          .update(shareMessages)
          .set({ isRead: true })
          .where(
            and(
              eq(shareMessages.shareTokenId, token.id),
              eq(shareMessages.senderType, 'external'),
              eq(shareMessages.isRead, false),
            ),
          );
        return row;
      });

      return {
        message: {
          id: created.id,
          senderType: 'manager' as const,
          senderName: u ? managerDisplayName(u) : 'Менеджер',
          senderEmail: u?.email ?? null,
          body: created.body,
          createdAt: created.createdAt.toISOString(),
          isRead: created.isRead,
        },
      };
    },
  );

  app.post(
    '/api/v1/share-messages/threads/:tokenId/mark-read',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ tokenId: z.string().uuid() }),
        response: { 200: z.object({ ok: z.literal(true) }), 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const token = await findTokenForManager(req.params.tokenId);
      if (!token) return reply.code(404).send({ error: 'not_found' });
      await app.db
        .update(shareMessages)
        .set({ isRead: true })
        .where(
          and(
            eq(shareMessages.shareTokenId, token.id),
            eq(shareMessages.senderType, 'external'),
            eq(shareMessages.isRead, false),
          ),
        );
      return { ok: true as const };
    },
  );

  // suppress unused-import for desc — может пригодиться при расширении
  void desc;
}
