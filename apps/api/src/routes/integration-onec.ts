/**
 * Машинный канал выгрузки приёмок в 1С: /api/v1/integration/1c/*.
 *
 * Авторизация — machine-токен сервисной учётки (plugins/auth.ts, ветка
 * INTEGRATION_ROUTE_PREFIX); req.user здесь не бывает, права — scope учётки.
 * Протокол обмена (очередь → пачка → загрузка → подтверждение) — в
 * docs/ONEC_API.md.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ErrorResponseSchema,
  OnecAckRequestSchema,
  OnecAckResponseSchema,
  OnecDeliveryBatchResponseSchema,
  OnecDeliverySchema,
  OnecQueueQuerySchema,
  OnecQueueResponseSchema,
} from '@matcheck/contracts';
import { SCOPE_ONEC_ACK, SCOPE_ONEC_READ } from '../domain/auth/service-accounts.js';
import { applyAcks } from '../domain/onec/ack.js';
import { runDetectionPass } from '../domain/onec/detection.js';
import { readEdoXml } from '../domain/onec/edo-xml.js';
import { deliveryIdByDisplayId, readDeliveries } from '../domain/onec/export-read.js';
import { listQueue, parseExportSince, QueueCursorError } from '../domain/onec/queue.js';
import { clientIpOf } from '../lib/client-ip.js';
import { loadEnv } from '../lib/env.js';
import { asZod } from '../lib/fastify.js';

export type OnecRoutesOptions = {
  /** Сырое значение ONEC_EXPORT_SINCE; параметр для тестов (loadEnv кэширует). */
  exportSince?: () => string | undefined;
  windowDays?: () => number;
  /** Чтение объекта S3 — для тестов отказа хранилища. */
  readObject?: (key: string, signal: AbortSignal) => Promise<Buffer>;
};

const BATCH_MAX = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const principalKey = (req: FastifyRequest): string => req.serviceAccount?.id ?? clientIpOf(req);

export async function integrationOnecRoutes(
  rawApp: FastifyInstance,
  opts: OnecRoutesOptions = {},
): Promise<void> {
  const app = asZod(rawApp);
  const exportSince = opts.exportSince ?? (() => loadEnv().ONEC_EXPORT_SINCE);
  const windowDays = opts.windowDays ?? (() => loadEnv().ONEC_CHANGE_WINDOW_DAYS);
  const read = app.requireScope(SCOPE_ONEC_READ);
  const ack = app.requireScope(SCOPE_ONEC_ACK);

  // ── Очередь ──
  app.get(
    '/api/v1/integration/1c/deliveries/queue',
    {
      preHandler: [read],
      config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: principalKey } },
      schema: {
        querystring: OnecQueueQuerySchema,
        response: {
          200: OnecQueueResponseSchema,
          400: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const since = parseExportSince(exportSince());
      if (!since) {
        return reply.code(503).send({
          error: 'not_configured',
          message: 'Дата начала выгрузки (ONEC_EXPORT_SINCE) не задана или не разбирается',
        });
      }
      // Проход поиска изменений — только на первой странице: следующие страницы
      // читают сохранённое состояние, иначе порядок плыл бы прямо под обходом.
      if (!req.query.cursor) {
        const pass = await runDetectionPass(app.db, { windowDays: windowDays() });
        req.log.info({ onecDetection: pass, clientId: req.serviceAccount?.clientId }, 'onec detection pass');
      }
      try {
        const page = await listQueue(app.db, {
          since,
          limit: req.query.limit,
          cursor: req.query.cursor,
          confirmedBefore: req.query.confirmedBefore,
        });
        return { ...page, generatedAt: new Date().toISOString() };
      } catch (err) {
        if (err instanceof QueueCursorError) {
          return reply.code(400).send({ error: 'invalid_cursor' });
        }
        throw err;
      }
    },
  );

  // ── Пачка ──
  app.get(
    '/api/v1/integration/1c/deliveries',
    {
      preHandler: [read],
      config: { rateLimit: { max: 120, timeWindow: '1 minute', keyGenerator: principalKey } },
      schema: {
        querystring: z.object({ ids: z.string().min(1).max(BATCH_MAX * 37) }),
        response: { 200: OnecDeliveryBatchResponseSchema, 400: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const ids = req.query.ids
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.length === 0 || ids.length > BATCH_MAX || !ids.every((id) => UUID_RE.test(id))) {
        return reply.code(400).send({
          error: 'invalid_ids',
          message: `ids — от 1 до ${BATCH_MAX} uuid через запятую`,
        });
      }
      return readDeliveries(app.db, ids);
    },
  );

  // ── Одна приёмка ──
  const readOne = async (id: string) => {
    const result = await readDeliveries(app.db, [id]);
    return { item: result.items[0] ?? null, state: result.missing[0]?.state ?? 'not_found' };
  };

  app.get(
    '/api/v1/integration/1c/deliveries/:id',
    {
      preHandler: [read],
      config: { rateLimit: { max: 120, timeWindow: '1 minute', keyGenerator: principalKey } },
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: OnecDeliverySchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { item, state } = await readOne(req.params.id);
      if (!item) return reply.code(404).send({ error: state });
      return item;
    },
  );

  app.get(
    '/api/v1/integration/1c/deliveries/by-number/:displayId',
    {
      preHandler: [read],
      config: { rateLimit: { max: 120, timeWindow: '1 minute', keyGenerator: principalKey } },
      schema: {
        params: z.object({ displayId: z.coerce.number().int().positive() }),
        response: { 200: OnecDeliverySchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const id = await deliveryIdByDisplayId(app.db, req.params.displayId);
      if (!id) return reply.code(404).send({ error: 'not_found' });
      const { item, state } = await readOne(id);
      if (!item) return reply.code(404).send({ error: state });
      return item;
    },
  );

  // ── XML УПД из ЭДО ──
  app.get(
    '/api/v1/integration/1c/deliveries/:id/edo/:matchId/xml',
    {
      preHandler: [read],
      config: { rateLimit: { max: 120, timeWindow: '1 minute', keyGenerator: principalKey } },
      schema: {
        params: z.object({ id: z.string().uuid(), matchId: z.string().uuid() }),
        response: {
          // Только для типов: Buffer Fastify отдаёт как есть, мимо сериализатора.
          200: z.custom<Buffer>((value) => Buffer.isBuffer(value)),
          404: ErrorResponseSchema,
          413: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const result = await readEdoXml(app.db, req.params.id, req.params.matchId, {
        read: opts.readObject,
      });
      switch (result.kind) {
        case 'not_found':
        case 'file_not_found':
          return reply.code(404).send({ error: result.kind });
        case 'too_large':
          return reply.code(413).send({ error: 'too_large' });
        case 'storage_failed':
          reply.header('retry-after', '30');
          return reply.code(503).send({ error: 'storage_failed', message: 'Хранилище недоступно, повторите позже' });
        case 'ok':
          reply
            .code(200)
            .header('content-type', `application/xml; charset=${result.charset}`)
            .header(
              'content-disposition',
              `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
            )
            .header('x-content-sha256', createHash('sha256').update(result.buffer).digest('hex'))
            .header('x-content-type-options', 'nosniff');
          return reply.send(result.buffer);
      }
    },
  );

  // ── Подтверждение ──
  app.post(
    '/api/v1/integration/1c/deliveries/ack',
    {
      preHandler: [ack],
      config: { rateLimit: { max: 120, timeWindow: '1 minute', keyGenerator: principalKey } },
      schema: {
        body: OnecAckRequestSchema,
        response: { 200: OnecAckResponseSchema },
      },
    },
    async (req) => {
      const results = await applyAcks(app.db, req.body.items, req.serviceAccount?.id ?? null);
      return { results };
    },
  );
}
