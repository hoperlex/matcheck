import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { ErrorResponseSchema, ShipmentSchema, type Shipment } from '@matcheck/contracts';
import { asZod } from '../lib/fastify.js';
import { counterparties, responsiblePersons, shipments, shipmentSources } from '../db/schema.js';
import { assertPermission } from '../lib/permissions/assert.js';
import { publishEvent } from './events.js';
import { kindLinksStatus, validateKindLinks } from '../domain/operations/shipment-kind-links.js';

const IdParams = z.object({ id: z.string().uuid() });
const ReceiverBody = z.union([
  z.object({ contractorId: z.string().uuid() }).strict(),
  z.object({ recipientMolId: z.string().uuid() }).strict(),
  z.object({ none: z.literal(true) }).strict(),
]);

/**
 * Получатель отгрузки — сразу, без «Сохранить» (зеркало
 * PATCH /deliveries/:id/recipient). Только вид «подрядчику»: у перемещения
 * получатель уходит ещё и в парную приёмку (domain/transfers/pair.ts, вне
 * транзакции отгрузки), а возврат — это поставщик. На 19.11.2026 на бою все
 * отгрузки — «подрядчику»; остальные виды сохраняют получателя через upsert.
 *
 * version не поднимаем, как у /flags: 409 на upsert планшета заблокировал бы
 * его очередь. Устаревшую форму портала держит флаг keepReceiver у upsert.
 */
export function registerShipmentRecipientRoutes(
  rawApp: FastifyInstance,
  buildDto: (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app: any,
    id: string,
    role?: string | null,
  ) => Promise<Shipment | null>,
): void {
  const app = asZod(rawApp);

  app.patch(
    '/api/v1/shipments/:id/recipient',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: IdParams,
        body: ReceiverBody,
        response: {
          200: ShipmentSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          422: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      // Роль — authorize выше, монитор проходит его расширением ячейки edit.
      await assertPermission(req, 'operations.shipments', 'edit');
      const body = req.body;
      const next = {
        receiverCounterpartyId: 'contractorId' in body ? body.contractorId : null,
        receiverMolId: 'recipientMolId' in body ? body.recipientMolId : null,
      };
      const result = await app.db.transaction(async (tx) => {
        const [row] = await tx
          .select({
            id: shipments.id,
            siteId: shipments.siteId,
            kind: shipments.kind,
            destSiteId: shipments.destSiteId,
            pendingDeletionAt: shipments.pendingDeletionAt,
            receiverCounterpartyId: shipments.receiverCounterpartyId,
            receiverMolId: shipments.receiverMolId,
          })
          .from(shipments)
          .where(eq(shipments.id, req.params.id))
          .for('update');
        if (!row) return { code: 404 as const, error: 'not_found' };
        if (row.pendingDeletionAt) return { code: 409 as const, error: 'pending_deletion' };
        if (row.kind !== 'contractor') return { code: 409 as const, error: 'kind_not_supported' };
        // Существование — явным ответом, а не ошибкой внешнего ключа.
        if (next.receiverCounterpartyId) {
          const [exists] = await tx
            .select({ id: counterparties.id })
            .from(counterparties)
            .where(eq(counterparties.id, next.receiverCounterpartyId))
            .limit(1);
          if (!exists) return { code: 422 as const, error: 'unknown_contractor' };
        }
        if (next.receiverMolId) {
          const [exists] = await tx
            .select({ id: responsiblePersons.id })
            .from(responsiblePersons)
            .where(eq(responsiblePersons.id, next.receiverMolId))
            .limit(1);
          if (!exists) return { code: 422 as const, error: 'unknown_recipient_mol' };
        }
        // Сочетание с видом и документами — то же правило, что у upsert:
        // с привязанной УПД получатель обязателен (422 receiver_required).
        const links = await tx
          .select({ id: shipmentSources.sourceDocumentId })
          .from(shipmentSources)
          .where(eq(shipmentSources.shipmentId, row.id));
        const linksError = validateKindLinks({
          kind: 'contractor',
          siteId: row.siteId,
          destSiteId: row.destSiteId,
          ...next,
          sourceDocumentIds: links.map((l) => l.id),
        });
        if (linksError) {
          return {
            code: kindLinksStatus(linksError),
            error: linksError.code,
            message: linksError.message,
          };
        }
        await tx
          .update(shipments)
          .set({ ...next, updatedAt: new Date() })
          .where(eq(shipments.id, row.id));
        return {
          code: 200 as const,
          id: row.id,
          siteId: row.siteId,
          previous: {
            receiverCounterpartyId: row.receiverCounterpartyId,
            receiverMolId: row.receiverMolId,
          },
        };
      });
      if (result.code !== 200) {
        return reply
          .code(result.code)
          .send({ error: result.error, ...('message' in result && { message: result.message }) });
      }
      if (
        result.previous.receiverCounterpartyId !== next.receiverCounterpartyId ||
        result.previous.receiverMolId !== next.receiverMolId
      ) {
        req.log.info(
          { shipmentId: result.id, userId: req.user?.id ?? null, from: result.previous, to: next },
          'shipment_recipient_set',
        );
      }
      publishEvent(rawApp, {
        type: 'shipment_updated',
        entityId: result.id,
        siteId: result.siteId,
        ts: new Date().toISOString(),
      });
      const dto = await buildDto(rawApp, result.id, req.user?.role);
      if (!dto) throw new Error('shipment_disappeared_after_update');
      return dto;
    },
  );
}
