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
import { siteInScope, siteScopeCondition, siteScopeOf } from '../lib/site-scope.js';
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
import { deliveries, sites } from '../db/schema.js';
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
    user: { role?: string; siteId?: string | null; siteIds?: string[] } | undefined,
  ): Promise<{ id: string; siteId: string } | null> {
    const [d] = await app.db
      .select({ id: deliveries.id, siteId: deliveries.siteId })
      .from(deliveries)
      .where(eq(deliveries.id, deliveryId))
      .limit(1);
    if (!d) return null;
    if (user?.role === 'inspector_kpp' && (!user.siteId || user.siteId !== d.siteId)) return null;
    // Наблюдатель — только приёмки своих объектов.
    if (!siteInScope(siteScopeOf(user), d.siteId)) return null;
    return d;
  }

  /** Область договора: общий, документа-скана или УПД из ЭДО без скана (0152). */
  type Scope = { documentId: string | null; edoMatchId: string | null };

  /** Договор области — для ответа 409 contract_changed. */
  async function scopeContract(deliveryId: string, siteId: string, scope: Scope) {
    const all = await getDeliveryContract(app.db, { id: deliveryId, siteId });
    if (scope.edoMatchId !== null) {
      return (all.edoDocuments ?? []).find((d) => d.edoMatchId === scope.edoMatchId)?.contract ?? null;
    }
    if (scope.documentId === null) return all.contract;
    return all.documents.find((d) => d.documentId === scope.documentId)?.contract ?? null;
  }

  /** Область из тела или query. Документ и УПД из ЭДО сразу — null (400). */
  function scopeOf(source: { documentId?: string | null; edoMatchId?: string | null }): Scope | null {
    const documentId = source.documentId ?? null;
    const edoMatchId = source.edoMatchId ?? null;
    if (documentId !== null && edoMatchId !== null) return null;
    return { documentId, edoMatchId };
  }
  const AMBIGUOUS = {
    error: 'scope_ambiguous',
    message: 'Укажите либо документ, либо УПД из ЭДО',
  } as const;

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
      const result = await getDeliveryContract(app.db, delivery);
      const scope = siteScopeOf(req.user);
      if (!scope) return result;
      // Наблюдатель. Договор 1С бывает общим на несколько объектов: коды чужих
      // объектов и свободный текст «объект» из 1С (там их перечисляют словами)
      // ему не показываем. Размер справочника договоров — тоже не его данные.
      const own = new Set(
        scope.length === 0
          ? []
          : (
              await app.db
                .select({ code: sites.code })
                .from(sites)
                .where(siteScopeCondition(scope, sites.id))
            ).map((r) => r.code),
      );
      const narrow = <C extends { siteCodes: string[]; objectText: string | null }>(c: C): C => ({
        ...c,
        siteCodes: c.siteCodes.filter((code) => own.has(code)),
        objectText: null,
      });
      return {
        ...result,
        contract: result.contract ? narrow(result.contract) : null,
        documents: result.documents.map((d) => ({ ...d, contract: narrow(d.contract) })),
        edoDocuments: (result.edoDocuments ?? []).map((d) => ({ ...d, contract: narrow(d.contract) })),
        catalog: { ...result.catalog, total: 0 },
      };
    },
  );

  app.get(
    '/api/v1/deliveries/:id/contract-candidates',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: DeliveryParams,
        querystring: ContractCandidatesQuerySchema,
        response: {
          200: ContractCandidatesResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const scope = scopeOf(req.query);
      if (!scope) return reply.code(400).send(AMBIGUOUS);
      const delivery = await visibleDelivery(req.params.id, req.user);
      if (!delivery) return reply.code(404).send({ error: 'not_found' });
      return findContractCandidates(app.db, {
        deliveryId: delivery.id,
        deliverySiteId: delivery.siteId,
        documentId: scope.documentId,
        edoMatchId: scope.edoMatchId,
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
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ConflictSchema,
        },
      },
    },
    async (req, reply) => {
      const scope = scopeOf(req.body);
      if (!scope) return reply.code(400).send(AMBIGUOUS);
      const result = await setDeliveryContract(app.db, {
        deliveryId: req.params.id,
        documentId: scope.documentId,
        edoMatchId: scope.edoMatchId,
        contractId: req.body.contractId,
        replaceContractId: req.body.replaceContractId,
        userId: req.user?.id ?? null,
      });
      if (!result.ok) {
        if (result.status === 404) return reply.code(404).send({ error: result.error });
        if (result.error === 'contract_changed') {
          return reply.code(409).send({
            error: 'contract_changed',
            message: result.message,
            current: await scopeContract(req.params.id, result.siteId, scope),
          });
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
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ConflictSchema,
        },
      },
    },
    async (req, reply) => {
      const scope = scopeOf(req.query);
      if (!scope) return reply.code(400).send(AMBIGUOUS);
      const result = await unsetDeliveryContract(app.db, {
        deliveryId: req.params.id,
        documentId: scope.documentId,
        edoMatchId: scope.edoMatchId,
        expectedContractId: req.query.expectedContractId,
        userId: req.user?.id ?? null,
      });
      if (!result.ok) {
        if (result.status === 404) return reply.code(404).send({ error: result.error });
        if (result.error === 'contract_changed') {
          return reply.code(409).send({
            error: 'contract_changed',
            message: result.message,
            current: await scopeContract(req.params.id, result.siteId, scope),
          });
        }
        return reply.code(409).send({ error: result.error, message: result.message });
      }
      if (result.changed) notify(req.params.id, result.siteId);
      return getDeliveryContract(app.db, { id: req.params.id, siteId: result.siteId });
    },
  );
}
