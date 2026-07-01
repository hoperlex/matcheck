import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { verifyAccessToken, type AccessTokenClaims } from '../domain/auth/jwt.js';
import { users, sessions, unauthorizedAccessLog } from '../db/schema.js';
import { ACCESS_COOKIE_NAME } from '../domain/auth/refresh.js';

export type AuthUser = {
  id: string;
  role: 'admin' | 'manager' | 'inspector_kpp';
  // Привязка к объекту. У inspector_kpp определяет область видимости;
  // читаем из БД на каждом запросе, чтобы смена объекта применялась
  // моментально без перевыпуска токена.
  siteId: string | null;
  sessionId: string;
};

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authorize: (
      ...roles: AuthUser['role'][]
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const PUBLIC_PATHS = new Set([
  '/health',
  '/api/v1/auth/login',
  '/api/v1/auth/register',
  '/api/v1/auth/refresh',
]);

export default fp(async (app) => {
  async function logUnauthorized(
    req: FastifyRequest,
    statusCode: number,
    errorMessage: string,
    userId?: string,
  ) {
    try {
      await app.db.insert(unauthorizedAccessLog).values({
        userId: userId ?? null,
        statusCode,
        method: req.method,
        path: req.url,
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
        errorMessage,
      });
    } catch (err) {
      app.log.warn({ err }, 'failed to write unauthorized_access_log');
    }
  }

  async function attachUser(req: FastifyRequest): Promise<AuthUser | null> {
    // Основной источник — Authorization: Bearer <jwt>. Fallback на cookie нужен
    // только для клиентов, которые не умеют выставлять заголовок (нативный
    // EventSource, например, для SSE на /api/v1/events).
    const header = req.headers.authorization;
    let token: string | undefined;
    if (header?.startsWith('Bearer ')) {
      token = header.slice(7);
    } else {
      const cookieToken = req.cookies[ACCESS_COOKIE_NAME];
      if (cookieToken) token = cookieToken;
    }
    if (!token) return null;
    try {
      const claims: AccessTokenClaims = await verifyAccessToken(token);
      const [session] = await app.db
        .select({
          id: sessions.id,
          invalidatedAt: sessions.invalidatedAt,
          userId: sessions.userId,
        })
        .from(sessions)
        .where(eq(sessions.id, claims.sid))
        .limit(1);
      if (!session || session.invalidatedAt) return null;

      const [user] = await app.db
        .select({
          id: users.id,
          role: users.role,
          isActive: users.isActive,
          siteId: users.siteId,
          sessionsInvalidatedAt: users.sessionsInvalidatedAt,
          passwordChangedAt: users.passwordChangedAt,
        })
        .from(users)
        .where(eq(users.id, claims.sub))
        .limit(1);
      if (!user || !user.isActive) return null;
      // Инвалидация сессий при смене пароля: отклоняем токены, ВЫДАННЫЕ ДО
      // момента sessionsInvalidatedAt. Сравниваем со временем выпуска токена
      // (iat, секунды), а НЕ с «сейчас» — иначе свежий токен, полученный при
      // входе новым паролем, тоже отклонялся бы первые ~60с после смены
      // (баг: «сменил пароль → не могу войти»). Запас 1с — на округление iat
      // вниз до секунды, чтобы вход в ту же секунду, что и смена, не отвергался.
      if (
        user.sessionsInvalidatedAt &&
        claims.iat != null &&
        claims.iat * 1000 < user.sessionsInvalidatedAt.getTime() - 1000
      ) {
        return null;
      }
      return { id: user.id, role: user.role, siteId: user.siteId, sessionId: claims.sid };
    } catch {
      return null;
    }
  }

  app.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await attachUser(req);
    if (!user) {
      await logUnauthorized(req, 401, 'invalid_or_missing_token');
      reply.code(401).send({ error: 'unauthorized', message: 'Authentication required' });
      return;
    }
    req.user = user;
  });

  app.decorate('authorize', (...roles: AuthUser['role'][]) => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.user) {
        await logUnauthorized(req, 401, 'missing_user_after_auth');
        reply.code(401).send({ error: 'unauthorized' });
        return;
      }
      if (!roles.includes(req.user.role)) {
        await logUnauthorized(req, 403, `role_required:${roles.join('|')}`, req.user.id);
        reply.code(403).send({ error: 'forbidden', message: 'Insufficient role' });
        return;
      }
    };
  });

  app.addHook('onRequest', async (req, reply) => {
    if (PUBLIC_PATHS.has(req.url.split('?')[0] ?? '') || req.url.startsWith('/health')) {
      return;
    }
    const user = await attachUser(req);
    if (user) {
      req.user = user;
      return;
    }
    await logUnauthorized(req, 401, 'global_auth_required');
    reply.code(401).send({ error: 'unauthorized' });
  });
});
