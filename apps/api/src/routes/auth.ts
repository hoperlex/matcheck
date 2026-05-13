import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { asZod } from '../lib/fastify.js';
import {
  LoginRequestSchema,
  LoginResponseSchema,
  RefreshResponseSchema,
  RegisterRequestSchema,
  RegisterResponseSchema,
  UserDtoSchema,
  ErrorResponseSchema,
} from '@matcheck/contracts';
import { users, authEvents } from '../db/schema.js';
import { hashPassword, verifyPassword, checkPasswordStrength } from '../domain/auth/password.js';
import { signAccessToken } from '../domain/auth/jwt.js';
import {
  createSessionAndRefresh,
  refreshCookieOptions,
  rotateRefreshToken,
  REFRESH_COOKIE_NAME,
  revokeByToken,
  revokeBySessionId,
} from '../domain/auth/refresh.js';
import { sha256Hex } from '../domain/auth/crypto.js';
import { loadEnv } from '../lib/env.js';

const env = loadEnv();

function userToDto(u: {
  id: string;
  email: string;
  role: 'admin' | 'manager' | 'inspector_kpp';
  isActive: boolean;
  createdAt: Date;
}) {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    isActive: u.isActive,
    createdAt: u.createdAt.toISOString(),
  };
}

async function backoffSleep(failed: number) {
  if (failed <= 0) return;
  const ms = Math.min(30_000, 1000 * 2 ** Math.min(failed - 1, 5));
  await new Promise((r) => setTimeout(r, ms));
}

export async function authRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);
  app.post(
    '/api/v1/auth/register',
    {
      config: { rateLimit: { max: 3, timeWindow: '1 hour' } },
      schema: {
        body: RegisterRequestSchema,
        response: {
          200: RegisterResponseSchema,
          400: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { email, password } = req.body;
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
      const [created] = await app.db
        .insert(users)
        .values({ email, passwordHash, role: 'manager', isActive: false })
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
      config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
      schema: {
        body: LoginRequestSchema,
        response: { 200: LoginResponseSchema, 401: ErrorResponseSchema, 423: ErrorResponseSchema },
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

      reply.setCookie(REFRESH_COOKIE_NAME, refresh.token, refreshCookieOptions());
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
      const presented = req.cookies[REFRESH_COOKIE_NAME];
      if (!presented) {
        return reply.code(401).send({ error: 'no_refresh' });
      }
      const result = await rotateRefreshToken(
        presented,
        req.ip,
        req.headers['user-agent'] ?? undefined,
      );
      if (!result) {
        reply.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions());
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
      reply.setCookie(REFRESH_COOKIE_NAME, result.newToken, refreshCookieOptions());
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
}
