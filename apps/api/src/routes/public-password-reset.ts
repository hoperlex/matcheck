import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  EmailSchema,
  ErrorResponseSchema,
  PasswordResetConsumeRequestSchema,
  PasswordResetConsumeResponseSchema,
  PasswordResetInspectRequestSchema,
  PasswordResetInspectResponseSchema,
  PasswordResetRequestResponseSchema,
  PasswordResetRequestSchema,
} from '@matcheck/contracts';
import { asZod } from '../lib/fastify.js';
import { authEvents, passwordResetRequests, passwordResetTokens, users } from '../db/schema.js';
import { sha256Hex } from '../domain/auth/crypto.js';
import { checkPasswordStrength, hashPassword } from '../domain/auth/password.js';
import { applyPasswordHash } from '../domain/auth/apply-password.js';
import { createBurstyRateLimit } from '../lib/auth-rate-limit.js';
import { withMinimumDuration } from '../lib/constant-time.js';

/**
 * Публичная часть сброса пароля. Три входа, все под /api/v1/public/ — именно
 * этот префикс пропускает глобальный guard в plugins/auth.ts.
 *
 * Токен НИГДЕ не ездит в пути: ссылка выглядит как /reset-password#<token>,
 * фрагмент не уходит на сервер вообще, а сюда токен приходит в теле. Тела
 * Sentry маскирует по ключу `token`, пути — нет; плюс путь оседает в истории
 * браузера и заголовке Referer.
 */

function hashedBodyKey(field: 'email' | 'token') {
  return (req: FastifyRequest): string | null => {
    const body = req.body as Record<string, unknown> | undefined;
    const raw = body?.[field];
    if (typeof raw !== 'string' || raw.length === 0) return null;
    // Email нормализуем той же схемой, что и на входе: иначе ' A@b.ru ' и
    // 'a@b.ru' считались бы разными клиентами и лимит обходился бы регистром.
    const normalized = field === 'email' ? (EmailSchema.safeParse(raw).data ?? raw) : raw;
    // В Redis уходит только хэш: ключи лимитера живут часами, и email с
    // токеном там лежать не должны.
    return sha256Hex(normalized);
  };
}

export async function publicPasswordResetRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);

  // ──────────── Заявка: «Забыли пароль?» на экране входа ────────────
  //
  // Ссылку НЕ создаёт — только поднимает в админке флаг «человек просит сброс».
  // Иначе любой, кто знает чужой email, дёргая эту форму, бесконечно обнулял бы
  // уже отправленную человеку ссылку.
  app.post(
    '/api/v1/public/password-reset/request',
    {
      preHandler: [
        createBurstyRateLimit({
          burst: 5,
          burstWindowSec: 900,
          slowWindowSec: 60,
          keyPrefix: 'reset-req-ip',
          noun: 'сброса пароля',
        }),
        createBurstyRateLimit({
          burst: 3,
          burstWindowSec: 3600,
          slowWindowSec: 3600,
          keyPrefix: 'reset-req-email',
          noun: 'сброса пароля',
          keyOf: hashedBodyKey('email'),
        }),
      ],
      schema: {
        body: PasswordResetRequestSchema,
        response: {
          200: PasswordResetRequestResponseSchema,
          429: ErrorResponseSchema,
        },
      },
    },
    async (req) => {
      const { email } = req.body;
      // Ответ одинаков для существующего и неизвестного email, и время ответа
      // тоже: без выравнивания разница в задержке сама по себе перечисляет
      // сотрудников — известный email делает запись в БД, неизвестный нет.
      await withMinimumDuration(async () => {
        const [user] = await app.db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, email))
          .limit(1);

        if (user) {
          // Повторное нажатие обновляет дату существующей заявки, а не плодит
          // строки: на (user_id) WHERE resolved_at IS NULL висит уникальность.
          await app.db
            .insert(passwordResetRequests)
            .values({ userId: user.id })
            .onConflictDoUpdate({
              target: passwordResetRequests.userId,
              targetWhere: isNull(passwordResetRequests.resolvedAt),
              set: { createdAt: sql`now()` },
            });
        }
        // Событие пишем в обеих ветках: и для аудита, и чтобы объём работы по
        // существующему и неизвестному email отличался как можно меньше.
        await app.db.insert(authEvents).values({
          userId: user?.id ?? null,
          emailHash: user ? null : sha256Hex(email),
          event: 'password_reset_requested',
          ip: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        });
      });

      return { ok: true as const };
    },
  );

  // ──────────── Проверка ссылки перед вводом пароля ────────────
  //
  // Нужна, чтобы человек видел, чей пароль меняет (ссылку ему переслали в
  // мессенджере), и чтобы протухшая ссылка сообщала об этом сразу, а не после
  // того, как он придумает пароль.
  app.post(
    '/api/v1/public/password-reset/inspect',
    {
      preHandler: [
        createBurstyRateLimit({
          burst: 30,
          burstWindowSec: 60,
          slowWindowSec: 60,
          keyPrefix: 'reset-inspect-ip',
          noun: 'сброса пароля',
        }),
        createBurstyRateLimit({
          burst: 10,
          burstWindowSec: 3600,
          slowWindowSec: 3600,
          keyPrefix: 'reset-inspect-token',
          noun: 'сброса пароля',
          keyOf: hashedBodyKey('token'),
        }),
      ],
      schema: {
        body: PasswordResetInspectRequestSchema,
        response: {
          200: PasswordResetInspectResponseSchema,
          404: ErrorResponseSchema,
          429: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [row] = await app.db
        .select({ email: users.email })
        .from(passwordResetTokens)
        .innerJoin(users, eq(users.id, passwordResetTokens.userId))
        .where(
          and(
            eq(passwordResetTokens.tokenHash, sha256Hex(req.body.token)),
            isNull(passwordResetTokens.usedAt),
            isNull(passwordResetTokens.revokedAt),
            sql`${passwordResetTokens.expiresAt} > now()`,
          ),
        )
        .limit(1);

      // Один и тот же ответ на «нет такой ссылки», «уже использована»,
      // «отозвана» и «протухла»: подробности помогли бы только перебору.
      if (!row) {
        return reply.code(404).send({ error: 'invalid_token', message: 'Ссылка недействительна' });
      }
      return { email: row.email };
    },
  );

  // ──────────── Установка нового пароля ────────────
  app.post(
    '/api/v1/public/password-reset/consume',
    {
      preHandler: [
        createBurstyRateLimit({
          burst: 10,
          burstWindowSec: 900,
          slowWindowSec: 60,
          keyPrefix: 'reset-consume-ip',
          noun: 'сброса пароля',
        }),
        createBurstyRateLimit({
          burst: 5,
          burstWindowSec: 3600,
          slowWindowSec: 3600,
          keyPrefix: 'reset-consume-token',
          noun: 'сброса пароля',
          keyOf: hashedBodyKey('token'),
        }),
      ],
      schema: {
        body: PasswordResetConsumeRequestSchema,
        response: {
          200: PasswordResetConsumeResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          429: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const tokenHash = sha256Hex(req.body.token);

      // Предварительная проверка — ТОЛЬКО чтобы не считать bcrypt зря и сразу
      // отвечать по мёртвой ссылке. Ничего не гарантирует: решает захват строки
      // ниже.
      const [candidate] = await app.db
        .select({ id: passwordResetTokens.id })
        .from(passwordResetTokens)
        .where(
          and(
            eq(passwordResetTokens.tokenHash, tokenHash),
            isNull(passwordResetTokens.usedAt),
            isNull(passwordResetTokens.revokedAt),
            sql`${passwordResetTokens.expiresAt} > now()`,
          ),
        )
        .limit(1);
      if (!candidate) {
        return reply.code(404).send({ error: 'invalid_token', message: 'Ссылка недействительна' });
      }

      // Дорогие операции — ДО транзакции. checkPasswordStrength ходит в базу
      // утечек с таймаутом 3 секунды, bcrypt при cost 12 занимает сотни
      // миллисекунд: держать на этом соединение и блокировку строки нельзя.
      const strength = await checkPasswordStrength(req.body.newPassword);
      if (!strength.ok) {
        return reply.code(400).send({
          error: 'weak_password',
          message: 'Пароль не отвечает требованиям',
          details: strength,
        });
      }
      const passwordHash = await hashPassword(req.body.newPassword);

      const applied = await app.db.transaction(async (tx) => {
        // Атомарный захват: WHERE отсекает уже использованные, отозванные и
        // протухшие. Два параллельных запроса одним токеном — строку получит
        // ровно один, второму вернётся пусто.
        const [claimed] = await tx
          .update(passwordResetTokens)
          .set({ usedAt: sql`now()` })
          .where(
            and(
              eq(passwordResetTokens.tokenHash, tokenHash),
              isNull(passwordResetTokens.usedAt),
              isNull(passwordResetTokens.revokedAt),
              sql`${passwordResetTokens.expiresAt} > now()`,
            ),
          )
          .returning({ userId: passwordResetTokens.userId });
        if (!claimed) return false;

        // В той же транзакции: упадёт здесь — откатится и usedAt, ссылка не
        // сгорит впустую.
        await applyPasswordHash(tx, claimed.userId, passwordHash, {
          event: 'password_reset_used',
          ip: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        });
        return true;
      });

      if (!applied) {
        return reply.code(404).send({ error: 'invalid_token', message: 'Ссылка недействительна' });
      }
      // Автоматического входа нет намеренно: человек должен убедиться, что
      // новый пароль работает, и он мог менять его не на своём устройстве.
      return { ok: true as const };
    },
  );
}
