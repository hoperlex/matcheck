import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../../lib/fastify.js';
import {
  EdoAccountCreateSchema,
  EdoAccountDtoSchema,
  EdoAccountPatchSchema,
  EdoCheckResultSchema,
  EdoJobQueuedSchema,
  EdoJournalSummarySchema,
  ErrorResponseSchema,
  StoredEdoCredentialsSchema,
  type EdoCredentials,
} from '@matcheck/contracts';
import { edoAccounts, edoEvents, edoReceipts } from '../../db/schema.js';
import { buildAad, encryptToString, decryptField, sha256Hex } from '../../domain/auth/crypto.js';
import { loadEnv } from '../../lib/env.js';
import { checkEdoAccess } from '../../domain/edo/check-access.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Секреты наружу не отдаются никогда — только признаки их наличия.
 *
 * Возраст refresh-токена показывается по делу: он живёт 30 дней, счётчик
 * продлевается при каждом использовании, поэтому учётная запись с выключенным
 * опросом умирает молча. Без этого числа о смерти доступа узнают в худший
 * момент, а восстановить его можно только руками через браузер.
 */
function dto(a: typeof edoAccounts.$inferSelect) {
  let hasClientSecret = false;
  let hasRefreshToken = Boolean(a.authStateEncrypted);
  let clientId: string | null = null;
  let clientSecretLength: number | null = null;
  let refreshTokenLength: number | null = null;
  let clientSecretFingerprint: string | null = null;
  let refreshTokenFingerprint: string | null = null;
  try {
    const creds = StoredEdoCredentialsSchema.parse(
      JSON.parse(decryptField(a.credentialsEncrypted, buildAad('edo_accounts', a.id))),
    ) as EdoCredentials;
    if (creds.authMode === 'oidc_refresh') {
      hasClientSecret = Boolean(creds.clientSecret);
      hasRefreshToken = hasRefreshToken || Boolean(creds.refreshToken);
      // Наружу уходит идентификатор приложения и ДЛИНЫ секретов, но не они
      // сами: длина ловит обрезанное или склеенное значение, а на отказ
      // сервис отвечает одинаково и на «не тот ключ», и на «лишний пробел».
      clientId = creds.clientId;
      clientSecretLength = creds.clientSecret.length;
      refreshTokenLength = creds.refreshToken.length;
      // Отпечаток, а не значение: длина ловит обрезанное, но не подменённое —
      // два разных ключа одной длины по ней неразличимы. Восьми символов хеша
      // хватает, чтобы сравнить глазами, и мало, чтобы что-то раскрыть.
      clientSecretFingerprint = sha256Hex(creds.clientSecret).slice(0, 8);
      refreshTokenFingerprint = sha256Hex(creds.refreshToken).slice(0, 8);
    } else {
      hasClientSecret = Boolean(creds.password);
    }
  } catch {
    // Нечитаемые секреты не должны ронять список учётных записей: администратор
    // обязан увидеть запись, чтобы её починить или удалить.
  }

  const usedAt = a.refreshTokenUsedAt;
  return {
    id: a.id,
    provider: a.provider,
    name: a.name,
    isActive: a.isActive,
    pollEnabled: a.pollEnabled,
    authMode: a.authMode,
    environment: a.environment,
    boxId: a.boxId,
    orgInn: a.orgInn,
    defaultSiteId: a.defaultSiteId,
    clientId,
    hasClientSecret,
    hasRefreshToken,
    clientSecretLength,
    refreshTokenLength,
    clientSecretFingerprint,
    refreshTokenFingerprint,
    refreshTokenAgeDays: usedAt ? Math.floor((Date.now() - usedAt.getTime()) / DAY_MS) : null,
    lastEventAt: a.lastEventAt?.toISOString() ?? null,
    lastSyncAt: a.lastSyncAt?.toISOString() ?? null,
    lastOkAt: a.lastOkAt?.toISOString() ?? null,
    lastError: a.lastError,
    backfillSince: a.backfillSince?.toISOString() ?? null,
    // Отчёт разведки отдаём прямо в карточке: он маленький, а отдельный запрос
    // ради него заставил бы интерфейс гадать, закончилась работа или ещё идёт.
    lastInventory: a.lastInventory ?? null,
    lastInventoryAt: a.lastInventoryAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
  };
}

export async function edoAccountRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);

  app.get(
    '/api/v1/admin/edo-accounts',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: { response: { 200: z.array(EdoAccountDtoSchema) } },
    },
    async () => {
      const rows = await app.db.select().from(edoAccounts).orderBy(desc(edoAccounts.createdAt));
      return rows.map(dto);
    },
  );

  app.post(
    '/api/v1/admin/edo-accounts',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: { body: EdoAccountCreateSchema, response: { 201: EdoAccountDtoSchema } },
    },
    async (req, reply) => {
      const id = crypto.randomUUID();
      const encrypted = encryptToString(
        JSON.stringify(req.body.credentials),
        buildAad('edo_accounts', id),
      );
      // Отсечка первичной загрузки фиксируется ОДИН раз, при заведении: она
      // уходит в сам запрос к Диадоку, и пересчёт «от сегодня» на каждом проходе
      // означал бы, что документы, пришедшие в простой, никогда не заберутся.
      const backfillSince = new Date(Date.now() - loadEnv().EDO_BACKFILL_DAYS * DAY_MS);

      const [created] = await app.db
        .insert(edoAccounts)
        .values({
          id,
          provider: req.body.provider,
          name: req.body.name,
          environment: req.body.environment,
          authMode: req.body.credentials.authMode,
          credentialsEncrypted: encrypted,
          boxId: req.body.boxId ?? null,
          orgInn: req.body.orgInn ?? null,
          defaultSiteId: req.body.defaultSiteId ?? null,
          backfillSince,
          isActive: req.body.isActive,
        })
        .returning();
      if (!created) throw new Error('Failed to insert edo_account');
      reply.code(201);
      return dto(created);
    },
  );

  app.patch(
    '/api/v1/admin/edo-accounts/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: EdoAccountPatchSchema,
        response: { 200: EdoAccountDtoSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const [row] = await app.db
        .select()
        .from(edoAccounts)
        .where(eq(edoAccounts.id, req.params.id))
        .limit(1);
      if (!row) return reply.code(404).send({ error: 'not_found' });

      const patch: Partial<typeof edoAccounts.$inferInsert> = { updatedAt: new Date() };
      if (req.body.name !== undefined) patch.name = req.body.name;
      if (req.body.isActive !== undefined) patch.isActive = req.body.isActive;
      if (req.body.pollEnabled !== undefined) patch.pollEnabled = req.body.pollEnabled;
      if (req.body.orgInn !== undefined) patch.orgInn = req.body.orgInn;
      if (req.body.defaultSiteId !== undefined) patch.defaultSiteId = req.body.defaultSiteId;

      // Смена ящика делает курсор бессмысленным: он указывает на позицию в
      // ленте ДРУГОГО ящика. Молча его сбросить тоже нельзя — это тихая
      // перезагрузка всей истории, поэтому после первого успешного опроса ящик
      // меняться не может, нужна новая учётная запись.
      if (req.body.boxId !== undefined && req.body.boxId !== row.boxId) {
        if (row.lastIndexKey) {
          return reply.code(409).send({
            error: 'box_change_forbidden',
            message:
              'Ящик уже опрашивался: смена boxId обесценит курсор. Заведите отдельную учётную запись.',
          });
        }
        patch.boxId = req.body.boxId;
      }

      // Смена площадки, client_id или первичного refresh_token — это другое
      // подключение. Прежний access_token к нему не относится, поэтому
      // состояние авторизации сбрасывается вместе с ними.
      let resetAuthState = false;
      if (req.body.environment !== undefined && req.body.environment !== row.environment) {
        patch.environment = req.body.environment;
        resetAuthState = true;
      }

      if (req.body.credentials) {
        const current = StoredEdoCredentialsSchema.parse(
          JSON.parse(decryptField(row.credentialsEncrypted, buildAad('edo_accounts', row.id))),
        ) as EdoCredentials;
        if (current.authMode !== 'oidc_refresh') {
          return reply.code(409).send({
            error: 'unsupported_auth_mode',
            message: 'Учётная запись заведена на ключ разработчика — правка секретов недоступна.',
          });
        }
        // Пустое поле в форме означает «не менял»: секреты наружу не отдаются,
        // и пользователь физически не может «подтвердить» прежнее значение.
        const next = {
          ...current,
          ...(req.body.credentials.clientId ? { clientId: req.body.credentials.clientId } : {}),
          ...(req.body.credentials.clientSecret
            ? { clientSecret: req.body.credentials.clientSecret }
            : {}),
          ...(req.body.credentials.refreshToken
            ? { refreshToken: req.body.credentials.refreshToken }
            : {}),
        };
        if (
          (req.body.credentials.clientId && req.body.credentials.clientId !== current.clientId) ||
          req.body.credentials.refreshToken
        ) {
          resetAuthState = true;
        }
        patch.credentialsEncrypted = encryptToString(
          JSON.stringify(next),
          buildAad('edo_accounts', row.id),
        );
      }

      if (resetAuthState) {
        patch.authStateEncrypted = null;
        patch.authStateVersion = row.authStateVersion + 1;
        patch.refreshTokenUsedAt = null;
      }

      const [updated] = await app.db
        .update(edoAccounts)
        .set(patch)
        .where(eq(edoAccounts.id, row.id))
        .returning();
      if (!updated) return reply.code(404).send({ error: 'not_found' });
      return dto(updated);
    },
  );

  app.delete(
    '/api/v1/admin/edo-accounts/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const del = await app.db
        .delete(edoAccounts)
        .where(eq(edoAccounts.id, req.params.id))
        .returning({ id: edoAccounts.id });
      if (del.length === 0) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );

  /**
   * Проверка доступа: какие ящики видит учётная запись и хватает ли ей прав.
   *
   * Синхронно — это два коротких запроса, а ответ нужен администратору прямо в
   * форме, чтобы подставить boxId и ИНН, не выясняя их где-то ещё.
   */
  app.post(
    '/api/v1/admin/edo-accounts/:id/check',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: EdoCheckResultSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          502: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [row] = await app.db
        .select()
        .from(edoAccounts)
        .where(eq(edoAccounts.id, req.params.id))
        .limit(1);
      if (!row) return reply.code(404).send({ error: 'not_found' });

      const result = await checkEdoAccess(app.db, row, app.log);
      if ('error' in result) {
        return reply.code(result.status).send({ error: result.error, message: result.message });
      }
      return result.value;
    },
  );

  /**
   * Ручная синхронизация.
   *
   * Раньше импорт шёл прямо в процессе API, а браузер ждал ответа до десяти
   * минут. Теперь это работа в очереди: ответ сразу, ход виден по журналу.
   */
  app.post(
    '/api/v1/admin/edo-accounts/:id/sync',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 202: EdoJobQueuedSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const [row] = await app.db
        .select({ id: edoAccounts.id })
        .from(edoAccounts)
        .where(eq(edoAccounts.id, req.params.id))
        .limit(1);
      if (!row) return reply.code(404).send({ error: 'not_found' });

      const job = await app.queues.edoPoll.add('sync', { accountId: row.id, mode: 'sync' });
      reply.code(202);
      return { queued: true as const, jobId: String(job.id) };
    },
  );

  /**
   * Журнал приёма: что произошло с документами ящика.
   *
   * Без него единственный ответ на «почему документ не приехал» — запрос в
   * базу. Транспорт и маршрут показываются раздельно: «файл не забрали» и
   * «файл забрали, но не разобрали» — разные неполадки с разными действиями.
   */
  app.get(
    '/api/v1/admin/edo-accounts/:id/journal',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
        response: { 200: EdoJournalSummarySchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const [row] = await app.db
        .select({ id: edoAccounts.id })
        .from(edoAccounts)
        .where(eq(edoAccounts.id, req.params.id))
        .limit(1);
      if (!row) return reply.code(404).send({ error: 'not_found' });

      const byTransport = await app.db
        .select({ status: edoReceipts.transportStatus, count: count() })
        .from(edoReceipts)
        .where(eq(edoReceipts.edoAccountId, row.id))
        .groupBy(edoReceipts.transportStatus);

      const byRoute = await app.db
        .select({ status: edoReceipts.routeStatus, count: count() })
        .from(edoReceipts)
        .where(eq(edoReceipts.edoAccountId, row.id))
        .groupBy(edoReceipts.routeStatus);

      // Незакрытые события — прямой ответ на «почему лента не идёт дальше»:
      // курсор стоит на первом из них.
      const [pending] = await app.db
        .select({ count: count() })
        .from(edoEvents)
        .where(and(eq(edoEvents.edoAccountId, row.id), eq(edoEvents.status, 'pending')));

      const entries = await app.db
        .select()
        .from(edoReceipts)
        .where(eq(edoReceipts.edoAccountId, row.id))
        .orderBy(desc(edoReceipts.createdAt))
        .limit(req.query.limit);

      return {
        byTransport: byTransport.map((r) => ({ status: r.status, count: Number(r.count) })),
        byRoute: byRoute.map((r) => ({ status: r.status, count: Number(r.count) })),
        eventsPending: Number(pending?.count ?? 0),
        entries: entries.map((e) => ({
          id: e.id,
          messageId: e.messageId,
          entityId: e.entityId,
          documentNumber: e.documentNumber,
          documentType: e.documentType,
          documentVersion: e.documentVersion,
          transportStatus: e.transportStatus,
          routeStatus: e.routeStatus,
          attempts: e.attempts,
          lastError: e.lastError,
          sourceDocumentId: e.sourceDocumentId,
          createdAt: e.createdAt.toISOString(),
        })),
      };
    },
  );

  /**
   * Инвентаризация ящика: что в нём лежит, без единого импорта.
   *
   * Тоже в очередь, и по той же причине, что и синхронизация: по объёму обхода
   * это то же самое чтение ленты.
   */
  app.post(
    '/api/v1/admin/edo-accounts/:id/inventory',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ since: z.string().datetime().optional() }).optional(),
        response: { 202: EdoJobQueuedSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const [row] = await app.db
        .select({ id: edoAccounts.id })
        .from(edoAccounts)
        .where(eq(edoAccounts.id, req.params.id))
        .limit(1);
      if (!row) return reply.code(404).send({ error: 'not_found' });

      const job = await app.queues.edoPoll.add('inventory', {
        accountId: row.id,
        mode: 'inventory',
        since: req.body?.since,
      });
      reply.code(202);
      return { queued: true as const, jobId: String(job.id) };
    },
  );
}
