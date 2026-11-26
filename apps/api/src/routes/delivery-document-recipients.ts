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
import {
  counterparties,
  deliveries,
  deliveryEdoMatches,
  deliverySources,
  responsiblePersons,
} from '../db/schema.js';
import { assertPermission } from '../lib/permissions/assert.js';
import { publishEvent } from './events.js';
import { resetDocumentContracts } from '../domain/supplier-contracts/delivery-contract.js';
import {
  detachDirectoryPurpose,
  documentStateOf,
  lockFreeEdoMatches,
  lockPurposeForRecipientWrite,
  type RecipientPair,
} from '../domain/operations/delivery-purpose.js';

const IdParams = z.object({ id: z.string().uuid() });
const DocParams = IdParams.extend({ docId: z.string().uuid() });
const EdoParams = IdParams.extend({ matchId: z.string().uuid() });
const RecipientBody = z.union([
  z.object({ contractorId: z.string().uuid() }).strict(),
  z.object({ recipientMolId: z.string().uuid() }).strict(),
  z.object({ none: z.literal(true) }).strict(),
  z.object({ inherit: z.literal(true) }).strict(),
]);
/** Общий получатель приёмки: «наследовать» у него не от кого. */
const GeneralRecipientBody = z.union([
  z.object({ contractorId: z.string().uuid() }).strict(),
  z.object({ recipientMolId: z.string().uuid() }).strict(),
  z.object({ none: z.literal(true) }).strict(),
]);
const PurposeBody = z.union([
  z.object({ purpose: DeliveryPurposeSchema }).strict(),
  z.object({ inherit: z.literal(true) }).strict(),
]);
type RecipientBodyT = z.infer<typeof RecipientBody>;
type GeneralRecipientBodyT = z.infer<typeof GeneralRecipientBody>;
type PurposeBodyT = z.infer<typeof PurposeBody>;
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
  | 'purposeFromDirectory'
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
      purposeFromDirectory: deliveries.purposeFromDirectory,
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

/**
 * Выбранный подрядчик или МОЛ есть в справочнике — иначе 422, а не ошибка
 * внешнего ключа. Общая проверка для получателя приёмки и документа.
 */
async function unknownRecipient(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  body: RecipientBodyT | GeneralRecipientBodyT,
): Promise<{ code: 422; error: 'unknown_contractor' | 'unknown_recipient_mol' } | null> {
  if ('contractorId' in body) {
    const [exists] = await tx
      .select({ id: counterparties.id })
      .from(counterparties)
      .where(eq(counterparties.id, body.contractorId))
      .limit(1);
    if (!exists) return { code: 422, error: 'unknown_contractor' };
  }
  if ('recipientMolId' in body) {
    const [exists] = await tx
      .select({ id: responsiblePersons.id })
      .from(responsiblePersons)
      .where(eq(responsiblePersons.id, body.recipientMolId))
      .limit(1);
    if (!exists) return { code: 422, error: 'unknown_recipient_mol' };
  }
  return null;
}

function failure(row: LockedDelivery | undefined) {
  if (!row) return { code: 404 as const, error: 'not_found' };
  if (row.pendingDeletionAt) return { code: 409 as const, error: 'pending_deletion' };
  if (!row.recipientsPerDocument) return { code: 409 as const, error: 'per_document_off' };
  return null;
}

/**
 * Документ режима «Разные получатели»: загруженный (delivery_sources) или
 * свободная УПД из ЭДО (delivery_edo_matches без блока, 0152). Настройки у
 * обоих одинаковые, отличаются только строка и таблица записи.
 */
type Target = { kind: 'source'; docId: string } | { kind: 'edo'; matchId: string };

type LockedTarget =
  | { ok: true; state: DocumentRecipientState; write: (next: DocumentRecipientState) => Promise<void> }
  | { ok: false; code: 404 | 409; error: string };

/** Строка документа под FOR UPDATE — после блокировки приёмки. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function lockTarget(tx: any, deliveryId: string, target: Target): Promise<LockedTarget> {
  if (target.kind === 'source') {
    const links = await lockLinks(tx, deliveryId);
    const link = links.find((l) => l.sourceDocumentId === target.docId);
    if (!link) return { ok: false, code: 404, error: 'not_found' };
    return {
      ok: true,
      state: documentStateOf(link),
      write: async (next) => {
        await tx
          .update(deliverySources)
          .set(next)
          .where(
            and(
              eq(deliverySources.deliveryId, deliveryId),
              eq(deliverySources.sourceDocumentId, target.docId),
            ),
          );
      },
    };
  }
  const [match] = (await tx
    .select()
    .from(deliveryEdoMatches)
    .where(and(eq(deliveryEdoMatches.deliveryId, deliveryId), eq(deliveryEdoMatches.id, target.matchId)))
    .for('update')) as (typeof deliveryEdoMatches.$inferSelect)[];
  if (!match) return { ok: false, code: 404, error: 'not_found' };
  // УПД в блоке скана живёт настройками блока (CHECK section_own_chk).
  if (match.sectionDocumentId) return { ok: false, code: 409, error: 'edo_match_in_section' };
  return {
    ok: true,
    state: documentStateOf(match),
    write: async (next) => {
      await tx.update(deliveryEdoMatches).set(next).where(eq(deliveryEdoMatches.id, match.id));
    },
  };
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

  /** Свой получатель документа: тело и правило — одни для скана и УПД из ЭДО. */
  async function setRecipient(deliveryId: string, target: Target, body: RecipientBodyT) {
    return app.db.transaction(async (tx) => {
      const row = await lockDelivery(tx, deliveryId);
      const invalid = failure(row);
      if (invalid) return invalid;
      const locked = row!;
      const doc = await lockTarget(tx, locked.id, target);
      if (!doc.ok) return { code: doc.code, error: doc.error };
      const unknown = await unknownRecipient(tx, body);
      if (unknown) return unknown;
      const before = doc.state;
      const next: DocumentRecipientState =
        'inherit' in body
          ? { ...before, ownRecipient: false, contractorId: null, recipientMolId: null }
          : 'none' in body
            ? { ...before, ownRecipient: true, contractorId: null, recipientMolId: null }
            : 'contractorId' in body
              ? { ...before, ownRecipient: true, contractorId: body.contractorId, recipientMolId: null }
              : { ...before, ownRecipient: true, contractorId: null, recipientMolId: body.recipientMolId };
      // Общий признак поставил справочник для получателя шапки — документу
      // с другим получателем он не подходит (detachDirectoryPurpose).
      await doc.write(
        detachDirectoryPurpose(
          general(locked),
          locked.purposeFromDirectory,
          reconcileDocumentPurpose(general(locked), general(locked), before, next),
        ),
      );
      return { code: 200 as const, id: locked.id, siteId: locked.siteId };
    });
  }

  /** Свой признак документа: несовместимый с получателем — 422. */
  async function setPurpose(deliveryId: string, target: Target, body: PurposeBodyT) {
    return app.db.transaction(async (tx) => {
      const row = await lockDelivery(tx, deliveryId);
      const invalid = failure(row);
      if (invalid) return invalid;
      const locked = row!;
      const doc = await lockTarget(tx, locked.id, target);
      if (!doc.ok) return { code: doc.code, error: doc.error };
      const before = doc.state;
      const next: DocumentRecipientState =
        'inherit' in body
          ? { ...before, ownPurpose: false, purpose: null }
          : { ...before, ownPurpose: true, purpose: body.purpose as DeliveryPurpose };
      const effective = effectiveDocumentRecipient(general(locked), next);
      if (
        effective.purpose &&
        !allowedDeliveryPurposes(deliveryRecipientKind(effective)).includes(effective.purpose)
      ) {
        return { code: 422 as const, error: 'purpose_conflicts_recipient' };
      }
      await doc.write(next);
      return { code: 200 as const, id: locked.id, siteId: locked.siteId };
    });
  }

  /**
   * Общий получатель приёмки — сразу, без «Сохранить» (как договор и
   * получатель документа). Раньше он жил в форме до «Сохранить» и терялся
   * при уходе из карточки, обновлении портала и перечитке формы (жалоба
   * мониторинга 18.11.2026). version не поднимаем, как у /purpose и /flags:
   * 409 на upsert планшета заблокировал бы его очередь. Устаревшую форму
   * портала держит флаг keepRecipient у upsert.
   */
  app.patch(
    '/api/v1/deliveries/:id/recipient',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: { params: IdParams, body: GeneralRecipientBody, response: Responses },
    },
    async (req, reply) => {
      // Роль — authorize выше, монитор проходит его расширением ячейки edit.
      await assertPermission(req, 'operations.deliveries', 'edit');
      const body = req.body;
      const next: RecipientPair =
        'contractorId' in body
          ? { contractorId: body.contractorId, recipientMolId: null }
          : 'recipientMolId' in body
            ? { contractorId: null, recipientMolId: body.recipientMolId }
            : { contractorId: null, recipientMolId: null };
      const result = await app.db.transaction(async (tx) => {
        const row = await lockDelivery(tx, req.params.id);
        if (!row) return { code: 404 as const, error: 'not_found' };
        if (row.pendingDeletionAt) return { code: 409 as const, error: 'pending_deletion' };
        const unknown = await unknownRecipient(tx, body);
        if (unknown) return unknown;
        // Та же строка уже под блокировкой: helper согласует общий признак и, в
        // режиме «Разные получатели», признаки документов — как upsert.
        const reconciled = await lockPurposeForRecipientWrite(tx, row.id, next);
        await tx
          .update(deliveries)
          .set({
            ...next,
            ...(reconciled && {
              purpose: reconciled.purpose,
              purposeFromDirectory: reconciled.fromDirectory,
            }),
            updatedAt: new Date(),
          })
          .where(eq(deliveries.id, row.id));
        const previous = reconciled?.previous ?? {
          contractorId: row.contractorId,
          recipientMolId: row.recipientMolId,
        };
        return { code: 200 as const, id: row.id, siteId: row.siteId, previous };
      });
      if (result.code !== 200) return reply.code(result.code).send({ error: result.error });
      if (
        result.previous.contractorId !== next.contractorId ||
        result.previous.recipientMolId !== next.recipientMolId
      ) {
        req.log.info(
          { deliveryId: result.id, userId: req.user?.id ?? null, from: result.previous, to: next },
          'delivery_recipient_set',
        );
      }
      return await respond(result.id, result.siteId, req.user?.role);
    },
  );

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
      // Роль проверяет authorize выше: Мониторинг проходит его только
      // расширением ячейки edit (route-map, DOCUMENT_RECIPIENT). Второй
      // жёсткой проверки роли здесь нет — она держала бы его всегда.
      await assertPermission(req, 'operations.deliveries', 'edit');
      const result = await app.db.transaction(async (tx) => {
        const row = await lockDelivery(tx, req.params.id);
        if (!row) return { code: 404 as const, error: 'not_found' };
        if (row.pendingDeletionAt) return { code: 409 as const, error: 'pending_deletion' };
        // Порядок блокировок: deliveries → delivery_sources → delivery_edo_matches.
        const links = await lockLinks(tx, row.id);
        const edo = await lockFreeEdoMatches(tx, row.id);
        if (req.body.perDocument) {
          // Документы режима — сканы и свободные УПД из ЭДО (приёмка 22973:
          // две УПД из Диадока без сканов).
          if (links.length + edo.length < 2)
            return { code: 422 as const, error: 'at_least_two_documents_required' };
          if (!row.recipientsPerDocument) {
            await tx
              .update(deliveries)
              .set({ recipientsPerDocument: true })
              .where(eq(deliveries.id, row.id));
          }
        } else if (row.recipientsPerDocument) {
          if (links.some((link) => link.ownPurpose) || edo.some((match) => match.ownPurpose)) {
            await assertPermission(req, 'operations.deliveries', 'review');
          }
          // Договоры 1С документов сбрасываются вместе со своими получателями и
          // признаками (решение 11.11.2026); общий договор приёмки остаётся.
          await resetDocumentContracts(tx, row.id, req.user?.id ?? null);
          const reset = {
            ownRecipient: false,
            contractorId: null,
            recipientMolId: null,
            ownPurpose: false,
            purpose: null,
          };
          await tx.update(deliverySources).set(reset).where(eq(deliverySources.deliveryId, row.id));
          await tx
            .update(deliveryEdoMatches)
            .set(reset)
            .where(eq(deliveryEdoMatches.deliveryId, row.id));
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
      // Как у recipient-mode: роль — authorize, монитор — расширением edit.
      await assertPermission(req, 'operations.deliveries', 'edit');
      const result = await setRecipient(
        req.params.id,
        { kind: 'source', docId: req.params.docId },
        req.body,
      );
      if (result.code !== 200) return reply.code(result.code).send({ error: result.error });
      return await respond(result.id, result.siteId, req.user?.role);
    },
  );

  app.patch(
    '/api/v1/deliveries/:id/edo-matches/:matchId/recipient',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: { params: EdoParams, body: RecipientBody, response: Responses },
    },
    async (req, reply) => {
      await assertPermission(req, 'operations.deliveries', 'edit');
      const result = await setRecipient(
        req.params.id,
        { kind: 'edo', matchId: req.params.matchId },
        req.body,
      );
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
      const result = await setPurpose(
        req.params.id,
        { kind: 'source', docId: req.params.docId },
        req.body,
      );
      if (result.code !== 200) return reply.code(result.code).send({ error: result.error });
      return await respond(result.id, result.siteId, req.user?.role);
    },
  );

  app.patch(
    '/api/v1/deliveries/:id/edo-matches/:matchId/purpose',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager', 'monitor')],
      schema: { params: EdoParams, body: PurposeBody, response: Responses },
    },
    async (req, reply) => {
      if (!['admin', 'manager', 'monitor'].includes(req.user?.role ?? ''))
        return reply.code(403).send({ error: 'forbidden' });
      await assertPermission(req, 'operations.deliveries', 'review');
      const result = await setPurpose(
        req.params.id,
        { kind: 'edo', matchId: req.params.matchId },
        req.body,
      );
      if (result.code !== 200) return reply.code(result.code).send({ error: result.error });
      return await respond(result.id, result.siteId, req.user?.role);
    },
  );
}
