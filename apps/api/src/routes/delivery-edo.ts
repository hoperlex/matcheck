import type { FastifyInstance } from 'fastify';
import {
  and,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql as drSql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import {
  ErrorResponseSchema,
  type Delivery,
  type OperationSourceDocument,
} from '@matcheck/contracts';
import {
  counterparties,
  deliveries,
  deliveryEdoMatches,
  deliverySources,
  edoExportDocuments,
  sourceDocumentAttachments,
  sourceDocumentItems,
  sourceDocuments,
  suppliers,
} from '../db/schema.js';
import {
  normalizeDocumentNumber,
  rankEdoAgainstReferences,
} from '../domain/operations/edo-match.js';
import { presign } from '../domain/storage/s3.signer.js';
import { escapeLike } from '../lib/like.js';
import { publishEvent } from './events.js';

const EdoCandidateSchema = z.object({
  id: z.string().uuid(),
  source: z.enum(['import', 'export']),
  contentCategory: z.string().nullable(),
  paperDocNumber: z.string().nullable(),
  docNumber: z.string().nullable(),
  docDate: z.string().nullable(),
  supplierName: z.string().nullable(),
  supplierInn: z.string().nullable(),
  totalSum: z.string().nullable(),
  siteId: z.string().uuid().nullable(),
  usedElsewhere: z.number().int(),
  score: z.number().int(),
  level: z.enum(['high', 'possible', 'weak']),
  matches: z.array(z.string()),
  conflicts: z.array(z.string()),
  missing: z.array(z.string()),
});

const LinkedEdoDocumentSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  source: z.enum(['import', 'export']),
  docNumber: z.string().nullable(),
  docDate: z.string().nullable(),
  supplierName: z.string().nullable(),
  supplierInn: z.string().nullable(),
  totalSum: z.string().nullable(),
  linkedAt: z.string(),
});

export function registerDeliveryEdoRoutes(
  rawApp: FastifyInstance,
  getDelivery: (id: string, viewerRole?: string | null) => Promise<Delivery | null>,
): void {
  const app = asZod(rawApp);
  app.get(
    '/api/v1/deliveries/:id/edo-matches',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: z.object({ items: z.array(LinkedEdoDocumentSchema) }),
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [delivery] = await app.db
        .select({ id: deliveries.id })
        .from(deliveries)
        .where(eq(deliveries.id, req.params.id))
        .limit(1);
      if (!delivery) return reply.code(404).send({ error: 'not_found' });
      const supplier = alias(counterparties, 'linked_edo_supplier');
      const directory = alias(suppliers, 'linked_edo_directory');
      const rows = await app.db
        .select({
          id: deliveryEdoMatches.id,
          documentId: sourceDocuments.id,
          docNumber: sourceDocuments.docNumber,
          docDate: sourceDocuments.docDate,
          supplierName: drSql<string | null>`coalesce(${directory.name}, ${supplier.name})`,
          supplierInn: drSql<
            string | null
          >`coalesce(nullif(${sourceDocuments.supplierInnRaw}, ''), nullif(${directory.inn}, ''), nullif(${supplier.inn}, ''))`,
          totalSum: sourceDocuments.totalSum,
          linkedAt: deliveryEdoMatches.linkedAt,
        })
        .from(deliveryEdoMatches)
        .innerJoin(sourceDocuments, eq(deliveryEdoMatches.sourceDocumentId, sourceDocuments.id))
        .leftJoin(directory, eq(sourceDocuments.supplierDirectoryId, directory.id))
        .leftJoin(supplier, eq(sourceDocuments.supplierId, supplier.id))
        .where(eq(deliveryEdoMatches.deliveryId, delivery.id))
        .orderBy(deliveryEdoMatches.linkedAt);
      const exportedRows = await app.db
        .select({
          id: deliveryEdoMatches.id,
          documentId: edoExportDocuments.id,
          docNumber: edoExportDocuments.documentNumber,
          docDate: edoExportDocuments.documentDate,
          supplierName: edoExportDocuments.supplierName,
          supplierInn: edoExportDocuments.supplierInn,
          totalSum: edoExportDocuments.totalSum,
          linkedAt: deliveryEdoMatches.linkedAt,
        })
        .from(deliveryEdoMatches)
        .innerJoin(
          edoExportDocuments,
          eq(deliveryEdoMatches.exportDocumentId, edoExportDocuments.id),
        )
        .where(eq(deliveryEdoMatches.deliveryId, delivery.id));
      return {
        items: [
          ...rows.map((row: (typeof rows)[number]) => ({ ...row, source: 'import' as const })),
          ...exportedRows.map((row: (typeof exportedRows)[number]) => ({
            ...row,
            source: 'export' as const,
          })),
        ]
          .map((row) => ({
            ...row,
            docDate: row.docDate?.toISOString().slice(0, 10) ?? null,
            linkedAt: row.linkedAt.toISOString(),
          }))
          .sort((a, b) => a.linkedAt.localeCompare(b.linkedAt)),
      };
    },
  );

  app.get(
    '/api/v1/deliveries/:id/edo-matches/:matchId/file',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid(), matchId: z.string().uuid() }),
        response: {
          200: z.object({ url: z.string(), filename: z.string(), mimeType: z.string() }),
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [match] = await app.db
        .select({
          sourceDocumentId: deliveryEdoMatches.sourceDocumentId,
          exportDocumentId: deliveryEdoMatches.exportDocumentId,
        })
        .from(deliveryEdoMatches)
        .where(
          and(
            eq(deliveryEdoMatches.id, req.params.matchId),
            eq(deliveryEdoMatches.deliveryId, req.params.id),
          ),
        )
        .limit(1);
      if (!match) return reply.code(404).send({ error: 'not_found' });
      let file: { s3Key: string; filename: string; mimeType: string } | null = null;
      if (match.exportDocumentId) {
        const [record] = await app.db
          .select({ s3Key: edoExportDocuments.s3Key })
          .from(edoExportDocuments)
          .where(
            and(
              eq(edoExportDocuments.id, match.exportDocumentId),
              eq(edoExportDocuments.status, 'stored'),
            ),
          )
          .limit(1);
        if (record?.s3Key)
          file = {
            s3Key: record.s3Key,
            filename: record.s3Key.split('/').pop() ?? 'УПД.xml',
            mimeType: 'application/xml',
          };
      } else if (match.sourceDocumentId) {
        const [attachment] = await app.db
          .select({
            s3Key: sourceDocumentAttachments.s3Key,
            filename: sourceDocumentAttachments.filename,
            mimeType: sourceDocumentAttachments.mimeType,
          })
          .from(sourceDocumentAttachments)
          .where(
            and(
              eq(sourceDocumentAttachments.sourceDocumentId, match.sourceDocumentId),
              eq(sourceDocumentAttachments.role, 'original'),
            ),
          )
          .orderBy(desc(sourceDocumentAttachments.createdAt))
          .limit(1);
        if (attachment)
          file = {
            s3Key: attachment.s3Key,
            filename: attachment.filename,
            mimeType: attachment.mimeType ?? 'application/octet-stream',
          };
      }
      if (!file) return reply.code(404).send({ error: 'file_not_found' });
      try {
        return {
          url: await presign({ method: 'GET', key: file.s3Key, expiresIn: 3600 }),
          filename: file.filename,
          mimeType: file.mimeType,
        };
      } catch (err) {
        req.log.warn({ err, matchId: req.params.matchId }, 'edo match file presign failed');
        return reply.code(404).send({ error: 'file_not_found' });
      }
    },
  );

  app.get(
    '/api/v1/deliveries/:id/edo-candidates/export/:documentId/file',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid(), documentId: z.string().uuid() }),
        response: {
          200: z.object({ url: z.string(), filename: z.string(), mimeType: z.string() }),
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [delivery] = await app.db
        .select({ id: deliveries.id })
        .from(deliveries)
        .where(eq(deliveries.id, req.params.id))
        .limit(1);
      if (!delivery) return reply.code(404).send({ error: 'not_found' });
      const [document] = await app.db
        .select({ s3Key: edoExportDocuments.s3Key })
        .from(edoExportDocuments)
        .where(
          and(
            eq(edoExportDocuments.id, req.params.documentId),
            eq(edoExportDocuments.status, 'stored'),
            isNotNull(edoExportDocuments.s3Key),
            or(
              eq(edoExportDocuments.contentCategory, 'materials'),
              eq(edoExportDocuments.contentCategory, 'undetermined'),
              isNull(edoExportDocuments.contentCategory),
            ),
          ),
        )
        .limit(1);
      if (!document?.s3Key) return reply.code(404).send({ error: 'file_not_found' });
      try {
        return {
          url: await presign({ method: 'GET', key: document.s3Key, expiresIn: 3600 }),
          filename: document.s3Key.split('/').pop() ?? 'УПД.xml',
          mimeType: 'application/xml',
        };
      } catch (err) {
        req.log.warn(
          { err, documentId: req.params.documentId },
          'edo candidate file presign failed',
        );
        return reply.code(404).send({ error: 'file_not_found' });
      }
    },
  );

  app.post(
    '/api/v1/deliveries/:id/edo-matches',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ documentId: z.string().uuid(), source: z.enum(['import', 'export']) }),
        response: {
          200: z.object({ success: z.literal(true) }),
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      type Result =
        | 'ok'
        | 'not_found'
        | 'pending_deletion'
        | 'invalid_document'
        | 'foreign_site'
        | 'already_linked'
        | 'imported_available';
      const result: Result = await app.db.transaction(async (tx) => {
        const [delivery] = await tx
          .select({
            id: deliveries.id,
            siteId: deliveries.siteId,
            pendingDeletionAt: deliveries.pendingDeletionAt,
          })
          .from(deliveries)
          .where(eq(deliveries.id, req.params.id))
          .for('update')
          .limit(1);
        if (!delivery) return 'not_found';
        if (delivery.pendingDeletionAt) return 'pending_deletion';
        const documentId = req.body.documentId;
        const isImport = req.body.source === 'import';
        if (isImport) {
          const [document] = await tx
            .select({
              id: sourceDocuments.id,
              siteId: sourceDocuments.siteId,
              edoAccountId: sourceDocuments.edoAccountId,
              messageId: sourceDocuments.providerMessageId,
              entityId: sourceDocuments.providerEntityId,
            })
            .from(sourceDocuments)
            .where(
              and(
                eq(sourceDocuments.id, documentId),
                eq(sourceDocuments.kind, 'upd'),
                eq(sourceDocuments.direction, 'inbound'),
                eq(sourceDocuments.origin, 'edo_diadoc'),
                eq(sourceDocuments.status, 'parsed'),
                eq(sourceDocuments.isTechnical, false),
              ),
            )
            .for('update')
            .limit(1);
          if (!document) return 'invalid_document';
          if (document.siteId && document.siteId !== delivery.siteId) return 'foreign_site';
          const [foreignReference] = await tx
            .select({ id: deliveries.id })
            .from(deliveryEdoMatches)
            .innerJoin(deliveries, eq(deliveryEdoMatches.deliveryId, deliveries.id))
            .where(
              and(
                eq(deliveryEdoMatches.sourceDocumentId, documentId),
                ne(deliveries.siteId, delivery.siteId),
              ),
            )
            .limit(1);
          const [foreignSource] = await tx
            .select({ id: deliveries.id })
            .from(deliverySources)
            .innerJoin(deliveries, eq(deliverySources.deliveryId, deliveries.id))
            .where(
              and(
                eq(deliverySources.sourceDocumentId, documentId),
                ne(deliveries.siteId, delivery.siteId),
              ),
            )
            .limit(1);
          if (foreignReference || foreignSource) return 'foreign_site';
          const [alreadySource] = await tx
            .select({ id: deliverySources.sourceDocumentId })
            .from(deliverySources)
            .where(
              and(
                eq(deliverySources.deliveryId, delivery.id),
                eq(deliverySources.sourceDocumentId, documentId),
              ),
            )
            .limit(1);
          if (alreadySource) return 'already_linked';
          if (document.edoAccountId && document.messageId) {
            const [foreignExport] = await tx
              .select({ id: deliveries.id })
              .from(deliveryEdoMatches)
              .innerJoin(
                edoExportDocuments,
                eq(deliveryEdoMatches.exportDocumentId, edoExportDocuments.id),
              )
              .innerJoin(deliveries, eq(deliveryEdoMatches.deliveryId, deliveries.id))
              .where(
                and(
                  eq(edoExportDocuments.edoAccountId, document.edoAccountId),
                  eq(edoExportDocuments.messageId, document.messageId),
                  eq(edoExportDocuments.entityId, document.entityId),
                  ne(deliveries.siteId, delivery.siteId),
                ),
              )
              .limit(1);
            if (foreignExport) return 'foreign_site';
            const [alreadyExport] = await tx
              .select({ id: deliveryEdoMatches.id })
              .from(deliveryEdoMatches)
              .innerJoin(
                edoExportDocuments,
                eq(deliveryEdoMatches.exportDocumentId, edoExportDocuments.id),
              )
              .where(
                and(
                  eq(deliveryEdoMatches.deliveryId, delivery.id),
                  eq(edoExportDocuments.edoAccountId, document.edoAccountId),
                  eq(edoExportDocuments.messageId, document.messageId),
                  eq(edoExportDocuments.entityId, document.entityId),
                ),
              )
              .limit(1);
            if (alreadyExport) return 'already_linked';
          }
        } else {
          const [document] = await tx
            .select({
              id: edoExportDocuments.id,
              edoAccountId: edoExportDocuments.edoAccountId,
              messageId: edoExportDocuments.messageId,
              entityId: edoExportDocuments.entityId,
              contentCategory: edoExportDocuments.contentCategory,
            })
            .from(edoExportDocuments)
            .where(
              and(
                eq(edoExportDocuments.id, documentId),
                eq(edoExportDocuments.status, 'stored'),
                isNotNull(edoExportDocuments.s3Key),
                or(
                  eq(edoExportDocuments.contentCategory, 'materials'),
                  eq(edoExportDocuments.contentCategory, 'undetermined'),
                  isNull(edoExportDocuments.contentCategory),
                ),
              ),
            )
            .for('update')
            .limit(1);
          if (!document) return 'invalid_document';
          const [foreignReference] = await tx
            .select({ id: deliveries.id })
            .from(deliveryEdoMatches)
            .innerJoin(deliveries, eq(deliveryEdoMatches.deliveryId, deliveries.id))
            .where(
              and(
                eq(deliveryEdoMatches.exportDocumentId, documentId),
                ne(deliveries.siteId, delivery.siteId),
              ),
            )
            .limit(1);
          if (foreignReference) return 'foreign_site';
          const [imported] = await tx
            .select({ id: sourceDocuments.id })
            .from(sourceDocuments)
            .where(
              and(
                eq(sourceDocuments.edoAccountId, document.edoAccountId),
                eq(sourceDocuments.providerMessageId, document.messageId),
                eq(sourceDocuments.providerEntityId, document.entityId),
                eq(sourceDocuments.origin, 'edo_diadoc'),
                eq(sourceDocuments.status, 'parsed'),
                eq(sourceDocuments.isTechnical, false),
              ),
            )
            .limit(1);
          if (imported) return 'imported_available';
        }
        const [inserted] = await tx
          .insert(deliveryEdoMatches)
          .values({
            deliveryId: delivery.id,
            sourceDocumentId: isImport ? documentId : null,
            exportDocumentId: isImport ? null : documentId,
            linkedByUserId: req.user?.id ?? null,
          })
          .onConflictDoNothing()
          .returning({ id: deliveryEdoMatches.id });
        if (!inserted) return 'already_linked';
        return 'ok';
      });
      if (result !== 'ok') {
        const message = {
          not_found: 'Приёмка не найдена',
          pending_deletion: 'Приёмка помечена на удаление',
          invalid_document: 'УПД из ЭДО не найдена или файл недоступен',
          imported_available: 'УПД уже импортирована в портал — обновите список кандидатов',
          foreign_site: 'УПД относится к другому объекту',
          already_linked: 'УПД уже привязана к этой приёмке',
        }[result];
        return reply
          .code(result === 'not_found' || result === 'invalid_document' ? 404 : 409)
          .send({ error: result, message });
      }
      publishEvent(app, {
        type: 'delivery_updated',
        entityId: req.params.id,
        siteId:
          (
            await app.db
              .select({ siteId: deliveries.siteId })
              .from(deliveries)
              .where(eq(deliveries.id, req.params.id))
              .limit(1)
          )[0]?.siteId ?? undefined,
        ts: new Date().toISOString(),
      });
      return { success: true as const };
    },
  );

  app.delete(
    '/api/v1/deliveries/:id/edo-matches/:matchId',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid(), matchId: z.string().uuid() }),
        response: {
          200: z.object({ success: z.literal(true) }),
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const result = await app.db.transaction(async (tx) => {
        const [delivery] = await tx
          .select({
            siteId: deliveries.siteId,
            pendingDeletionAt: deliveries.pendingDeletionAt,
          })
          .from(deliveries)
          .where(eq(deliveries.id, req.params.id))
          .for('update')
          .limit(1);
        if (!delivery) return { status: 'not_found' as const };
        if (delivery.pendingDeletionAt) return { status: 'pending_deletion' as const };
        const [removed] = await tx
          .delete(deliveryEdoMatches)
          .where(
            and(
              eq(deliveryEdoMatches.deliveryId, req.params.id),
              eq(deliveryEdoMatches.id, req.params.matchId),
            ),
          )
          .returning({ id: deliveryEdoMatches.sourceDocumentId });
        if (!removed) return { status: 'not_found' as const };
        return { status: 'ok' as const, siteId: delivery.siteId };
      });
      if (result.status === 'not_found') return reply.code(404).send({ error: 'not_found' });
      if (result.status === 'pending_deletion')
        return reply.code(409).send({
          error: 'pending_deletion',
          message: 'Приёмка помечена на удаление',
        });
      publishEvent(app, {
        type: 'delivery_updated',
        entityId: req.params.id,
        siteId: result.siteId,
        ts: new Date().toISOString(),
      });
      return { success: true as const };
    },
  );

  // Сверка приёмки с импортированными УПД Диадока. Подбор не создаёт связь:
  // несколько документов могут иметь одинаковую дату и сумму, поэтому выбор
  // всегда остаётся за менеджером. Поиск идёт на сервере, а не среди первых
  // 200 строк общего списка документов.
  app.get(
    '/api/v1/deliveries/:id/edo-candidates',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({ q: z.string().trim().max(100).optional() }),
        response: {
          200: z.object({
            items: z.array(EdoCandidateSchema),
            referenceMissing: z.array(z.string()),
          }),
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const delivery = await getDelivery(req.params.id, req.user?.role);
      if (!delivery) return reply.code(404).send({ error: 'not_found' });

      const paperIds = (delivery.sourceDocuments ?? [])
        .filter((doc: OperationSourceDocument) => doc.linked)
        .map((doc: OperationSourceDocument) => doc.id);
      const paperSupplier = alias(counterparties, 'paper_supplier');
      const paperDirectory = alias(suppliers, 'paper_directory');
      const paperRows = paperIds.length
        ? await app.db
            .select({
              id: sourceDocuments.id,
              docNumber: sourceDocuments.docNumber,
              docDate: sourceDocuments.docDate,
              totalSum: sourceDocuments.totalSum,
              supplierInn: drSql<
                string | null
              >`coalesce(nullif(${sourceDocuments.supplierInnRaw}, ''), nullif(${paperDirectory.inn}, ''), nullif(${paperSupplier.inn}, ''))`,
              supplierName: drSql<
                string | null
              >`coalesce(${paperDirectory.name}, ${paperSupplier.name})`,
            })
            .from(sourceDocuments)
            .leftJoin(paperDirectory, eq(sourceDocuments.supplierDirectoryId, paperDirectory.id))
            .leftJoin(paperSupplier, eq(sourceDocuments.supplierId, paperSupplier.id))
            .where(
              and(
                inArray(sourceDocuments.id, paperIds),
                eq(sourceDocuments.kind, 'upd'),
                ne(sourceDocuments.origin, 'edo_diadoc'),
              ),
            )
        : [];
      const ownSupplier = delivery.supplierId
        ? await app.db
            .select({ name: counterparties.name, inn: counterparties.inn })
            .from(counterparties)
            .where(eq(counterparties.id, delivery.supplierId))
            .limit(1)
        : [];
      // Одна приёмка может иметь несколько бумажных УПД. Сверяем электронную
      // с каждой отдельно: общая сумма и материалы всей машины давали бы
      // ложные совпадения между разными документами.
      const references = paperRows.length
        ? paperRows.map((paper: (typeof paperRows)[number]) => ({
            paperDocNumber: paper.docNumber,
            numbers: paper.docNumber ? [paper.docNumber] : [],
            dates: paper.docDate ? [paper.docDate.toISOString().slice(0, 10)] : [],
            supplierInn: paper.supplierInn ?? ownSupplier[0]?.inn ?? null,
            supplierName: paper.supplierName ?? ownSupplier[0]?.name ?? null,
            sums: paper.totalSum ? [paper.totalSum] : [],
            itemNames: delivery.items
              .filter((item) => item.sourceDocumentId === paper.id)
              .map((item) => item.nameRaw),
            arrivedDate: delivery.arrivedAt?.slice(0, 10) ?? null,
          }))
        : [
            {
              paperDocNumber: null,
              numbers: [] as string[],
              dates: [] as string[],
              supplierInn: ownSupplier[0]?.inn ?? null,
              supplierName: ownSupplier[0]?.name ?? null,
              sums: [] as string[],
              itemNames: delivery.items.map((item: { nameRaw: string }) => item.nameRaw),
              arrivedDate: delivery.arrivedAt?.slice(0, 10) ?? null,
            },
          ];
      const referenceMissing = [
        references.every((ref) => !ref.numbers.length) && 'номер бумажной УПД',
        references.every((ref) => !ref.dates.length) && 'дата бумажной УПД',
        references.every((ref) => !ref.supplierInn && !ref.supplierName) && 'поставщик',
        references.every((ref) => !ref.sums.length) && 'сумма бумажной УПД',
        references.every((ref) => !ref.itemNames.length) && 'материалы приёмки',
      ].filter((value): value is string => typeof value === 'string');

      const candidateSupplier = alias(counterparties, 'candidate_supplier');
      const candidateDirectory = alias(suppliers, 'candidate_directory');
      const q = req.query.q?.trim() ?? '';
      const anchor =
        references.flatMap((ref) => ref.dates)[0] ??
        references[0]?.arrivedDate ??
        delivery.createdAt.slice(0, 10);
      const anchorTime = Date.parse(`${anchor}T00:00:00Z`);
      // postgres.js не принимает объект Date как параметр внутри drSql``.
      // Передаём границы как даты ISO и явно приводим их к date в PostgreSQL.
      const lower = new Date(anchorTime - 30 * 86_400_000).toISOString().slice(0, 10);
      const upper = new Date(anchorTime + 31 * 86_400_000).toISOString().slice(0, 10);
      const numberFilters = references
        .flatMap((ref) => ref.numbers)
        .map(
          (number: string) =>
            or(
              ilike(sourceDocuments.docNumber, `%${escapeLike(number)}%`),
              drSql`regexp_replace(translate(upper(coalesce(${sourceDocuments.docNumber}, '')), 'АВЕКМНОРСТУХ', 'ABEKMHOPCTYX'), '[^A-Z0-9А-ЯЁ]', '', 'g') = ${normalizeDocumentNumber(number)}`,
            )!,
        );
      const dateFilter = drSql`${sourceDocuments.docDate} >= ${lower}::date and ${sourceDocuments.docDate} < ${upper}::date`;
      const normalizedQ = normalizeDocumentNumber(q);
      const textFilter = q
        ? or(
            ilike(sourceDocuments.docNumber, `%${escapeLike(q)}%`),
            normalizedQ.length >= 3
              ? drSql`regexp_replace(translate(upper(coalesce(${sourceDocuments.docNumber}, '')), 'АВЕКМНОРСТУХ', 'ABEKMHOPCTYX'), '[^A-Z0-9А-ЯЁ]', '', 'g') like ${`%${normalizedQ}%`}`
              : undefined,
            ilike(sourceDocuments.originalFilename, `%${escapeLike(q)}%`),
            ilike(sourceDocuments.providerMessageId, `%${escapeLike(q)}%`),
            ilike(sourceDocuments.providerEntityId, `%${escapeLike(q)}%`),
            ilike(candidateSupplier.name, `%${escapeLike(q)}%`),
            ilike(candidateDirectory.name, `%${escapeLike(q)}%`),
            ilike(candidateSupplier.inn, `%${escapeLike(q)}%`),
            ilike(candidateDirectory.inn, `%${escapeLike(q)}%`),
            ilike(sourceDocuments.supplierInnRaw, `%${escapeLike(q)}%`),
          )
        : or(dateFilter, ...numberFilters);
      const candidates = await app.db
        .select({
          id: sourceDocuments.id,
          docNumber: sourceDocuments.docNumber,
          docDate: sourceDocuments.docDate,
          supplierName: drSql<
            string | null
          >`coalesce(${candidateDirectory.name}, ${candidateSupplier.name})`,
          supplierInn: drSql<
            string | null
          >`coalesce(nullif(${sourceDocuments.supplierInnRaw}, ''), nullif(${candidateDirectory.inn}, ''), nullif(${candidateSupplier.inn}, ''))`,
          totalSum: sourceDocuments.totalSum,
          siteId: sourceDocuments.siteId,
        })
        .from(sourceDocuments)
        .leftJoin(
          candidateDirectory,
          eq(sourceDocuments.supplierDirectoryId, candidateDirectory.id),
        )
        .leftJoin(candidateSupplier, eq(sourceDocuments.supplierId, candidateSupplier.id))
        .where(
          and(
            eq(sourceDocuments.kind, 'upd'),
            eq(sourceDocuments.direction, 'inbound'),
            eq(sourceDocuments.origin, 'edo_diadoc'),
            eq(sourceDocuments.status, 'parsed'),
            eq(sourceDocuments.isTechnical, false),
            or(eq(sourceDocuments.siteId, delivery.siteId), isNull(sourceDocuments.siteId)),
            drSql`not exists (select 1 from delivery_edo_matches dem where dem.delivery_id = ${delivery.id} and dem.source_document_id = ${sourceDocuments.id})`,
            drSql`not exists (
              select 1 from delivery_edo_matches dem join edo_export_documents exported on exported.id = dem.export_document_id
              where dem.delivery_id = ${delivery.id}
                and exported.edo_account_id = ${sourceDocuments.edoAccountId}
                and exported.message_id = ${sourceDocuments.providerMessageId}
                and exported.entity_id = ${sourceDocuments.providerEntityId}
            )`,
            drSql`not exists (
              select 1 from delivery_edo_matches dem
              join edo_export_documents exported on exported.id = dem.export_document_id
              join deliveries other_delivery on other_delivery.id = dem.delivery_id
              where exported.edo_account_id = ${sourceDocuments.edoAccountId}
                and exported.message_id = ${sourceDocuments.providerMessageId}
                and exported.entity_id = ${sourceDocuments.providerEntityId}
                and other_delivery.site_id <> ${delivery.siteId}
            )`,
            drSql`not exists (select 1 from delivery_sources ds where ds.delivery_id = ${delivery.id} and ds.source_document_id = ${sourceDocuments.id})`,
            drSql`not exists (
              select 1 from delivery_edo_matches dem join deliveries other_delivery on other_delivery.id = dem.delivery_id
              where dem.source_document_id = ${sourceDocuments.id} and other_delivery.site_id <> ${delivery.siteId}
            )`,
            drSql`not exists (
              select 1 from delivery_sources ds join deliveries other_delivery on other_delivery.id = ds.delivery_id
              where ds.source_document_id = ${sourceDocuments.id} and other_delivery.site_id <> ${delivery.siteId}
            )`,
            textFilter,
          ),
        )
        .orderBy(
          numberFilters.length
            ? drSql`case when ${or(...numberFilters)} then 0 else 1 end`
            : drSql`1`,
          desc(sourceDocuments.docDate),
          desc(sourceDocuments.createdAt),
        )
        .limit(500);
      const exportNumberFilters = references
        .flatMap((ref) => ref.numbers)
        .map(
          (number) =>
            or(
              ilike(edoExportDocuments.documentNumber, `%${escapeLike(number)}%`),
              drSql`regexp_replace(translate(upper(coalesce(${edoExportDocuments.documentNumber}, '')), 'АВЕКМНОРСТУХ', 'ABEKMHOPCTYX'), '[^A-Z0-9А-ЯЁ]', '', 'g') = ${normalizeDocumentNumber(number)}`,
            )!,
        );
      const exportTextFilter = q
        ? or(
            ilike(edoExportDocuments.documentNumber, `%${escapeLike(q)}%`),
            normalizedQ.length >= 3
              ? drSql`regexp_replace(translate(upper(coalesce(${edoExportDocuments.documentNumber}, '')), 'АВЕКМНОРСТУХ', 'ABEKMHOPCTYX'), '[^A-Z0-9А-ЯЁ]', '', 'g') like ${`%${normalizedQ}%`}`
              : undefined,
            ilike(edoExportDocuments.supplierName, `%${escapeLike(q)}%`),
            ilike(edoExportDocuments.supplierInn, `%${escapeLike(q)}%`),
            ilike(edoExportDocuments.s3Key, `%${escapeLike(q)}%`),
            ilike(edoExportDocuments.messageId, `%${escapeLike(q)}%`),
            ilike(edoExportDocuments.entityId, `%${escapeLike(q)}%`),
          )
        : or(
            drSql`${edoExportDocuments.documentDate} >= ${lower}::date and ${edoExportDocuments.documentDate} < ${upper}::date`,
            ...exportNumberFilters,
          );
      const exportedCandidates = await app.db
        .select({
          id: edoExportDocuments.id,
          docNumber: edoExportDocuments.documentNumber,
          docDate: edoExportDocuments.documentDate,
          supplierName: edoExportDocuments.supplierName,
          supplierInn: edoExportDocuments.supplierInn,
          totalSum: edoExportDocuments.totalSum,
          contentCategory: edoExportDocuments.contentCategory,
        })
        .from(edoExportDocuments)
        .where(
          and(
            eq(edoExportDocuments.status, 'stored'),
            isNotNull(edoExportDocuments.s3Key),
            or(
              eq(edoExportDocuments.contentCategory, 'materials'),
              eq(edoExportDocuments.contentCategory, 'undetermined'),
              isNull(edoExportDocuments.contentCategory),
            ),
            drSql`not exists (select 1 from delivery_edo_matches dem where dem.delivery_id = ${delivery.id} and dem.export_document_id = ${edoExportDocuments.id})`,
            drSql`not exists (
          select 1 from delivery_edo_matches dem join deliveries other_delivery on other_delivery.id = dem.delivery_id
          where dem.export_document_id = ${edoExportDocuments.id} and other_delivery.site_id <> ${delivery.siteId}
        )`,
            drSql`not exists (
          select 1 from source_documents imported
          where imported.edo_account_id = ${edoExportDocuments.edoAccountId}
            and imported.provider_message_id = ${edoExportDocuments.messageId}
            and imported.provider_entity_id = ${edoExportDocuments.entityId}
            and imported.origin = 'edo_diadoc' and imported.status = 'parsed'
            and imported.is_technical = false
        )`,
            exportTextFilter,
          ),
        )
        .orderBy(
          exportNumberFilters.length
            ? drSql`case when ${or(...exportNumberFilters)} then 0 else 1 end`
            : drSql`1`,
          desc(edoExportDocuments.documentDate),
          desc(edoExportDocuments.createdAt),
        )
        .limit(500);
      const candidateIds = candidates.map((doc: { id: string }) => doc.id);
      const candidateItems = candidateIds.length
        ? await app.db
            .select({
              sourceDocumentId: sourceDocumentItems.sourceDocumentId,
              nameRaw: sourceDocumentItems.nameRaw,
            })
            .from(sourceDocumentItems)
            .where(inArray(sourceDocumentItems.sourceDocumentId, candidateIds))
        : [];
      const links = candidateIds.length
        ? await app.db
            .select({
              sourceDocumentId: deliveryEdoMatches.sourceDocumentId,
              count: drSql<number>`count(*)::int`,
            })
            .from(deliveryEdoMatches)
            .where(inArray(deliveryEdoMatches.sourceDocumentId, candidateIds))
            .groupBy(deliveryEdoMatches.sourceDocumentId)
        : [];
      const sourceLinks = candidateIds.length
        ? await app.db
            .select({
              sourceDocumentId: deliverySources.sourceDocumentId,
              count: drSql<number>`count(*)::int`,
            })
            .from(deliverySources)
            .where(inArray(deliverySources.sourceDocumentId, candidateIds))
            .groupBy(deliverySources.sourceDocumentId)
        : [];
      const exportIds = exportedCandidates.map((doc) => doc.id);
      const exportLinks = exportIds.length
        ? await app.db
            .select({
              exportDocumentId: deliveryEdoMatches.exportDocumentId,
              count: drSql<number>`count(*)::int`,
            })
            .from(deliveryEdoMatches)
            .where(inArray(deliveryEdoMatches.exportDocumentId, exportIds))
            .groupBy(deliveryEdoMatches.exportDocumentId)
        : [];
      const namesById = new Map<string, string[]>();
      for (const item of candidateItems) {
        const names = namesById.get(item.sourceDocumentId) ?? [];
        names.push(item.nameRaw);
        namesById.set(item.sourceDocumentId, names);
      }
      const linkCount = new Map<string, number>();
      for (const link of links) {
        if (link.sourceDocumentId) linkCount.set(link.sourceDocumentId, link.count);
      }
      for (const link of sourceLinks) {
        linkCount.set(
          link.sourceDocumentId,
          (linkCount.get(link.sourceDocumentId) ?? 0) + link.count,
        );
      }
      const exportLinkCount = new Map<string, number>();
      for (const link of exportLinks) {
        if (link.exportDocumentId) exportLinkCount.set(link.exportDocumentId, link.count);
      }
      const importedItems = candidates.map((doc: (typeof candidates)[number]) => {
        const docDate = doc.docDate?.toISOString().slice(0, 10) ?? null;
        return {
          ...doc,
          source: 'import' as const,
          contentCategory: null,
          docDate,
          usedElsewhere: linkCount.get(doc.id) ?? 0,
          ...rankEdoAgainstReferences(references, {
            ...doc,
            docDate,
            itemNames: namesById.get(doc.id) ?? [],
          }),
        };
      });
      const exportedItems = exportedCandidates.map((doc) => {
        const docDate = doc.docDate?.toISOString().slice(0, 10) ?? null;
        const match = rankEdoAgainstReferences(references, { ...doc, docDate, itemNames: [] });
        return {
          ...doc,
          source: 'export' as const,
          siteId: null,
          docDate,
          usedElsewhere: exportLinkCount.get(doc.id) ?? 0,
          ...match,
          missing:
            doc.contentCategory === 'materials'
              ? match.missing
              : [...match.missing, 'тип содержимого УПД'],
        };
      });
      const items = [...importedItems, ...exportedItems].sort(
        (
          a: { score: number; docDate: string | null },
          b: { score: number; docDate: string | null },
        ) => b.score - a.score || (b.docDate ?? '').localeCompare(a.docDate ?? ''),
      );
      return { items, referenceMissing };
    },
  );
}
