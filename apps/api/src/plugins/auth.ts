import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { verifyAccessToken, type AccessTokenClaims } from '../domain/auth/jwt.js';
import { users, sessions, unauthorizedAccessLog } from '../db/schema.js';
import { ACCESS_COOKIE_NAME } from '../domain/auth/refresh.js';

export type AuthUser = {
  id: string;
  role: 'admin' | 'manager' | 'inspector_kpp' | 'contractor' | 'monitor';
  // Привязка к объекту. У inspector_kpp определяет область видимости;
  // читаем из БД на каждом запросе, чтобы смена объекта применялась
  // моментально без перевыпуска токена.
  siteId: string | null;
  // Привязка к подрядчику (id из справочника customer_counterparties).
  // У роли contractor определяет область видимости (свои приёмки/отгрузки/
  // документы по всем объектам). Читаем из БД на каждом запросе — как siteId.
  contractorCustomerId: string | null;
  sessionId: string;
};

/**
 * Метка со списком ролей на функции-страже, которую возвращает app.authorize.
 *
 * Symbol, а не обычное поле: страж — обычный preHandler, и случайное совпадение
 * имён с чужим свойством дало бы неверный инвентарь прав.
 */
export const ALLOWED_ROLES = Symbol.for('matcheck.authorize.roles');

export type AuthorizeGuard = ((req: FastifyRequest, reply: FastifyReply) => Promise<void>) & {
  [ALLOWED_ROLES]?: AuthUser['role'][];
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
    /**
     * Запись отказа в unauthorized_access_log. Вынесена наружу, чтобы
     * плагин прав писал свои 403 в тот же журнал: расследование инцидента
     * «пользователь не может работать» должно смотреть в одно место.
     */
    logUnauthorized: (
      req: FastifyRequest,
      statusCode: number,
      errorMessage: string,
      userId?: string,
    ) => Promise<void>;
  }
}

const PUBLIC_PATHS = new Set([
  '/health',
  '/api/v1/auth/login',
  '/api/v1/auth/register',
  '/api/v1/auth/refresh',
]);

/**
 * Namespace роутов, открытых без авторизации.
 *
 * Отсутствие `preHandler: app.authenticate` роут публичным НЕ делает: ниже
 * висит глобальный onRequest-хук, который режет всё, чего нет в этом списке.
 * Поэтому каждый публичный вход обязан лежать под этим префиксом — и весь
 * публичный периметр проверяется одним grep по 'api/v1/public'.
 */
const PUBLIC_ROUTE_PREFIX = '/api/v1/public/';

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
          contractorCustomerId: users.contractorCustomerId,
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
      return {
        id: user.id,
        role: user.role,
        siteId: user.siteId,
        contractorCustomerId: user.contractorCustomerId,
        sessionId: claims.sid,
      };
    } catch {
      return null;
    }
  }

  app.decorate('logUnauthorized', logUnauthorized);

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
    const guard = async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.user) {
        await logUnauthorized(req, 401, 'missing_user_after_auth');
        reply.code(401).send({ error: 'unauthorized' });
        return;
      }
      // Право на этот маршрут выдано матрицей сверх дефолта роли — allow-list
      // не применяем. Отметку ставит плагин прав, и только для явного
      // расширения: на дефолтных правах маршрут по-прежнему защищён списком
      // ролей, иначе выдача одной ячейки открыла бы и соседние маршруты с
      // более узким доступом.
      if (req.permissionExpanded) return;
      if (!roles.includes(req.user.role)) {
        await logUnauthorized(req, 403, `role_required:${roles.join('|')}`, req.user.id);
        reply.code(403).send({ error: 'forbidden', message: 'Insufficient role' });
        return;
      }
    };
    // Список ролей вешаем на саму функцию-страж: по нему onRoute-хук плагина
    // прав строит рантайм-инвентарь «маршрут → allow-list». Альтернатива —
    // продублировать роли в реестре прав — разъезжалась бы с роутами молча:
    // достаточно поменять authorize у одного роута и забыть про вторую копию.
    (guard as AuthorizeGuard)[ALLOWED_ROLES] = roles;
    return guard;
  });

  app.addHook('onRequest', async (req, reply) => {
    // Матчим ШАБЛОН роута, а не сырой req.url: сырой можно подделать
    // (`/api/v1/public/../sites`), шаблон выдаёт роутер уже после матчинга.
    // На 404 routeOptions.url отсутствует — поведение прежнее, 401.
    // req.user при этом НЕ заполняется: залогиненный пользователь, открывший
    // публичную страницу, не получает на ней скрытых привилегий.
    if (req.routeOptions?.url?.startsWith(PUBLIC_ROUTE_PREFIX)) {
      return;
    }
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
