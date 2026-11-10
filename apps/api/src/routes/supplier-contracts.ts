/**
 * Договоры 1С: вкладка «Договоры» в Справочниках и договор приёмки
 * («+ Договор» в карточке). Справочник пишет только CLI-импорт
 * (scripts/import-contracts.ts), здесь — чтение и выбор договора приёмки.
 *
 * Права: см. CONTRACT_VIEW_IN_DELIVERY / CONTRACT_LINK / CONTRACTS_VIEW в
 * lib/permissions/route-map.ts. Выбор — admin и manager по allow-list, monitor —
 * расширением матрицы (expandableBy), как у «+ Заказ»: на бою у monitor ячейка
 * «Операции → Приёмки → Редактировать» включена, и кнопка у него есть сразу
 * (решение 10.11.2026). Сняли галочку — кнопки и маршрутов нет.
 */
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  ContractCandidatesQuerySchema,
  ContractCandidatesResponseSchema,
  DeliveryContractChangedSchema,
  DeliveryContractResponseSchema,
  ErrorResponseSchema,
  SetDeliveryContractBodySchema,
  SupplierContractsListQuerySchema,
  SupplierContractsListResponseSchema,
  UnsetDeliveryContractQuerySchema,
} from '@matcheck/contracts';
import { asZod } from '../lib/fastify.js';
import { deliveries } from '../db/schema.js';
import {
  findContractCandidates,
  getDeliveryContract,
  listSupplierContracts,
  setDeliveryContract,
  unsetDeliveryContract,
} from '../domain/supplier-contracts/delivery-contract.js';
import { publishEvent } from './events.js';

const DeliveryParams = z.object({ id: z.string().uuid() });

const ConflictSchema = z.union([DeliveryContractChangedSchema, ErrorResponseSchema]);

export async function supplierContractsRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);

  /** Приёмка, видимая пользователю: inspector_kpp — только своего объекта. */
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

  function notify(deliveryId: string, siteId: string) {
    publishEvent(app, {
      type: 'delivery_updated',
      entityId: deliveryId,
      siteId,
      ts: new Date().toISOString(),
    });
  }

  // ─── Справочники → «Договоры» ────────────────────────────────────────────

  app.get(
    '/api/v1/supplier-contracts',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        querystring: SupplierContractsListQuerySchema,
        response: { 200: SupplierContractsListResponseSchema },
      },
    },
    async (req) => listSupplierContracts(app.db, req.query),
  );

  // ─── Приёмка ─────────────────────────────────────────────────────────────

  app.get(
    '/api/v1/deliveries/:id/contract',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager', 'inspector_kpp', 'monitor')],
      schema: {
        params: DeliveryParams,
        response: { 200: DeliveryContractResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const delivery = await visibleDelivery(req.params.id, req.user);
      if (!delivery) return reply.code(404).send({ error: 'not_found' });
      return getDeliveryContract(app.db, delivery);
    },
  );

  app.get(
    '/api/v1/deliveries/:id/contract-candidates',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: DeliveryParams,
        querystring: ContractCandidatesQuerySchema,
        response: { 200: ContractCandidatesResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const delivery = await visibleDelivery(req.params.id, req.user);
      if (!delivery) return reply.code(404).send({ error: 'not_found' });
      return findContractCandidates(app.db, {
        deliveryId: delivery.id,
        deliverySiteId: delivery.siteId,
        q: req.query.q,
        allSuppliers: req.query.allSuppliers === '1',
        limit: req.query.limit,
        offset: req.query.offset,
      });
    },
  );

  app.put(
    '/api/v1/deliveries/:id/contract',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: DeliveryParams,
        body: SetDeliveryContractBodySchema,
        response: {
          200: DeliveryContractResponseSchema,
          404: ErrorResponseSchema,
          409: ConflictSchema,
        },
      },
    },
    async (req, reply) => {
      const result = await setDeliveryContract(app.db, {
        deliveryId: req.params.id,
        contractId: req.body.contractId,
        replaceContractId: req.body.replaceContractId,
        userId: req.user?.id ?? null,
      });
      if (!result.ok) {
        if (result.status === 404) return reply.code(404).send({ error: result.error });
        if (result.error === 'contract_changed') {
          const { contract } = await getDeliveryContract(app.db, { id: req.params.id, siteId: result.siteId });
          return reply.code(409).send({ error: 'contract_changed', message: result.message, current: contract });
        }
        return reply.code(409).send({ error: result.error, message: result.message });
      }
      if (result.changed) notify(req.params.id, result.siteId);
      return getDeliveryContract(app.db, { id: req.params.id, siteId: result.siteId });
    },
  );

  app.delete(
    '/api/v1/deliveries/:id/contract',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: DeliveryParams,
        querystring: UnsetDeliveryContractQuerySchema,
        response: {
          200: DeliveryContractResponseSchema,
          404: ErrorResponseSchema,
          409: ConflictSchema,
        },
      },
    },
    async (req, reply) => {
      const result = await unsetDeliveryContract(app.db, {
        deliveryId: req.params.id,
        expectedContractId: req.query.expectedContractId,
        userId: req.user?.id ?? null,
      });
      if (!result.ok) {
        if (result.status === 404) return reply.code(404).send({ error: result.error });
        if (result.error === 'contract_changed') {
          const { contract } = await getDeliveryContract(app.db, { id: req.params.id, siteId: result.siteId });
          return reply.code(409).send({ error: 'contract_changed', message: result.message, current: contract });
        }
        return reply.code(409).send({ error: result.error, message: result.message });
      }
      if (result.changed) notify(req.params.id, result.siteId);
      return getDeliveryContract(app.db, { id: req.params.id, siteId: result.siteId });
    },
  );
}
