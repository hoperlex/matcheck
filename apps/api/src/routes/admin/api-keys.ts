/**
 * Вкладка «Администрирование → API-доступ»: машинные ключи внешних систем (1С).
 *
 * Только admin: страница в NEVER_GRANTABLE — матрица ролей её не выдаёт даже
 * прямой строкой в БД (lib/permissions/matrix.ts, isAllowed), а маршруты ещё и
 * под authorize('admin').
 *
 * Каждое изменение — одна транзакция вместе с записью журнала (auth_events):
 * сбой журнала откатывает и само изменение, а секрет уходит в ответ только
 * после фиксации. Секрет есть ТОЛЬКО в ответе на создание и «Новый секрет»;
 * в базе его sha256, в списке — ничего.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { desc, eq, sql as drSql } from 'drizzle-orm';
import { z } from 'zod';
import {
  ApiKeyCreateSchema,
  ApiKeyDtoSchema,
  ApiKeyPatchSchema,
  ApiKeyRotateSchema,
  ApiKeySecretResponseSchema,
  ErrorResponseSchema,
  SCOPE_ONEC_ACK,
  SCOPE_ONEC_READ,
  type ApiKeyDto,
} from '@matcheck/contracts';
import type { Db } from '../../db/client.js';
import { authEvents, serviceAccounts, users } from '../../db/schema.js';
import {
  createServiceAccount,
  generateClientSecret,
  revokeServiceAccount,
  rotateServiceAccountSecret,
  ServiceAccountError,
  toApiKeyDto,
  updateServiceAccount,
} from '../../domain/auth/service-accounts.js';
import { asZod } from '../../lib/fastify.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const IdParams = z.object({ id: z.string().uuid() });

const ERROR_STATUS: Record<ServiceAccountError['code'], number> = {
  not_found: 404,
  revoked: 409,
  generation_changed: 409,
  client_id_taken: 409,
  invalid_client_id: 400,
  invalid_scopes: 400,
  invalid_cidr: 400,
};

function sendDomainError(reply: FastifyReply, err: unknown) {
  if (err instanceof ServiceAccountError) {
    return reply.code(ERROR_STATUS[err.code]).send({ error: err.code, message: err.message });
  }
  throw err;
}

async function creatorName(ex: Db | Tx, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [u] = await ex
    .select({ fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return u ? (u.fullName ?? u.email) : null;
}

async function audit(
  tx: Tx,
  req: FastifyRequest,
  event: string,
  meta: Record<string, unknown>,
): Promise<void> {
  // В той же транзакции, что и изменение: журнал не может разойтись с фактом.
  await tx.insert(authEvents).values({
    userId: req.user!.id,
    event,
    ip: req.ip,
    userAgent: req.headers['user-agent'] ?? null,
    meta,
  });
}

const toDate = (v: string | null | undefined): Date | null | undefined =>
  v === undefined ? undefined : v === null ? null : new Date(v);

export async function apiKeyRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);
  const guard = [app.authenticate, app.authorize('admin')];

  app.get(
    '/api/v1/admin/api-keys',
    { preHandler: guard, schema: { response: { 200: z.array(ApiKeyDtoSchema) } } },
    async () => {
      const rows = await app.db
        .select({ key: serviceAccounts, fullName: users.fullName, email: users.email })
        .from(serviceAccounts)
        .leftJoin(users, eq(users.id, serviceAccounts.createdByUserId))
        // Отозванные — внизу, внутри групп — новые сверху.
        .orderBy(drSql`${serviceAccounts.revokedAt} IS NOT NULL`, desc(serviceAccounts.createdAt));
      return rows.map((r) => toApiKeyDto(r.key, r.fullName ?? r.email ?? null));
    },
  );

  app.post(
    '/api/v1/admin/api-keys',
    {
      preHandler: guard,
      schema: {
        body: ApiKeyCreateSchema,
        response: { 201: ApiKeySecretResponseSchema, 400: ErrorResponseSchema, 409: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const secret = generateClientSecret();
      let key: ApiKeyDto;
      try {
        key = await app.db.transaction(async (tx) => {
          const row = await createServiceAccount(tx, {
            name: req.body.name,
            description: req.body.description || null,
            scopes: req.body.allowAck ? [SCOPE_ONEC_READ, SCOPE_ONEC_ACK] : [SCOPE_ONEC_READ],
            expiresAt: toDate(req.body.expiresAt) ?? null,
            createdByUserId: req.user!.id,
            secret,
          });
          await audit(tx, req, 'service_account_created', {
            clientId: row.clientId,
            name: row.name,
            scopes: row.scopes,
            expiresAt: row.expiresAt?.toISOString() ?? null,
          });
          return toApiKeyDto(row, await creatorName(tx, req.user!.id));
        });
      } catch (err) {
        return sendDomainError(reply, err);
      }
      reply.code(201);
      return { key, clientSecret: secret };
    },
  );

  app.patch(
    '/api/v1/admin/api-keys/:id',
    {
      preHandler: guard,
      schema: {
        params: IdParams,
        body: ApiKeyPatchSchema,
        response: { 200: ApiKeyDtoSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      try {
        return await app.db.transaction(async (tx) => {
          const { row, changed } = await updateServiceAccount(tx, req.params.id, {
            name: req.body.name,
            description: req.body.description,
            allowAck: req.body.allowAck,
            expiresAt: toDate(req.body.expiresAt),
          });
          if (changed.length > 0) {
            await audit(tx, req, 'service_account_updated', {
              clientId: row.clientId,
              changed,
              scopes: row.scopes,
              expiresAt: row.expiresAt?.toISOString() ?? null,
            });
          }
          return toApiKeyDto(row, await creatorName(tx, row.createdByUserId));
        });
      } catch (err) {
        return sendDomainError(reply, err);
      }
    },
  );

  app.post(
    '/api/v1/admin/api-keys/:id/rotate-secret',
    {
      preHandler: guard,
      schema: {
        params: IdParams,
        body: ApiKeyRotateSchema,
        response: { 200: ApiKeySecretResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const secret = generateClientSecret();
      try {
        const key = await app.db.transaction(async (tx) => {
          const row = await rotateServiceAccountSecret(tx, req.params.id, {
            secret,
            expectedGeneration: req.body.expectedGeneration,
          });
          await audit(tx, req, 'service_account_secret_rotated', {
            clientId: row.clientId,
            generation: row.secretGeneration,
          });
          return toApiKeyDto(row, await creatorName(tx, row.createdByUserId));
        });
        return { key, clientSecret: secret };
      } catch (err) {
        return sendDomainError(reply, err);
      }
    },
  );

  app.post(
    '/api/v1/admin/api-keys/:id/revoke',
    {
      preHandler: guard,
      schema: {
        params: IdParams,
        response: { 200: ApiKeyDtoSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      try {
        return await app.db.transaction(async (tx) => {
          const { row, changed } = await revokeServiceAccount(tx, req.params.id);
          // Повторный отзыв — без второго события: revoked_at прежний.
          if (changed) await audit(tx, req, 'service_account_revoked', { clientId: row.clientId });
          return toApiKeyDto(row, await creatorName(tx, row.createdByUserId));
        });
      } catch (err) {
        return sendDomainError(reply, err);
      }
    },
  );
}
