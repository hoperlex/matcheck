import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  DeliverySupplierOrdersResponseSchema,
  ErrorResponseSchema,
  ESTIMAT_APPROVAL_STATES,
  EstimatOrderDetailSchema,
  EstimatOrderItemsResponseSchema,
  EstimatOrderListResponseSchema,
  EstimatSyncStatusSchema,
  EstimatSyncTriggerResponseSchema,
  LinkSupplierOrderBodySchema,
  SupplierOrderCandidatesResponseSchema,
  SupplierOrderSiteMismatchSchema,
} from '@matcheck/contracts';
import { asZod } from '../lib/fastify.js';
import { loadEnv } from '../lib/env.js';
import { deliveries } from '../db/schema.js';
import { readEstimatConfig } from '../domain/estimat/config.js';
import {
  findCandidates,
  isOrderLinked,
  linkOrder,
  listDeliveryOrders,
  unlinkOrder,
} from '../domain/estimat/delivery-orders.js';
import { loadOrderItems } from '../domain/estimat/order-items.js';
import {
  getOrderDetail,
  listOrders,
  loadSyncInfo,
  loadSyncStatus,
  syncEnabled,
  type SyncSettings,
} from '../domain/estimat/orders-read.js';
import {
  ESTIMAT_SYNC_JOB_OPTIONS,
  ESTIMAT_SYNC_MANUAL_JOB_ID,
} from '../plugins/queue.js';
import { publishEvent } from './events.js';

/**
 * Заказы поставщикам из EstiMat: вкладка «Заказы» в Справочниках и привязка
 * заказов к приёмке. Права — в lib/permissions/route-map.ts (ORDERS_*, ORDER_*).
 * Мобильный клиент эти маршруты не знает: связь живёт вне deliveries и /sync.
 */

function settings(): SyncSettings {
  const env = loadEnv();
  return {
    enabledFlag: env.ESTIMAT_SYNC_ENABLED,
    config: readEstimatConfig(env),
    intervalSec: env.ESTIMAT_SYNC_INTERVAL_SEC,
  };
}

/** Список через запятую, как у остальных фильтров портала. */
const splitCsv = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []));
const StatusCsv = splitCsv.pipe(z.array(z.string().max(64)).max(20));
const ApprovalCsv = splitCsv.pipe(z.array(z.enum(ESTIMAT_APPROVAL_STATES)));

const boolFlag = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const DeliveryParams = z.object({ id: z.string().uuid() });

export async function estimatRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);

  /** Приёмка для маршрутов просмотра: inspector_kpp — только своего объекта. */
  async function visibleDelivery(
    deliveryId: string,
    user: { role?: string; siteId?: string | null } | undefined,
  ): Promise<{ id: string; siteId: string } | null> {
    const [d] = await app.db
      .select({ id: deliveries.id, siteId: deliveries.siteId })
      .from(deliveries)
      .where(eq(deliveries.id, deliveryId))
      .limit(1);
    if (!d) return null;
    if (user?.role === 'inspector_kpp' && (!user.siteId || user.siteId !== d.siteId)) return null;
    return d;
  }

  // ─── Справочники → «Заказы» ──────────────────────────────────────────────

  app.get(
    '/api/v1/estimat/supplier-orders',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        querystring: z.object({
          q: z.string().max(200).optional(),
          siteId: z.string().uuid().optional(),
          status: StatusCsv,
          approval: ApprovalCsv,
          includeDeleted: boolFlag,
          limit: z.coerce.number().int().min(1).max(100).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: EstimatOrderListResponseSchema },
      },
    },
    async (req) =>
      listOrders(app.db, {
        q: req.query.q,
        siteId: req.query.siteId,
        statuses: req.query.status,
        approval: req.query.approval,
        includeDeleted: req.query.includeDeleted,
        limit: req.query.limit,
        offset: req.query.offset,
      }),
  );

  app.get(
    '/api/v1/estimat/supplier-orders/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: EstimatOrderDetailSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const detail = await getOrderDetail(app.db, req.params.id);
      if (!detail) return reply.code(404).send({ error: 'not_found' });
      return detail;
    },
  );

  app.get(
    '/api/v1/estimat/supplier-orders/:id/items',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: EstimatOrderItemsResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const items = await loadOrderItems({ db: app.db, config: settings().config }, req.params.id);
      if (!items) return reply.code(404).send({ error: 'not_found' });
      return items;
    },
  );

  app.get(
    '/api/v1/estimat/sync-status',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: { response: { 200: EstimatSyncStatusSchema } },
    },
    async () => loadSyncStatus(app.db, settings()),
  );

  // «Обновить». Обход выполняет mail-worker; здесь — только постановка задачи.
  app.post(
    '/api/v1/estimat/sync',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        response: {
          200: EstimatSyncTriggerResponseSchema,
          202: EstimatSyncTriggerResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const state = syncEnabled(settings());
      if (!state.enabled) {
        return reply.code(409).send({
          error: 'estimat_sync_disabled',
          message: state.reason ?? 'синхронизация EstiMat выключена',
        });
      }
      const queue = app.queues.estimatSync;
      // Задача, поставленная без воркера, висела бы вечно, а кнопка навсегда
      // отвечала бы «уже в очереди» (флаг включили у API, но не у mail-worker).
      if ((await queue.getWorkersCount()) === 0) {
        return reply.code(409).send({
          error: 'worker_unavailable',
          message: 'обработчик синхронизации EstiMat не запущен — перезапустите matcheck-mail-worker',
        });
      }
      if (await queue.getJob(ESTIMAT_SYNC_MANUAL_JOB_ID)) {
        return reply.code(200).send({ status: 'already_queued' });
      }
      const requestId = randomUUID();
      await queue.add(
        'manual',
        { trigger: 'manual', userId: req.user?.id ?? null, requestId },
        { ...ESTIMAT_SYNC_JOB_OPTIONS, jobId: ESTIMAT_SYNC_MANUAL_JOB_ID },
      );
      // При занятом id BullMQ молча не ставит задачу, а объект возвращает с
      // НАШИМИ данными — поэтому сверяем с тем, что лежит в очереди.
      const stored = await queue.getJob(ESTIMAT_SYNC_MANUAL_JOB_ID);
      if (stored && stored.data?.requestId !== requestId) {
        return reply.code(200).send({ status: 'already_queued' });
      }
      return reply.code(202).send({ status: 'queued' });
    },
  );

  // ─── Приёмка ─────────────────────────────────────────────────────────────

  app.get(
    '/api/v1/deliveries/:id/supplier-orders',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager', 'inspector_kpp', 'monitor')],
      schema: {
        params: DeliveryParams,
        response: { 200: DeliverySupplierOrdersResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const delivery = await visibleDelivery(req.params.id, req.user);
      if (!delivery) return reply.code(404).send({ error: 'not_found' });
      const [items, sync] = await Promise.all([
        listDeliveryOrders(app.db, delivery.id),
        loadSyncInfo(app.db, settings()),
      ]);
      return { items, sync };
    },
  );

  app.get(
    '/api/v1/deliveries/:id/supplier-orders/:orderId/items',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager', 'inspector_kpp', 'monitor')],
      schema: {
        params: z.object({ id: z.string().uuid(), orderId: z.string().uuid() }),
        response: { 200: EstimatOrderItemsResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const delivery = await visibleDelivery(req.params.id, req.user);
      if (!delivery || !(await isOrderLinked(app.db, delivery.id, req.params.orderId))) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const items = await loadOrderItems({ db: app.db, config: settings().config }, req.params.orderId);
      if (!items) return reply.code(404).send({ error: 'not_found' });
      return items;
    },
  );

  app.get(
    '/api/v1/deliveries/:id/supplier-order-candidates',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: DeliveryParams,
        querystring: z.object({
          q: z.string().max(200).optional(),
          allSites: boolFlag,
          allStages: boolFlag,
          limit: z.coerce.number().int().min(1).max(100).default(20),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: SupplierOrderCandidatesResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const [delivery] = await app.db
        .select({ id: deliveries.id, siteId: deliveries.siteId })
        .from(deliveries)
        .where(eq(deliveries.id, req.params.id))
        .limit(1);
      if (!delivery) return reply.code(404).send({ error: 'not_found' });
      const [found, syncInfo] = await Promise.all([
        findCandidates(app.db, {
          deliveryId: delivery.id,
          deliverySiteId: delivery.siteId,
          q: req.query.q,
          allSites: req.query.allSites,
          allStages: req.query.allStages,
          limit: req.query.limit,
          offset: req.query.offset,
        }),
        loadSyncInfo(app.db, settings()),
      ]);
      return { ...found, syncInfo };
    },
  );

  app.post(
    '/api/v1/deliveries/:id/supplier-orders',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: DeliveryParams,
        body: LinkSupplierOrderBodySchema,
        response: {
          200: DeliverySupplierOrdersResponseSchema,
          404: ErrorResponseSchema,
          409: z.union([SupplierOrderSiteMismatchSchema, ErrorResponseSchema]),
        },
      },
    },
    async (req, reply) => {
      const result = await linkOrder(app.db, {
        deliveryId: req.params.id,
        orderId: req.body.orderId,
        userId: req.user?.id ?? null,
        confirmSiteMismatch: req.body.confirmSiteMismatch === true,
      });
      if (!result.ok) {
        const { ok: _ok, status, ...body } = result;
        return reply.code(status).send(body);
      }
      if (result.inserted) {
        publishEvent(app, {
          type: 'delivery_updated',
          entityId: req.params.id,
          siteId: result.siteId,
          ts: new Date().toISOString(),
        });
      }
      const [items, sync] = await Promise.all([
        listDeliveryOrders(app.db, req.params.id),
        loadSyncInfo(app.db, settings()),
      ]);
      return { items, sync };
    },
  );

  app.delete(
    '/api/v1/deliveries/:id/supplier-orders/:orderId',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid(), orderId: z.string().uuid() }),
        response: {
          200: DeliverySupplierOrdersResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const result = await unlinkOrder(app.db, {
        deliveryId: req.params.id,
        orderId: req.params.orderId,
        userId: req.user?.id ?? null,
      });
      if (!result.ok) {
        const { ok: _ok, status, ...body } = result;
        return reply.code(status).send(body);
      }
      if (result.deleted) {
        publishEvent(app, {
          type: 'delivery_updated',
          entityId: req.params.id,
          siteId: result.siteId,
          ts: new Date().toISOString(),
        });
      }
      const [items, sync] = await Promise.all([
        listDeliveryOrders(app.db, req.params.id),
        loadSyncInfo(app.db, settings()),
      ]);
      return { items, sync };
    },
  );
}
