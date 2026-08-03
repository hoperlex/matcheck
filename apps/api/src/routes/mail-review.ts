// Экран «Разбор почты»: письма, не прошедшие автоматически.
//
// Сюда попадает то, что нельзя отправить на объект без человека: подрядчик не
// указал `Объект: КОД`, указал несколько разных кодов, ошибся в коде или тот же
// комплект файлов уже загружен на другую площадку. Письмо с ровно одним валидным
// явным маркером в этот список не приходит — оно становится документом само
// (см. domain/jobs/mail-poll.ts).
//
// Подтверждение переиспользует ту же сагу, что и автопроход
// (domain/mail/resolve-message.ts): отдельного «ручного» пути создания пакета
// нет, иначе два способа разошлись бы в идемпотентности.

import { Readable } from 'node:stream';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { simpleParser } from 'mailparser';
import { z } from 'zod';
import {
  ErrorResponseSchema,
  MailMessageBodySchema,
  MailMessageDetailSchema,
  MailMessageListResponseSchema,
  MailReceiptListResponseSchema,
  MailRejectRequestSchema,
  MailReplayResponseSchema,
  MailResolveRequestSchema,
  MailResolveResponseSchema,
  MailReviewFilterSchema,
  MailReviewSummarySchema,
} from '@matcheck/contracts';
import { mailAccounts, mailAttachments, mailMessages, mailReceipts, sites } from '../db/schema.js';
import { extractPlainText } from '../domain/mail/body-text.js';
import { REPLAYABLE_STATUSES, requestReplay } from '../domain/mail/replay.js';
import {
  INGESTABLE_ATTACHMENT_STATES,
  resolveMailMessage,
} from '../domain/mail/resolve-message.js';
import { copyObject, getObject, presign } from '../domain/storage/s3.signer.js';
import { asZod } from '../lib/fastify.js';

/** Статусы, ждущие человека. Остальные фильтры — для истории и разбора инцидентов. */
const PENDING_STATUSES = ['quarantined'] as const;

/**
 * Предел показа текста письма. Больше оператору не нужно: объект и дата стоят
 * в начале, а пересланная ветка на сотни килобайт только мешает.
 */
const MAIL_BODY_MAX_CHARS = 20_000;

type MessageRow = typeof mailMessages.$inferSelect;
type AttachmentRow = typeof mailAttachments.$inferSelect;

function attachmentDto(a: AttachmentRow) {
  return {
    id: a.id,
    idx: a.idx,
    filename: a.filename,
    mimeType: a.sniffedMime,
    sizeBytes: a.sizeBytes,
    state: a.state as 'kept' | 'suspected_signature' | 'skipped' | 'restored',
    skipReason: a.skipReason,
    willBeIngested: (INGESTABLE_ATTACHMENT_STATES as readonly string[]).includes(a.state),
  };
}

export async function mailReviewRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);
  const staff = [app.authenticate, app.authorize('admin', 'manager')];

  /** Строки списка вместе с именем ящика, подсказанным объектом и счётчиками вложений. */
  async function loadMessages(where: ReturnType<typeof eq> | undefined, limit: number) {
    // Счётчики вложений отдельным запросом, а не коррелированным подзапросом на
    // строку: писем в разборе немного, а join с group by по двум таблицам сразу
    // читается хуже.
    const rows = await app.db
      .select({
        m: mailMessages,
        accountName: mailAccounts.name,
        siteCode: sites.code,
        siteName: sites.name,
      })
      .from(mailMessages)
      .innerJoin(mailAccounts, eq(mailAccounts.id, mailMessages.mailAccountId))
      .leftJoin(sites, eq(sites.id, mailMessages.suggestedSiteId))
      .where(where)
      .orderBy(desc(mailMessages.createdAt))
      .limit(limit);

    const ids = rows.map((r) => r.m.id);
    const counts = new Map<string, { total: number; ingestable: number }>();
    if (ids.length > 0) {
      const agg = await app.db
        .select({
          messageId: mailAttachments.mailMessageId,
          total: sql<number>`count(*)::int`,
          ingestable: sql<number>`count(*) filter (where ${mailAttachments.state} in ('kept', 'restored'))::int`,
        })
        .from(mailAttachments)
        .where(inArray(mailAttachments.mailMessageId, ids))
        .groupBy(mailAttachments.mailMessageId);
      for (const a of agg) counts.set(a.messageId, { total: a.total, ingestable: a.ingestable });
    }

    return rows.map((r) => dto(r.m, r.accountName, r.siteCode, r.siteName, counts.get(r.m.id)));
  }

  function dto(
    m: MessageRow,
    accountName: string,
    siteCode: string | null,
    siteName: string | null,
    counts: { total: number; ingestable: number } | undefined,
  ) {
    return {
      id: m.id,
      accountId: m.mailAccountId,
      accountName,
      fromAddress: m.fromAddress,
      subject: m.subject,
      receivedAt: m.receivedAt?.toISOString() ?? null,
      status: m.status as never,
      rejectReason: m.rejectReason,
      suggestedSiteId: m.suggestedSiteId,
      suggestedSiteCode: siteCode,
      suggestedSiteName: siteName,
      attachmentsCount: counts?.ingestable ?? 0,
      attachmentsTotal: counts?.total ?? 0,
      bundleId: m.bundleId,
      lastError: m.lastError,
      createdAt: m.createdAt.toISOString(),
    };
  }

  // Сводка для вкладки на «Документах». Пока ящик с документами не заведён,
  // configured = false и вкладка не показывается — интерфейс не меняется.
  app.get(
    '/api/v1/mail/review/summary',
    { preHandler: staff, schema: { response: { 200: MailReviewSummarySchema } } },
    async () => {
      const [row] = await app.db
        .select({
          pending: sql<number>`(select count(*) from mail_messages where status = 'quarantined')::int`,
          configured: sql<boolean>`exists (select 1 from mail_accounts where purpose = 'document' and is_active = true)`,
        })
        .from(sql`(select 1) as _`);
      return { pending: row?.pending ?? 0, configured: row?.configured ?? false };
    },
  );

  app.get(
    '/api/v1/mail/messages',
    {
      preHandler: staff,
      schema: {
        querystring: z.object({
          status: MailReviewFilterSchema.default('pending'),
          limit: z.coerce.number().int().min(1).max(500).default(200),
        }),
        response: { 200: MailMessageListResponseSchema },
      },
    },
    async (req) => {
      const filter = req.query.status;
      const where =
        filter === 'all'
          ? undefined
          : filter === 'pending'
            ? inArray(mailMessages.status, [...PENDING_STATUSES])
            : eq(mailMessages.status, filter);

      const items = await loadMessages(where as never, req.query.limit);
      const [total] = await app.db
        .select({ n: sql<number>`count(*)::int` })
        .from(mailMessages)
        .where(where as never);
      return { items, total: total?.n ?? 0 };
    },
  );

  app.get(
    '/api/v1/mail/messages/:id',
    {
      preHandler: staff,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: MailMessageDetailSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const [row] = await app.db
        .select({
          m: mailMessages,
          accountName: mailAccounts.name,
          siteCode: sites.code,
          siteName: sites.name,
        })
        .from(mailMessages)
        .innerJoin(mailAccounts, eq(mailAccounts.id, mailMessages.mailAccountId))
        .leftJoin(sites, eq(sites.id, mailMessages.suggestedSiteId))
        .where(eq(mailMessages.id, req.params.id))
        .limit(1);
      if (!row) return reply.code(404).send({ error: 'not_found' });

      const atts = await app.db
        .select()
        .from(mailAttachments)
        .where(eq(mailAttachments.mailMessageId, row.m.id))
        .orderBy(mailAttachments.idx);

      const counts = {
        total: atts.length,
        ingestable: atts.filter((a) =>
          (INGESTABLE_ATTACHMENT_STATES as readonly string[]).includes(a.state),
        ).length,
      };
      return {
        ...dto(row.m, row.accountName, row.siteCode, row.siteName, counts),
        attachments: atts.map(attachmentDto),
      };
    },
  );

  // Текст письма. В БД тело не хранится — берём из сохранённого оригинала,
  // поэтому ручка отдельная: её сбой не должен ломать карточку целиком, а
  // качать .eml на каждую строку списка незачем.
  //
  // Наружу уходит только текст. Разметка письма приходит от кого угодно, и
  // отдавать её в интерфейс нельзя ни в каком виде.
  app.get(
    '/api/v1/mail/messages/:id/body',
    {
      preHandler: staff,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: MailMessageBodySchema,
          404: ErrorResponseSchema,
          422: ErrorResponseSchema,
          502: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [row] = await app.db
        .select({ rawS3Key: mailMessages.rawS3Key })
        .from(mailMessages)
        .where(eq(mailMessages.id, req.params.id))
        .limit(1);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      if (!row.rawS3Key) {
        return reply
          .code(404)
          .send({ error: 'raw_missing', message: 'Оригинал письма не сохранён' });
      }

      let raw: Buffer;
      try {
        raw = await getObject(row.rawS3Key);
      } catch (err) {
        req.log.warn({ err, key: row.rawS3Key }, 'S3 get failed (mail body)');
        return reply.code(502).send({ error: 's3_unavailable' });
      }

      let text: string;
      try {
        text = extractPlainText(await simpleParser(raw, { keepCidLinks: true }));
      } catch (err) {
        // Наружу только факт: подробности разбора чужого письма оператору
        // ничего не говорят, а в логе они нужны.
        req.log.warn({ err, messageId: req.params.id }, 'не удалось разобрать письмо');
        return reply
          .code(422)
          .send({ error: 'parse_failed', message: 'Не удалось прочитать текст письма' });
      }

      const truncated = text.length > MAIL_BODY_MAX_CHARS;
      return { text: truncated ? text.slice(0, MAIL_BODY_MAX_CHARS) : text, truncated };
    },
  );

  // Просмотр вложения до подтверждения: файл ещё лежит в staging и своего
  // source_document не имеет, поэтому ручка source-documents тут не подходит.
  // Стримим через бэкенд — presigned URL на S3 наружу не уходит (та же схема,
  // что у /source-documents/:id/file/raw).
  app.get(
    '/api/v1/mail/messages/:id/attachments/:attachmentId/raw',
    {
      preHandler: staff,
      schema: {
        params: z.object({ id: z.string().uuid(), attachmentId: z.string().uuid() }),
        querystring: z.object({ download: z.enum(['1']).optional() }),
      },
    },
    async (req, reply) => {
      const [att] = await app.db
        .select()
        .from(mailAttachments)
        .where(
          and(
            eq(mailAttachments.id, req.params.attachmentId),
            eq(mailAttachments.mailMessageId, req.params.id),
          ),
        )
        .limit(1);
      if (!att?.stagingS3Key) return reply.code(404).send({ error: 'not_found' });

      let signedUrl: string;
      try {
        signedUrl = await presign({ method: 'GET', key: att.stagingS3Key, expiresIn: 60 });
      } catch (err) {
        req.log.warn({ err, key: att.stagingS3Key }, 'presign failed (mail attachment)');
        return reply.code(404).send({ error: 'presign_failed' });
      }

      let upstream: Response;
      try {
        upstream = await fetch(signedUrl);
      } catch (err) {
        req.log.warn({ err, key: att.stagingS3Key }, 'S3 fetch failed (mail attachment)');
        return reply.code(502).send({ error: 's3_unavailable' });
      }
      if (!upstream.ok || !upstream.body) {
        return reply.code(502).send({ error: 's3_unavailable' });
      }

      const mime = att.sniffedMime ?? 'application/octet-stream';
      const isExcelMime = mime.includes('spreadsheetml') || mime === 'application/vnd.ms-excel';
      const wantAttachment = req.query.download === '1' || isExcelMime;
      reply.header('content-type', mime);
      reply.header(
        'content-disposition',
        `${wantAttachment ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(
          att.filename ?? `file-${att.idx + 1}`,
        )}`,
      );
      reply.header('cache-control', 'private, max-age=300');
      const len = upstream.headers.get('content-length');
      if (len) reply.header('content-length', len);
      return reply.send(Readable.fromWeb(upstream.body as never));
    },
  );

  // Вернуть вложение, ошибочно принятое за подпись в письме. Фильтр ничего не
  // удаляет именно ради этого: скан УПД, попавший под признаки картинки-подписи,
  // возвращается одним действием, а не перезаливкой письма.
  app.post(
    '/api/v1/mail/messages/:id/attachments/:attachmentId/restore',
    {
      preHandler: staff,
      schema: {
        params: z.object({ id: z.string().uuid(), attachmentId: z.string().uuid() }),
        response: {
          200: z.object({ ok: z.literal(true) }),
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [att] = await app.db
        .select({
          state: mailAttachments.state,
          stagingS3Key: mailAttachments.stagingS3Key,
          messageStatus: mailMessages.status,
        })
        .from(mailAttachments)
        .innerJoin(mailMessages, eq(mailMessages.id, mailAttachments.mailMessageId))
        .where(
          and(
            eq(mailAttachments.id, req.params.attachmentId),
            eq(mailAttachments.mailMessageId, req.params.id),
          ),
        )
        .limit(1);
      if (!att) return reply.code(404).send({ error: 'not_found' });

      // Возвращать можно только то, что реально можно положить в пакет.
      // Отброшенное (`skipped`) в хранилище не заливается вовсе — восстановив
      // его, мы получили бы строку, которая считается пригодной, а копировать
      // нечего. А у принятого письма пакет уже собран: менять состав постфактум
      // значит врать о том, что ушло в распознавание.
      if (att.messageStatus !== 'quarantined') {
        return reply.code(400).send({
          error: 'not_quarantined',
          message: 'Письмо уже обработано — состав вложений изменить нельзя',
        });
      }
      if (att.state !== 'suspected_signature' || !att.stagingS3Key) {
        return reply.code(400).send({
          error: 'not_restorable',
          message: 'Вернуть можно только вложение, отложенное как подпись в письме',
        });
      }

      await app.db
        .update(mailAttachments)
        .set({ state: 'restored', skipReason: null })
        .where(eq(mailAttachments.id, req.params.attachmentId));
      return { ok: true as const };
    },
  );

  // Подтверждение оператором: объект выбран руками, дальше — та же сага, что и
  // у автопрохода.
  app.post(
    '/api/v1/mail/messages/:id/resolve',
    {
      preHandler: staff,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: MailResolveRequestSchema,
        response: {
          200: MailResolveResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [site] = await app.db
        .select({ id: sites.id })
        .from(sites)
        .where(eq(sites.id, req.body.siteId))
        .limit(1);
      if (!site) return reply.code(400).send({ error: 'site_not_found' });

      const result = await resolveMailMessage(
        { db: app.db, copyObject, log: req.log },
        {
          messageId: req.params.id,
          siteId: req.body.siteId,
          direction: req.body.direction,
          contractorId: req.body.contractorId ?? null,
          expectedDate: req.body.expectedDate ?? null,
          actorUserId: req.user?.id ?? null,
        },
      );

      switch (result.outcome) {
        case 'ingested':
          return { outcome: 'ingested' as const, bundleId: result.bundleId, documentId: result.documentId };
        case 'reused':
          return { outcome: 'reused' as const, bundleId: result.bundleId, documentId: null };
        case 'cross_scope':
          return reply.code(409).send({
            error: 'cross_scope_conflict',
            message: `Тот же комплект файлов уже загружен на другой объект (пакет ${result.conflictingBundleId}). Проверьте, не дубль ли это.`,
          });
        case 'no_attachments':
          return reply.code(400).send({
            error: 'no_attachments',
            message: 'В письме нет пригодных вложений. Верните отброшенное вложение или отклоните письмо.',
          });
        default:
          return reply.code(404).send({ error: 'not_quarantined' });
      }
    },
  );

  // Письма, которые не удалось забрать. После исчерпания попыток граница ящика
  // их перешагнула, и обычный проход к ним не вернётся — отсюда и кнопка
  // повторного забора.
  app.get(
    '/api/v1/mail/receipts',
    {
      preHandler: staff,
      schema: {
        querystring: z.object({
          /** `problems` — только требующие внимания; `all` — весь журнал. */
          scope: z.enum(['problems', 'all']).default('problems'),
          limit: z.coerce.number().int().min(1).max(500).default(200),
        }),
        response: { 200: MailReceiptListResponseSchema },
      },
    },
    async (req) => {
      const problems = inArray(mailReceipts.status, [...REPLAYABLE_STATUSES]);
      const where = req.query.scope === 'problems' ? problems : undefined;

      const rows = await app.db
        .select({ r: mailReceipts, accountName: mailAccounts.name })
        .from(mailReceipts)
        .innerJoin(mailAccounts, eq(mailAccounts.id, mailReceipts.mailAccountId))
        .where(where)
        .orderBy(desc(mailReceipts.updatedAt))
        .limit(req.query.limit);

      const [total] = await app.db
        .select({ n: sql<number>`count(*)::int` })
        .from(mailReceipts)
        .where(where);

      return {
        items: rows.map(({ r, accountName }) => ({
          id: r.id,
          accountId: r.mailAccountId,
          accountName,
          uid: r.uid,
          status: r.status as never,
          sizeBytes: r.rfc822Size,
          attempts: r.attempts,
          lastError: r.lastError,
          replayRequested: r.replayRequestedAt !== null,
          canReplay: (REPLAYABLE_STATUSES as readonly string[]).includes(r.status),
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        })),
        total: total?.n ?? 0,
      };
    },
  );

  // Повторный забор. Письмо не скачивается прямо сейчас: запись помечается, а
  // заберёт её ближайший проход поллера — точечно по UID, не сдвигая границу.
  app.post(
    '/api/v1/mail/receipts/:id/replay',
    {
      preHandler: staff,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          202: MailReplayResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const result = await requestReplay(app.db, req.params.id);
      if (!result.ok) {
        if (result.reason === 'not_found') return reply.code(404).send({ error: 'not_found' });
        return reply.code(400).send({
          error: 'not_replayable',
          message: 'Повторить можно только письмо, которое не удалось скачать',
        });
      }
      reply.code(202);
      return { requested: true as const, uid: result.uid };
    },
  );

  // Отклонение: письмо остаётся в базе со своей причиной — иначе исход
  // «оператор посмотрел и решил, что это не документ» нигде не виден.
  app.post(
    '/api/v1/mail/messages/:id/reject',
    {
      preHandler: staff,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: MailRejectRequestSchema,
        response: { 200: z.object({ ok: z.literal(true) }), 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const updated = await app.db
        .update(mailMessages)
        .set({
          status: 'rejected',
          rejectReason: req.body.reason ?? 'rejected_by_operator',
          updatedAt: new Date(),
        })
        .where(
          and(eq(mailMessages.id, req.params.id), eq(mailMessages.status, 'quarantined')),
        )
        .returning({ id: mailMessages.id });
      if (updated.length === 0) return reply.code(404).send({ error: 'not_quarantined' });
      return { ok: true as const };
    },
  );
}
