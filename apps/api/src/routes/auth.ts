import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq, and, ne, isNull } from 'drizzle-orm';
import { asZod } from '../lib/fastify.js';
import {
  ChangePasswordRequestSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  RefreshResponseSchema,
  RegisterRequestSchema,
  RegisterResponseSchema,
  UpdateProfileRequestSchema,
  UserDtoSchema,
  ErrorResponseSchema,
} from '@matcheck/contracts';
import { users, authEvents, sessions } from '../db/schema.js';
import { hashPassword, verifyPassword, checkPasswordStrength } from '../domain/auth/password.js';
import { signAccessToken } from '../domain/auth/jwt.js';
import {
  createSessionAndRefresh,
  refreshCookieOptions,
  legacyRefreshCookieOptions,
  rotateRefreshToken,
  REFRESH_COOKIE_NAME,
  ACCESS_COOKIE_NAME,
  accessCookieOptions,
  revokeByToken,
  revokeBySessionId,
} from '../domain/auth/refresh.js';
import { sha256Hex } from '../domain/auth/crypto.js';
import { loadEnv } from '../lib/env.js';
import { createBurstyRateLimit } from '../lib/auth-rate-limit.js';

const env = loadEnv();

function userToDto(u: {
  id: string;
  email: string;
  role: 'admin' | 'manager' | 'inspector_kpp' | 'contractor' | 'monitor';
  isActive: boolean;
  siteId: string | null;
  contractorCustomerId: string | null;
  phone: string | null;
  fullName: string | null;
  createdAt: Date;
}) {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    isActive: u.isActive,
    siteId: u.siteId,
    contractorCustomerId: u.contractorCustomerId,
    phone: u.phone,
    fullName: u.fullName,
    createdAt: u.createdAt.toISOString(),
  };
}

async function backoffSleep(failed: number) {
  if (failed <= 0) return;
  const ms = Math.min(30_000, 1000 * 2 ** Math.min(failed - 1, 5));
  await new Promise((r) => setTimeout(r, ms));
}

// Mobile-клиенты (Android/iOS) не могут хранить HttpOnly-cookie между запросами,
// поэтому при заголовке X-Client-Type: mobile отдаём refresh-token в теле ответа
// и не ставим cookies. Веб остаётся на cookie-flow без изменений.
function isMobileClient(req: FastifyRequest): boolean {
  return req.headers['x-client-type'] === 'mobile';
}

function refreshExpiresInSeconds(expiresAt: Date): number {
  return Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
}

function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  const token = m?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

export async function authRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);
  app.post(
    '/api/v1/auth/register',
    {
      preHandler: createBurstyRateLimit({
        burst: 5,
        burstWindowSec: 900,
        slowWindowSec: 60,
        keyPrefix: 'register',
        noun: 'регистрации',
      }),
      schema: {
        body: RegisterRequestSchema,
        response: {
          200: RegisterResponseSchema,
          400: ErrorResponseSchema,
          409: ErrorResponseSchema,
          429: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { email, password, fullName } = req.body;
      const check = await checkPasswordStrength(password, email);
      if (!check.ok) {
        return reply.code(400).send({
          error: 'weak_password',
          message: 'Password does not meet requirements',
          details: check,
        });
      }
      const [existing] = await app.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      if (existing) {
        return reply.code(409).send({ error: 'email_taken', message: 'Email already registered' });
      }
      const passwordHash = await hashPassword(password);
      const trimmedFullName = fullName?.trim() || null;
      const [created] = await app.db
        .insert(users)
        .values({
          email,
          passwordHash,
          role: 'manager',
          isActive: false,
          fullName: trimmedFullName,
        })
        .returning();
      if (!created) throw new Error('Failed to create user');
      await app.db.insert(authEvents).values({
        userId: created.id,
        event: 'user_registered',
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return { ok: true as const, user: userToDto(created) };
    },
  );

  app.post(
    '/api/v1/auth/login',
    {
      preHandler: createBurstyRateLimit({
        burst: 5,
        burstWindowSec: 900,
        slowWindowSec: 60,
        keyPrefix: 'login',
        noun: 'входа',
      }),
      schema: {
        body: LoginRequestSchema,
        response: {
          200: LoginResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          423: ErrorResponseSchema,
          429: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { email, password } = req.body;
      const [user] = await app.db.select().from(users).where(eq(users.email, email)).limit(1);

      if (user?.lockedUntil && user.lockedUntil > new Date()) {
        await app.db.insert(authEvents).values({
          userId: user.id,
          event: 'login_blocked_locked',
          ip: req.ip,
        });
        return reply
          .code(423)
          .send({ error: 'account_locked', message: 'Account temporarily locked' });
      }

      const ok = await verifyPassword(password, user?.passwordHash ?? null);
      if (!user || !ok) {
        const failed = (user?.failedLoginCount ?? 0) + 1;
        await backoffSleep(failed);
        if (user) {
          const lockedUntil = failed >= 10 ? new Date(Date.now() + 30 * 60_000) : null;
          await app.db
            .update(users)
            .set({ failedLoginCount: failed, lockedUntil })
            .where(eq(users.id, user.id));
          await app.db.insert(authEvents).values({
            userId: user.id,
            event: 'login_failure',
            ip: req.ip,
            userAgent: req.headers['user-agent'] ?? null,
          });
        } else {
          await app.db.insert(authEvents).values({
            emailHash: sha256Hex(email),
            event: 'login_failure',
            ip: req.ip,
            userAgent: req.headers['user-agent'] ?? null,
          });
        }
        return reply
          .code(401)
          .send({ error: 'invalid_credentials', message: 'Invalid email or password' });
      }

      if (!user.isActive) {
        return reply
          .code(401)
          .send({ error: 'account_inactive', message: 'Account is not active' });
      }

      // contractor и monitor — роли только для веб-портала: мобильный клиент их не
      // поддерживает, а мобильный sync для них закрыт. Отклоняем на входе, чтобы
      // web-token такой роли вообще не появлялся у мобильного приложения.
      if (isMobileClient(req) && (user.role === 'contractor' || user.role === 'monitor')) {
        return reply
          .code(403)
          .send({ error: 'web_only_role', message: 'This role is web-only' });
      }

      await app.db
        .update(users)
        .set({ failedLoginCount: 0, lockedUntil: null })
        .where(eq(users.id, user.id));

      const refresh = await createSessionAndRefresh(
        user.id,
        req.ip,
        req.headers['user-agent'] ?? undefined,
      );
      const access = await signAccessToken({
        sub: user.id,
        role: user.role,
        sid: refresh.sessionId,
        aal: 'aal1',
      });

      if (isMobileClient(req)) {
        return {
          accessToken: access,
          expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
          user: userToDto(user),
          refreshToken: refresh.token,
          refreshExpiresIn: refreshExpiresInSeconds(refresh.expiresAt),
        };
      }

      reply.setCookie(REFRESH_COOKIE_NAME, refresh.token, refreshCookieOptions());
      reply.setCookie(ACCESS_COOKIE_NAME, access, accessCookieOptions());
      return {
        accessToken: access,
        expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
        user: userToDto(user),
      };
    },
  );

  app.post(
    '/api/v1/auth/refresh',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: { response: { 200: RefreshResponseSchema, 401: ErrorResponseSchema } },
    },
    async (req, reply) => {
      const mobile = isMobileClient(req);
      const presented = mobile
        ? extractBearerToken(req.headers.authorization)
        : req.cookies[REFRESH_COOKIE_NAME];
      if (!presented) {
        return reply.code(401).send({ error: 'no_refresh' });
      }
      const result = await rotateRefreshToken(
        presented,
        req.ip,
        req.headers['user-agent'] ?? undefined,
      );
      if (!result) {
        if (!mobile) {
          reply.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions());
          reply.clearCookie(REFRESH_COOKIE_NAME, legacyRefreshCookieOptions());
        }
        return reply.code(401).send({ error: 'invalid_refresh' });
      }
      const [user] = await app.db
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, result.userId))
        .limit(1);
      if (!user) return reply.code(401).send({ error: 'invalid_refresh' });

      const access = await signAccessToken({
        sub: result.userId,
        role: user.role,
        sid: result.sessionId,
        aal: 'aal1',
      });

      if (mobile) {
        return {
          accessToken: access,
          expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
          refreshToken: result.newToken,
          refreshExpiresIn: refreshExpiresInSeconds(result.expiresAt),
        };
      }

      reply.clearCookie(REFRESH_COOKIE_NAME, legacyRefreshCookieOptions());
      reply.setCookie(REFRESH_COOKIE_NAME, result.newToken, refreshCookieOptions());
      reply.setCookie(ACCESS_COOKIE_NAME, access, accessCookieOptions());
      return { accessToken: access, expiresIn: env.ACCESS_TOKEN_TTL_SECONDS };
    },
  );

  app.post(
    '/api/v1/auth/logout',
    {
      preHandler: [app.authenticate],
      schema: { response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } } } },
    },
    async (req, reply) => {
      const presented = req.cookies[REFRESH_COOKIE_NAME];
      if (presented) await revokeByToken(presented);
      else if (req.user) await revokeBySessionId(req.user.sessionId);
      reply.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions());
      reply.clearCookie(REFRESH_COOKIE_NAME, legacyRefreshCookieOptions());
      reply.clearCookie(ACCESS_COOKIE_NAME, accessCookieOptions());
      if (req.user) {
        await app.db.insert(authEvents).values({
          userId: req.user.id,
          event: 'logout',
          ip: req.ip,
        });
      }
      return { ok: true };
    },
  );

  app.get(
    '/api/v1/auth/me',
    {
      preHandler: [app.authenticate],
      schema: { response: { 200: UserDtoSchema, 401: ErrorResponseSchema } },
    },
    async (req, reply) => {
      if (!req.user) return reply.code(401).send({ error: 'unauthorized' });
      const [user] = await app.db.select().from(users).where(eq(users.id, req.user.id)).limit(1);
      if (!user) return reply.code(401).send({ error: 'unauthorized' });
      return userToDto(user);
    },
  );

  // Личный кабинет: пользователь правит свой профиль. Сейчас доступно
  // только ФИО — email = логин (требует верификации), роль/объект = задача
  // админа. Пустая строка после trim сохраняется как NULL.
  app.patch(
    '/api/v1/auth/me',
    {
      preHandler: [app.authenticate],
      schema: {
        body: UpdateProfileRequestSchema,
        response: { 200: UserDtoSchema, 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      if (!req.user) return reply.code(401).send({ error: 'unauthorized' });
      const trimmedName = req.body.fullName?.trim() || null;
      // phone отсутствует в body → не трогаем поле. Пустая строка после
      // trim → null (мобила различает «нет контакта» именно по null,
      // см. PhoneCell в админке).
      const patch: { fullName: string | null; phone?: string | null; updatedAt: Date } = {
        fullName: trimmedName,
        updatedAt: new Date(),
      };
      if (req.body.phone !== undefined) {
        const trimmedPhone = req.body.phone?.trim() ?? '';
        patch.phone = trimmedPhone.length > 0 ? trimmedPhone : null;
      }
      await app.db.update(users).set(patch).where(eq(users.id, req.user.id));
      const [user] = await app.db.select().from(users).where(eq(users.id, req.user.id)).limit(1);
      if (!user) return reply.code(401).send({ error: 'unauthorized' });
      return userToDto(user);
    },
  );

  // Личный кабинет: смена пароля. Требуем текущий пароль — защита от
  // случая, когда злоумышленник получил активную сессию: без знания
  // текущего пароля он не сможет «угнать» учётку через смену.
  // Все остальные сессии этого юзера инвалидируются через
  // sessionsInvalidatedAt — middleware authenticate проверит и
  // отклонит старые refresh'и.
  app.post(
    '/api/v1/auth/change-password',
    {
      preHandler: [app.authenticate],
      schema: {
        body: ChangePasswordRequestSchema,
        response: {
          200: UserDtoSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) return reply.code(401).send({ error: 'unauthorized' });
      const { currentPassword, newPassword } = req.body;
      const [user] = await app.db.select().from(users).where(eq(users.id, req.user.id)).limit(1);
      if (!user) return reply.code(401).send({ error: 'unauthorized' });
      const ok = await verifyPassword(currentPassword, user.passwordHash);
      if (!ok) {
        await app.db.insert(authEvents).values({
          userId: user.id,
          event: 'password_change_failed',
          ip: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        });
        return reply
          .code(400)
          .send({ error: 'wrong_current_password', message: 'Неверный текущий пароль' });
      }
      const strength = await checkPasswordStrength(newPassword, user.email);
      if (!strength.ok) {
        return reply.code(400).send({
          error: 'weak_password',
          message: 'Новый пароль не отвечает требованиям',
          details: strength,
        });
      }
      const newHash = await hashPassword(newPassword);
      const now = new Date();
      await app.db
        .update(users)
        .set({
          passwordHash: newHash,
          passwordChangedAt: now,
          // Помечаем момент инвалидации: middleware authenticate отклонит
          // все access-токены, ВЫДАННЫЕ ДО этого времени (сравнение по iat,
          // см. plugins/auth.ts). Старый токен текущей сессии тоже протухнет,
          // но фронт прозрачно получит свежий через refresh (его iat > now),
          // поэтому пользователь из текущей вкладки не разлогинивается. Вход
          // новым паролем сразу выдаёт токен с iat > now и работает без
          // 60-секундной задержки (была багом до фикса).
          sessionsInvalidatedAt: now,
          updatedAt: now,
        })
        .where(eq(users.id, user.id));
      // Безопасность: убиваем все ДРУГИЕ сессии пользователя в БД — их
      // access-токены отклонит middleware (session.invalidatedAt), а
      // refresh-токены перестанут обновляться (refresh.ts проверяет тот же
      // флаг). Текущая сессия (req.user.sessionId) остаётся живой, чтобы из
      // активной вкладки пользователя не выбрасывало. Без этого смена пароля
      // не выкидывала бы старые устройства/украденные refresh-сессии.
      await app.db
        .update(sessions)
        .set({ invalidatedAt: now })
        .where(
          and(
            eq(sessions.userId, user.id),
            ne(sessions.id, req.user.sessionId),
            isNull(sessions.invalidatedAt),
          ),
        );
      await app.db.insert(authEvents).values({
        userId: user.id,
        event: 'password_changed',
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      const [updated] = await app.db.select().from(users).where(eq(users.id, user.id)).limit(1);
      if (!updated) return reply.code(401).send({ error: 'unauthorized' });
      return userToDto(updated);
    },
  );
}
