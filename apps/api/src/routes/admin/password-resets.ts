import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  ErrorResponseSchema,
  PasswordResetLinkSchema,
  PasswordResetOkResponseSchema,
  PasswordResetStateListResponseSchema,
} from '@matcheck/contracts';
import { asZod } from '../../lib/fastify.js';
import { authEvents, passwordResetRequests, passwordResetTokens, users } from '../../db/schema.js';
import { buildAad, decryptField, encryptToString, sha256Hex } from '../../domain/auth/crypto.js';
import { buildTrustedUrl } from '../../lib/public-url.js';
import type { DbLike } from '../../domain/auth/apply-password.js';

/**
 * Ссылки на смену пароля: выдача, показ, отзыв.
 *
 * Токен в базе не хранится открытым — только sha256 (для поиска публичным
 * роутом) и AES-256-GCM-конверт (чтобы админ мог показать ссылку повторно).
 * В отличие от share-ссылки, эта равносильна паролю: ею захватывают аккаунт.
 */

// 32 байта — вдвое больше, чем у share-токена: цена подбора должна быть
// заведомо неподъёмной, а длина ссылки роли не играет, её копируют кнопкой.
const TOKEN_BYTES = 32;
const TTL_MS = 24 * 60 * 60 * 1000;

const activeToken = and(isNull(passwordResetTokens.usedAt), isNull(passwordResetTokens.revokedAt));

function tokenUrl(token: string): string {
  // Токен уходит во фрагмент: он не покидает браузер, поэтому не оседает ни в
  // логах прокси, ни в Referer, ни в телеметрии. buildTrustedUrl намеренно без
  // фолбэка на заголовок Host — подделанный Host увёл бы ссылку, задающую
  // пароль, на чужой домен.
  return buildTrustedUrl(`/reset-password#${token}`);
}

/**
 * Создаёт ссылку, погасив все непогашенные. Отзываем в том числе протухшие:
 * уникальный индекс на (user_id) считает открытыми любые записи без used_at и
 * revoked_at, срок он не учитывает — предикат индекса обязан быть immutable.
 */
async function issueLink(db: DbLike, userId: string, adminId: string) {
  await db
    .update(passwordResetTokens)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(passwordResetTokens.userId, userId), activeToken));

  const id = randomUUID();
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + TTL_MS);
  await db.insert(passwordResetTokens).values({
    id,
    userId,
    tokenHash: sha256Hex(token),
    // id генерируется заранее именно ради AAD: конверт нельзя переставить в
    // другую строку таблицы.
    tokenEncrypted: encryptToString(token, buildAad('password_reset_tokens', id)),
    createdByUserId: adminId,
    expiresAt,
  });
  return { linkId: id, url: tokenUrl(token), expiresAt: expiresAt.toISOString() };
}

export async function passwordResetAdminRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);
  const adminOnly = [rawApp.authenticate, rawApp.authorize('admin')];

  // ──────────── Состояние по всем пользователям ────────────
  //
  // Только метаданные: ни токенов, ни готовых URL. Держать ключи от всех
  // аккаунтов сразу в памяти браузера и в кэше React Query незачем — ссылку
  // отдаёт reveal, по одной и под запись в аудит.
  app.get(
    '/api/v1/admin/password-resets',
    {
      preHandler: adminOnly,
      schema: { response: { 200: PasswordResetStateListResponseSchema } },
    },
    async () => {
      // Строка нужна и когда есть только заявка (админ ещё не выписал ссылку),
      // и когда есть только ссылка (выписал по звонку, без заявки), поэтому
      // full join, а не выборка от одной из таблиц.
      const rows = await app.db.execute<{
        user_id: string;
        request_id: string | null;
        requested_at: Date | null;
        link_id: string | null;
        link_expires_at: Date | null;
        link_alive: boolean | null;
      }>(sql`
        SELECT coalesce(r.user_id, t.user_id) AS user_id,
               r.id                            AS request_id,
               r.created_at                    AS requested_at,
               t.id                            AS link_id,
               t.expires_at                    AS link_expires_at,
               (t.id IS NOT NULL AND t.expires_at > now()) AS link_alive
          FROM (SELECT id, user_id, created_at
                  FROM ${passwordResetRequests}
                 WHERE resolved_at IS NULL) r
          FULL JOIN (SELECT id, user_id, expires_at
                       FROM ${passwordResetTokens}
                      WHERE used_at IS NULL AND revoked_at IS NULL) t
            ON t.user_id = r.user_id
      `);

      return {
        items: rows.map((r) => ({
          userId: r.user_id,
          requestId: r.request_id,
          requestedAt: r.requested_at ? new Date(r.requested_at).toISOString() : null,
          linkId: r.link_id,
          linkExpiresAt: r.link_expires_at ? new Date(r.link_expires_at).toISOString() : null,
          hasActiveLink: r.link_alive === true,
        })),
      };
    },
  );

  // ──────────── Выдать ссылку ────────────
  //
  // Идемпотентно: если живая ссылка уже есть, возвращаем её же. Иначе два
  // параллельных клика дали бы гонку, в которой первый ответ — уже отозванная
  // ссылка: второй запрос дождался блокировки, погасил первую и выдал новую, а
  // админ успел скопировать мёртвую.
  app.post(
    '/api/v1/admin/users/:id/password-reset-link',
    {
      preHandler: adminOnly,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: PasswordResetLinkSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const adminId = req.user!.id;
      const result = await app.db.transaction(async (tx) => {
        // Блокировка строки пользователя сериализует параллельные выдачи: без
        // неё оба запроса дошли бы до вставки и столкнулись на уникальном
        // индексе одной открытой ссылки.
        const [target] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, req.params.id))
          .for('update')
          .limit(1);
        if (!target) return null;

        const [alive] = await tx
          .select({
            id: passwordResetTokens.id,
            tokenEncrypted: passwordResetTokens.tokenEncrypted,
            expiresAt: passwordResetTokens.expiresAt,
          })
          .from(passwordResetTokens)
          .where(
            and(
              eq(passwordResetTokens.userId, target.id),
              activeToken,
              sql`${passwordResetTokens.expiresAt} > now()`,
            ),
          )
          .limit(1);
        if (alive) {
          const token = decryptField(
            alive.tokenEncrypted,
            buildAad('password_reset_tokens', alive.id),
          );
          return {
            linkId: alive.id,
            url: tokenUrl(token),
            expiresAt: alive.expiresAt.toISOString(),
          };
        }

        return issueLink(tx, target.id, adminId);
      });

      if (!result) return reply.code(404).send({ error: 'not_found' });
      await app.db.insert(authEvents).values({
        userId: req.params.id,
        event: 'password_reset_link_issued',
        ip: req.ip,
        meta: { adminId },
      });
      return result;
    },
  );

  // ──────────── Выписать новую взамен конкретной ────────────
  //
  // Идентификатор в пути работает как OCC-версия (ср. baseVersion у приёмок):
  // повторный клик придёт с уже отозванным id и получит 409, вместо того чтобы
  // молча наплодить ссылок.
  app.post(
    '/api/v1/admin/password-resets/:id/rotate',
    {
      preHandler: adminOnly,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: PasswordResetLinkSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const adminId = req.user!.id;
      const outcome = await app.db.transaction(async (tx) => {
        const [current] = await tx
          .select({ id: passwordResetTokens.id, userId: passwordResetTokens.userId })
          .from(passwordResetTokens)
          .where(eq(passwordResetTokens.id, req.params.id))
          .limit(1);
        if (!current) return { status: 'not_found' as const };

        // Гасим ИМЕННО ту ссылку, которую видел админ. Ноль затронутых строк
        // означает, что её уже отозвал или использовал кто-то другой.
        const [revoked] = await tx
          .update(passwordResetTokens)
          .set({ revokedAt: sql`now()` })
          .where(and(eq(passwordResetTokens.id, req.params.id), activeToken))
          .returning({ id: passwordResetTokens.id });
        if (!revoked) return { status: 'stale' as const };

        return { status: 'ok' as const, link: await issueLink(tx, current.userId, adminId) };
      });

      if (outcome.status === 'not_found') return reply.code(404).send({ error: 'not_found' });
      if (outcome.status === 'stale') {
        return reply
          .code(409)
          .send({ error: 'link_already_replaced', message: 'Ссылка уже отозвана или использована' });
      }
      return outcome.link;
    },
  );

  // ──────────── Показать ссылку повторно ────────────
  app.post(
    '/api/v1/admin/password-resets/:id/reveal',
    {
      preHandler: adminOnly,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: PasswordResetLinkSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [row] = await app.db
        .select({
          id: passwordResetTokens.id,
          tokenEncrypted: passwordResetTokens.tokenEncrypted,
          expiresAt: passwordResetTokens.expiresAt,
        })
        .from(passwordResetTokens)
        .where(
          and(
            eq(passwordResetTokens.id, req.params.id),
            activeToken,
            sql`${passwordResetTokens.expiresAt} > now()`,
          ),
        )
        .limit(1);
      // Мёртвую ссылку не показываем: она всё равно бесполезна, а лишний показ
      // секрета — лишний след.
      if (!row) return reply.code(404).send({ error: 'not_found' });

      // Кто и когда смотрел ссылку — часть аудита: показ равносилен выдаче
      // доступа к учётной записи.
      await app.db.insert(authEvents).values({
        userId: null,
        event: 'password_reset_link_revealed',
        ip: req.ip,
        meta: { adminId: req.user!.id, linkId: row.id },
      });

      const token = decryptField(row.tokenEncrypted, buildAad('password_reset_tokens', row.id));
      return { linkId: row.id, url: tokenUrl(token), expiresAt: row.expiresAt.toISOString() };
    },
  );

  // ──────────── Отозвать ссылку ────────────
  //
  // POST, а не DELETE: строка остаётся для аудита, удаления не происходит.
  app.post(
    '/api/v1/admin/password-resets/:id/revoke',
    {
      preHandler: adminOnly,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: PasswordResetOkResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const [revoked] = await app.db
        .update(passwordResetTokens)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(passwordResetTokens.id, req.params.id), activeToken))
        .returning({ id: passwordResetTokens.id });
      if (!revoked) return reply.code(404).send({ error: 'not_found' });
      await app.db.insert(authEvents).values({
        userId: null,
        event: 'password_reset_link_revoked',
        ip: req.ip,
        meta: { adminId: req.user!.id, linkId: revoked.id },
      });
      return { ok: true as const };
    },
  );

  // ──────────── Закрыть заявку, не выдавая ссылку ────────────
  //
  // Для случая «человек вспомнил пароль сам»: иначе тег «Запросил сброс» висел
  // бы в таблице до следующего его входа.
  app.post(
    '/api/v1/admin/password-resets/requests/:id/close',
    {
      preHandler: adminOnly,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: PasswordResetOkResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const [closed] = await app.db
        .update(passwordResetRequests)
        .set({ resolvedAt: sql`now()`, resolvedByUserId: req.user!.id })
        .where(
          and(eq(passwordResetRequests.id, req.params.id), isNull(passwordResetRequests.resolvedAt)),
        )
        .returning({ id: passwordResetRequests.id });
      if (!closed) return reply.code(404).send({ error: 'not_found' });
      return { ok: true as const };
    },
  );
}
