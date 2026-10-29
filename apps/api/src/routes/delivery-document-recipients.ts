import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  allowedDeliveryPurposes,
  DeliveryPurposeSchema,
  DeliverySchema,
  deliveryRecipientKind,
  effectiveDocumentRecipient,
  ErrorResponseSchema,
  reconcileDocumentPurpose,
  type DocumentRecipientState,
  type DeliveryPurpose,
  type Delivery,
} from '@matcheck/contracts';
import { asZod } from '../lib/fastify.js';
import { counterparties, deliveries, deliverySources, responsiblePersons } from '../db/schema.js';
import { assertPermission } from '../lib/permissions/assert.js';
import { publishEvent } from './events.js';

const IdParams = z.object({ id: z.string().uuid() });
const DocParams = IdParams.extend({ docId: z.string().uuid() });
const RecipientBody = z.union([
  z.object({ contractorId: z.string().uuid() }).strict(),
  z.object({ recipientMolId: z.string().uuid() }).strict(),
  z.object({ none: z.literal(true) }).strict(),
  z.object({ inherit: z.literal(true) }).strict(),
]);
const PurposeBody = z.union([
  z.object({ purpose: DeliveryPurposeSchema }).strict(),
  z.object({ inherit: z.literal(true) }).strict(),
]);
const Responses = {
  200: DeliverySchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  409: ErrorResponseSchema,
  422: ErrorResponseSchema,
};

type LockedDelivery = Pick<
  typeof deliveries.$inferSelect,
  | 'id'
  | 'siteId'
  | 'pendingDeletionAt'
  | 'recipientsPerDocument'
  | 'contractorId'
  | 'recipientMolId'
  | 'purpose'
>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function lockDelivery(tx: any, id: string): Promise<LockedDelivery | undefined> {
  const [row] = await tx
    .select({
      id: deliveries.id,
      siteId: deliveries.siteId,
      pendingDeletionAt: deliveries.pendingDeletionAt,
      recipientsPerDocument: deliveries.recipientsPerDocument,
      contractorId: deliveries.contractorId,
      recipientMolId: deliveries.recipientMolId,
      purpose: deliveries.purpose,
    })
    .from(deliveries)
    .where(eq(deliveries.id, id))
    .for('update');
  return row;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function lockLinks(tx: any, id: string) {
  return (await tx
    .select()
    .from(deliverySources)
    .where(eq(deliverySources.deliveryId, id))
    .orderBy(deliverySources.sourceDocumentId)
    .for('update')) as (typeof deliverySources.$inferSelect)[];
}

function general(row: LockedDelivery) {
  return {
    contractorId: row.contractorId,
    recipientMolId: row.recipientMolId,
    purpose: DeliveryPurposeSchema.nullable().parse(row.purpose),
  };
}

function documentState(row: typeof deliverySources.$inferSelect): DocumentRecipientState {
  return {
    ownRecipient: row.ownRecipient,
    contractorId: row.contractorId,
    recipientMolId: row.recipientMolId,
    ownPurpose: row.ownPurpose,
    purpose: DeliveryPurposeSchema.nullable().parse(row.purpose),
  };
}

function failure(row: LockedDelivery | undefined) {
  if (!row) return { code: 404 as const, error: 'not_found' };
  if (row.pendingDeletionAt) return { code: 409 as const, error: 'pending_deletion' };
  if (!row.recipientsPerDocument) return { code: 409 as const, error: 'per_document_off' };
  return null;
}

export function registerDeliveryDocumentRecipientRoutes(
  rawApp: FastifyInstance,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildDto: (app: any, id: string, role?: string | null) => Promise<Delivery | null>,
): void {
  const app = asZod(rawApp);

  async function respond(id: string, siteId: string, role: string | undefined) {
    publishEvent(rawApp, {
      type: 'delivery_updated',
      entityId: id,
      siteId,
      ts: new Date().toISOString(),
    });
    const dto = await buildDto(rawApp, id, role);
    if (!dto) throw new Error('delivery_disappeared_after_update');
    return dto;
  }

  app.patch(
    '/api/v1/deliveries/:id/recipient-mode',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: IdParams,
        body: z.object({ perDocument: z.boolean() }).strict(),
        response: Responses,
      },
    },
    async (req, reply) => {
      if (!['admin', 'manager'].includes(req.user?.role ?? ''))
        return reply.code(403).send({ error: 'forbidden' });
      await assertPermission(req, 'operations.deliveries', 'edit');
      const result = await app.db.transaction(async (tx) => {
        const row = await lockDelivery(tx, req.params.id);
        if (!row) return { code: 404 as const, error: 'not_found' };
        if (row.pendingDeletionAt) return { code: 409 as const, error: 'pending_deletion' };
        const links = await lockLinks(tx, row.id);
        if (req.body.perDocument) {
          if (links.length < 2)
            return { code: 422 as const, error: 'at_least_two_documents_required' };
          if (!row.recipientsPerDocument) {
            await tx
              .update(deliveries)
              .set({ recipientsPerDocument: true })
              .where(eq(deliveries.id, row.id));
          }
        } else if (row.recipientsPerDocument) {
          if (links.some((link) => link.ownPurpose)) {
            await assertPermission(req, 'operations.deliveries', 'review');
          }
          await tx
            .update(deliverySources)
            .set({
              ownRecipient: false,
              contractorId: null,
              recipientMolId: null,
              ownPurpose: false,
              purpose: null,
            })
            .where(eq(deliverySources.deliveryId, row.id));
          await tx
            .update(deliveries)
            .set({ recipientsPerDocument: false })
            .where(eq(deliveries.id, row.id));
        }
        return { code: 200 as const, id: row.id, siteId: row.siteId };
      });
      if (result.code !== 200) return reply.code(result.code).send({ error: result.error });
      return await respond(result.id, result.siteId, req.user?.role);
    },
  );

  app.patch(
    '/api/v1/deliveries/:id/sources/:docId/recipient',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: { params: DocParams, body: RecipientBody, response: Responses },
    },
    async (req, reply) => {
      if (!['admin', 'manager'].includes(req.user?.role ?? ''))
        return reply.code(403).send({ error: 'forbidden' });
      await assertPermission(req, 'operations.deliveries', 'edit');
      const result = await app.db.transaction(async (tx) => {
        const row = await lockDelivery(tx, req.params.id);
        const invalid = failure(row);
        if (invalid) return invalid;
        const locked = row!;
        const links = await lockLinks(tx, locked.id);
        const link = links.find((l) => l.sourceDocumentId === req.params.docId);
        if (!link) return { code: 404 as const, error: 'not_found' };
        if ('contractorId' in req.body) {
          const [exists] = await tx
            .select({ id: counterparties.id })
            .from(counterparties)
            .where(eq(counterparties.id, req.body.contractorId))
            .limit(1);
          if (!exists) return { code: 422 as const, error: 'unknown_contractor' };
        }
        if ('recipientMolId' in req.body) {
          const [exists] = await tx
            .select({ id: responsiblePersons.id })
            .from(responsiblePersons)
            .where(eq(responsiblePersons.id, req.body.recipientMolId))
            .limit(1);
          if (!exists) return { code: 422 as const, error: 'unknown_recipient_mol' };
        }
        const before = documentState(link);
        const next: DocumentRecipientState =
          'inherit' in req.body
            ? { ...before, ownRecipient: false, contractorId: null, recipientMolId: null }
            : 'none' in req.body
              ? { ...before, ownRecipient: true, contractorId: null, recipientMolId: null }
              : 'contractorId' in req.body
                ? {
                    ...before,
                    ownRecipient: true,
                    contractorId: req.body.contractorId,
                    recipientMolId: null,
                  }
                : {
                    ...before,
                    ownRecipient: true,
                    contractorId: null,
                    recipientMolId: req.body.recipientMolId,
                  };
        const after = reconcileDocumentPurpose(general(locked), general(locked), before, next);
        await tx
          .update(deliverySources)
          .set(after)
          .where(
            and(
              eq(deliverySources.deliveryId, locked.id),
              eq(deliverySources.sourceDocumentId, req.params.docId),
            ),
          );
        return { code: 200 as const, id: locked.id, siteId: locked.siteId };
      });
      if (result.code !== 200) return reply.code(result.code).send({ error: result.error });
      return await respond(result.id, result.siteId, req.user?.role);
    },
  );

  app.patch(
    '/api/v1/deliveries/:id/sources/:docId/purpose',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager', 'monitor')],
      schema: { params: DocParams, body: PurposeBody, response: Responses },
    },
    async (req, reply) => {
      if (!['admin', 'manager', 'monitor'].includes(req.user?.role ?? ''))
        return reply.code(403).send({ error: 'forbidden' });
      await assertPermission(req, 'operations.deliveries', 'review');
      const result = await app.db.transaction(async (tx) => {
        const row = await lockDelivery(tx, req.params.id);
        const invalid = failure(row);
        if (invalid) return invalid;
        const locked = row!;
        const links = await lockLinks(tx, locked.id);
        const link = links.find((l) => l.sourceDocumentId === req.params.docId);
        if (!link) return { code: 404 as const, error: 'not_found' };
        const before = documentState(link);
        const next: DocumentRecipientState =
          'inherit' in req.body
            ? { ...before, ownPurpose: false, purpose: null }
            : { ...before, ownPurpose: true, purpose: req.body.purpose as DeliveryPurpose };
        const effective = effectiveDocumentRecipient(general(locked), next);
        if (
          effective.purpose &&
          !allowedDeliveryPurposes(deliveryRecipientKind(effective)).includes(effective.purpose)
        ) {
          return { code: 422 as const, error: 'purpose_conflicts_recipient' };
        }
        await tx
          .update(deliverySources)
          .set({ ownPurpose: next.ownPurpose, purpose: next.purpose })
          .where(
            and(
              eq(deliverySources.deliveryId, locked.id),
              eq(deliverySources.sourceDocumentId, req.params.docId),
            ),
          );
        return { code: 200 as const, id: locked.id, siteId: locked.siteId };
      });
      if (result.code !== 200) return reply.code(result.code).send({ error: result.error });
      return await respond(result.id, result.siteId, req.user?.role);
    },
  );
}
