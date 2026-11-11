/**
 * Выдача machine-токена внешней системе (docs/fin_auth.md §2,
 * client_credentials). Лежит под /api/v1/public/ — единственным префиксом,
 * открытым без пользователя (plugins/auth.ts): получить токен можно только
 * знанием секрета учётки.
 *
 * Рубильник ONEC_INTEGRATION_ENABLED закрывает и выдачу: при 0 канал закрыт
 * целиком, а не только маршруты с токеном.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  ErrorResponseSchema,
  IntegrationTokenRequestSchema,
  IntegrationTokenResponseSchema,
} from '@matcheck/contracts';
import { sha256Hex } from '../domain/auth/crypto.js';
import { issueMachineToken } from '../domain/auth/service-accounts.js';
import { createBurstyRateLimit } from '../lib/auth-rate-limit.js';
import { clientIpOf } from '../lib/client-ip.js';
import { loadEnv } from '../lib/env.js';
import { asZod } from '../lib/fastify.js';

export type IntegrationTokenRoutesOptions = {
  /** Открыт ли канал. По умолчанию — ONEC_INTEGRATION_ENABLED; параметр для тестов. */
  enabled?: () => boolean;
};

function clientIdKey(req: FastifyRequest): string | null {
  const raw = (req.body as Record<string, unknown> | undefined)?.['client_id'];
  // В Redis — только хеш: ключи лимитера живут долго.
  return typeof raw === 'string' && raw.length > 0 ? sha256Hex(raw) : null;
}

export async function integrationTokenRoutes(
  rawApp: FastifyInstance,
  opts: IntegrationTokenRoutesOptions = {},
): Promise<void> {
  const app = asZod(rawApp);
  const enabled = opts.enabled ?? (() => loadEnv().ONEC_INTEGRATION_ENABLED);

  app.post(
    '/api/v1/public/integration/token',
    {
      preHandler: [
        // По адресу — clientIpOf, а не req.ip: тот подделывается через XFF.
        createBurstyRateLimit({
          burst: 30,
          burstWindowSec: 600,
          slowWindowSec: 60,
          keyPrefix: 'itoken-ip',
          noun: 'получения токена',
          keyOf: (req) => clientIpOf(req),
        }),
        createBurstyRateLimit({
          burst: 20,
          burstWindowSec: 600,
          slowWindowSec: 60,
          keyPrefix: 'itoken-client',
          noun: 'получения токена',
          keyOf: clientIdKey,
        }),
      ],
      schema: {
        body: IntegrationTokenRequestSchema,
        response: {
          200: IntegrationTokenResponseSchema,
          401: ErrorResponseSchema,
          429: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      if (!enabled()) return reply.code(503).send({ error: 'integration_disabled' });
      const result = await issueMachineToken(app.db, {
        clientId: req.body.client_id,
        clientSecret: req.body.client_secret,
        ip: clientIpOf(req),
        userAgent: req.headers['user-agent'] ?? null,
      });
      // Любая неудача — одна и та же ошибка: по ответу нельзя понять, есть ли
      // такая учётка, активна ли она и из какой сети её ждут.
      if (!result.ok) return reply.code(401).send({ error: 'invalid_client' });
      return {
        access_token: result.accessToken,
        token_type: 'Bearer' as const,
        expires_in: result.expiresIn,
        scope: result.scopes.join(' '),
      };
    },
  );
}
