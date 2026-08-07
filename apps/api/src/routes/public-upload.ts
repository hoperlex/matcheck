// Публичный вход: поставщик загружает документы приёмки без авторизации.
//
// Всё, что здесь объявлено, лежит под префиксом /api/v1/public/ — только он
// исключён из глобального auth-хука (см. plugins/auth.ts). Никакой роут
// отсюда не должен читать req.user: его тут нет и не будет.
//
// Принципы периметра:
//   * наружу уходит минимум — тикет обращения и судьба файлов по входному
//     фильтру; ни внутренних id, ни типов документов, ни вердиктов парсеров;
//   * вход недоверенный — тип файла определяется по содержимому, а не по
//     расширению; лимиты объёма проверяются накопительно;
//   * фича выключается переменной окружения без выката образа.

import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { and, asc, eq, sql as drSql } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import {
  ErrorResponseSchema,
  PublicSiteListResponseSchema,
  PublicUploadRequestSchema,
  PublicUploadResponseSchema,
  PublicUploadStatusSchema,
} from '@matcheck/contracts';
import { bundleImportItems, ingestEvents, sites, sourceBundles } from '../db/schema.js';
import { SYSTEM_SITE_ID } from '../db/schema.js';
import { collectUploadParts, uploadLimitMessage } from '../domain/sourceDocuments/collect-upload.js';
import { ingestDocumentsBundle } from '../domain/sourceDocuments/ingest-bundle.js';

/** Лимиты публичной загрузки. Строже внутренних: вход открыт всем. */
const PUBLIC_LIMITS = {
  maxFiles: 10,
  maxFileBytes: 10 * 1024 * 1024,
  // Главный потолок. Реальный предел ставит nginx (client_max_body_size 25m),
  // и при его превышении наружу уходит HTML-413 мимо API — держимся ниже.
  maxTotalBytes: 20 * 1024 * 1024,
  maxFields: 10,
  // Лимит применяется к КАЖДОМУ полю по отдельности. Комментарий — 500
  // символов, и кириллица в UTF-8 занимает по два байта на символ, то есть
  // до 1000 байт; 2048 берём запасом на эмодзи и прочие многобайтовые символы.
  maxFieldBytes: 2048,
  maxParts: 25,
} as const;

/** Кэш публичного справочника объектов: меняется раз в недели. */
const SITES_CACHE_TTL_MS = 60_000;
let sitesCache: { at: number; items: Array<{ id: string; name: string }> } | null = null;

function newTicket(): string {
  // 16 байт = 128 бит: перебор нереален, а base64url даёт 22 символа —
  // человек может продиктовать такой номер менеджеру по телефону.
  return randomBytes(16).toString('base64url');
}

/**
 * IP клиента для лимитера.
 *
 * req.ip брать нельзя: Fastify поднят с trustProxy: true и берёт САМЫЙ ЛЕВЫЙ
 * адрес из X-Forwarded-For, а nginx этот заголовок не заменяет, а дополняет
 * ($proxy_add_x_forwarded_for) — клиент подделал бы себе новый лимит каждым
 * запросом. X-Real-IP nginx перезаписывает своим $remote_addr, подделать его
 * нельзя; следом идёт последний элемент XFF (его добавил наш же nginx).
 */
function clientIpOf(req: { headers: Record<string, unknown>; ip: string }): string {
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') {
    const parts = xff
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  return req.ip;
}

export async function publicUploadRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);

  /**
   * Глобальный потолок фичи поверх per-IP лимита.
   *
   * Два config.rateLimit на одном роуте не складываются: первый хук помечает
   * запрос внутренним флагом, второй молча пропускается. Поэтому второй
   * лимитер создаётся вручную и проверяется в обработчике.
   *
   * ВНИМАНИЕ на контракт ответа: isAllowed === true означает «ключ в allowList,
   * лимит к нему не применяется», а НЕ «запрос пропущен». allowList у нас не
   * настроен, поэтому isAllowed всегда false, и превышение показывает только
   * isExceeded. Проверка по !isAllowed отдавала 429 на каждый запрос.
   */
  const globalUploadLimit = app.createRateLimit({
    max: 200,
    timeWindow: '1 hour',
    keyGenerator: () => 'public-upload:global',
  });

  // ──────────── Справочник объектов для формы ────────────
  app.get(
    '/api/v1/public/sites',
    {
      // Открытие страницы = один запрос, остальное отдаёт кэш.
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: { response: { 200: PublicSiteListResponseSchema } },
    },
    async (_req, reply) => {
      const now = Date.now();
      if (!sitesCache || now - sitesCache.at > SITES_CACHE_TTL_MS) {
        const rows = await app.db
          .select({ id: sites.id, name: sites.name })
          .from(sites)
          .where(and(eq(sites.isActive, true), drSql`${sites.id} <> ${SYSTEM_SITE_ID}`))
          .orderBy(asc(sites.name))
          .limit(500);
        sitesCache = { at: now, items: rows };
      }
      // Наружу — только id и название: внутренний код объекта, адрес и
      // ФОТ-идентификатор поставщику знать незачем.
      reply.header('cache-control', `public, max-age=${SITES_CACHE_TTL_MS / 1000}`);
      return { items: sitesCache.items };
    },
  );

  // ──────────── Приём документов ────────────
  app.post(
    '/api/v1/public/upload-documents',
    {
      // Один визит = до 10 поставок, каждая уходит отдельным запросом, плюс
      // запас на повторы неудачных. Выше не поднимаем: лимит считает запросы,
      // а каждый запрос — до 20 МБ, то есть 20 на адрес это уже 400 МБ за
      // десять минут. Офис подрядчика за одним внешним IP при этом не
      // блокируется. ban не используем: он отдаёт 403, а UI объясняет только 429.
      config: {
        rateLimit: {
          max: 20,
          timeWindow: '10 minutes',
          keyGenerator: (req) => `public-upload:${clientIpOf(req as never)}`,
        },
      },
      schema: {
        response: {
          201: PublicUploadResponseSchema,
          400: ErrorResponseSchema,
          409: ErrorResponseSchema,
          413: ErrorResponseSchema,
          429: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const globalCheck = await globalUploadLimit(req);
      if (!globalCheck.isAllowed && globalCheck.isExceeded) {
        req.log.warn(
          { ttl: globalCheck.ttlInSeconds, ip: clientIpOf(req) },
          'public upload: global limit exceeded',
        );
        // Per-IP хук отработал в onRequest и уже положил в ответ СВОИ цифры
        // (limit 20, остаток по адресу). Оставить их — значит отдать 429 с
        // заголовками, которые противоречат и коду ответа, и retry-after.
        // Отказ глобальный, поэтому и заголовки описывают глобальный потолок.
        return reply
          .code(429)
          .header('x-ratelimit-limit', String(globalCheck.max))
          .header('x-ratelimit-remaining', '0')
          .header('x-ratelimit-reset', String(globalCheck.ttlInSeconds))
          .header('retry-after', String(globalCheck.ttlInSeconds))
          .send({
            error: 'too_many_requests',
            message: 'Сервис временно перегружен. Попробуйте через несколько минут.',
          });
      }

      // Поля формы приходят по ходу чтения потока, поэтому honeypot и объект
      // проверить ДО чтения тела невозможно. Читаем за один проход, решения
      // принимаем ниже — но всё ещё до единой записи в БД, S3 и очередь.
      const collected = await collectUploadParts(req, PUBLIC_LIMITS, 'strict');
      if (!collected.ok) {
        return reply
          .code(413)
          .send({ error: collected.error, message: uploadLimitMessage(collected.error) });
      }

      // Honeypot: поле скрыто от человека и не заполняется браузером.
      // Отвечаем как при успехе — бот не должен узнать, что распознан.
      if ((collected.fields.website ?? '').trim() !== '') {
        req.log.warn({ ip: clientIpOf(req) }, 'public upload: honeypot triggered');
        return reply
          .code(201)
          .send({ ticket: newTicket(), filesAccepted: 0, filesRejected: [] });
      }

      const meta = PublicUploadRequestSchema.safeParse(collected.fields);
      if (!meta.success) {
        return reply.code(400).send({
          error: 'bad_request',
          message: meta.error.issues.map((i) => i.message).join('; '),
        });
      }

      if (collected.accepted.length === 0) {
        return reply.code(400).send({
          error: 'no_files',
          message:
            collected.rejected.length > 0
              ? 'Ни один файл не подошёл: принимаем PDF, фотографии и Excel (.xlsx).'
              : 'Не приложен ни один файл',
        });
      }

      // Объект проверяем явно: без этого несуществующий id упёрся бы в
      // ошибку внешнего ключа и вернул 500 вместо понятного «выберите объект».
      const [site] = await app.db
        .select({ id: sites.id })
        .from(sites)
        .where(and(eq(sites.id, meta.data.siteId), eq(sites.isActive, true)))
        .limit(1);
      if (!site) {
        return reply
          .code(400)
          .send({ error: 'bad_request', message: 'Объект не найден. Выберите объект из списка.' });
      }

      const ticket = newTicket();
      const result = await ingestDocumentsBundle(
        { db: app.db, queue: app.queues.updParse, log: req.log },
        {
          files: collected.accepted,
          // Публичная загрузка — всегда приёмка. Из формы не принимаем:
          // отгрузку оформляет только сотрудник.
          direction: 'inbound',
          siteId: meta.data.siteId,
          expectedDate: meta.data.expectedDate,
          actorUserId: null,
          // Задание пишется в одной транзакции с пакетом: недоступность Redis
          // не должна оставить поставщика с «принято», но без разбора.
          dispatch: 'outbox',
          // Вход открыт всем: две вкладки с одним комплектом — обычное дело.
          concurrency: 'reserve',
          publicSubmission: {
            ticket,
            comment: meta.data.comment ?? null,
            ip: clientIpOf(req),
            userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
            manifest: [
              ...collected.accepted.map((f) => ({ filename: f.filename, accepted: true })),
              ...collected.rejected.map((f) => ({
                filename: f.filename,
                accepted: false,
                reason: f.reason,
              })),
            ],
          },
        },
      );

      if (result.outcome === 's3_unavailable') {
        return reply.code(503).send({
          error: 's3_unavailable',
          message: 'Хранилище временно недоступно. Попробуйте отправить документы ещё раз.',
        });
      }
      // Отказа «эти же файлы уже загружены на другой объект» здесь больше нет.
      // Поставщик не должен разбираться, куда и когда комплект грузили раньше:
      // приём для него окончателен. Тот же комплект на другой объект или дату
      // теперь становится отдельным пакетом, а менеджер видит ссылку на
      // двойник через ingest_events.cross_scope_of.
      reply.code(201);
      return {
        ticket: result.ticket ?? ticket,
        filesAccepted: collected.accepted.length,
        filesRejected: collected.rejected,
      };
    },
  );

  // ──────────── Статус обращения ────────────
  app.get(
    '/api/v1/public/upload-documents/:ticket',
    {
      // Страница опрашивает статус раз в 2 секунды в течение минуты.
      config: {
        rateLimit: {
          max: 60,
          timeWindow: '1 minute',
          keyGenerator: (req) => `public-status:${clientIpOf(req as never)}`,
        },
      },
      schema: {
        params: z.object({ ticket: z.string().min(10).max(32) }),
        response: {
          200: PublicUploadStatusSchema,
          404: ErrorResponseSchema,
          429: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      // Поиск по тикету, а не по id пакета: так эндпоинт по построению видит
      // только публичные отправки и не может отдать состояние внутренней.
      const [event] = await app.db
        .select({
          bundleId: ingestEvents.bundleId,
          manifest: ingestEvents.submissionManifest,
          createdAt: ingestEvents.createdAt,
          bundleStatus: sourceBundles.status,
        })
        .from(ingestEvents)
        .innerJoin(sourceBundles, eq(sourceBundles.id, ingestEvents.bundleId))
        .where(eq(ingestEvents.publicTicket, req.params.ticket))
        .limit(1);
      if (!event) {
        return reply.code(404).send({ error: 'not_found', message: 'Обращение не найдено' });
      }

      const manifest = Array.isArray(event.manifest)
        ? (event.manifest as Array<{ filename: string; accepted: boolean; reason?: string }>)
        : [];

      // Статус — про пакет целиком. Судьба конкретного документа наружу не
      // уходит: 'parsed' у пакета означает лишь «файлы разложены и переданы
      // на распознавание», а не «распознавание закончено».
      let status: 'processing' | 'done' | 'failed' = 'processing';
      if (event.bundleStatus === 'parsed') status = 'done';
      else if (event.bundleStatus === 'parse_failed') status = 'failed';

      // Журнал пакета читаем только чтобы понять, дошли ли файлы до разбора;
      // его содержимое (тип документа, парсер, id) наружу не отдаётся.
      if (status === 'processing') {
        const [item] = await app.db
          .select({ id: bundleImportItems.id })
          .from(bundleImportItems)
          .where(eq(bundleImportItems.bundleId, event.bundleId))
          .limit(1);
        if (item && event.bundleStatus === 'parsed') status = 'done';
      }

      return {
        ticket: req.params.ticket,
        status,
        filesTotal: manifest.length,
        filesAccepted: manifest.filter((f) => f.accepted).length,
        files: manifest.map((f) => ({
          filename: f.filename,
          accepted: f.accepted,
          reason: f.accepted ? null : ((f.reason ?? null) as never),
        })),
        submittedAt: event.createdAt.toISOString(),
      };
    },
  );
}
