import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { and, asc, desc, eq, isNotNull, isNull, ne, or, sql as drSql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import { ErrorResponseSchema } from '@matcheck/contracts';
import type { Db } from '../db/client.js';
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
import { findEdoCandidates } from '../domain/operations/edo-candidates.js';
import { toIsoDate } from '../domain/edo/export-upd.js';
import { decodeXmlBuffer } from '../domain/edo/upd-xml-decode.js';
import { parseUpdXml, type UpdParsed } from '../domain/edo/upd.parser.js';
import {
  renderUpdPdf,
  UPD_PDF_MAX_ITEMS,
  UPD_PDF_MAX_XML_BYTES,
} from '../domain/edo/upd-review-pdf.js';
import { getObject, presign } from '../domain/storage/s3.signer.js';
import { createBoundedLimiter, LimiterBusyError } from '../lib/bounded-limiter.js';
import { publishEvent } from './events.js';

const FoundBySchema = z.enum(['number', 'inn', 'name', 'date', 'search']);

const EdoCandidateSchema = z.object({
  id: z.string().uuid(),
  source: z.enum(['import', 'export']),
  contentCategory: z.string().nullable(),
  docNumber: z.string().nullable(),
  docDate: z.string().nullable(),
  supplierName: z.string().nullable(),
  supplierInn: z.string().nullable(),
  totalSum: z.string().nullable(),
  siteId: z.string().uuid().nullable(),
  usedElsewhere: z.number().int(),
  foundBy: z.array(FoundBySchema),
  reference: z.object({
    origin: z.enum(['paper', 'photo', 'delivery']),
    label: z.string().nullable(),
  }),
  score: z.number().int(),
  level: z.enum(['high', 'possible', 'weak']),
  matches: z.array(z.string()),
  conflicts: z.array(z.string()),
  missing: z.array(z.string()),
  otherSupplier: z.boolean(),
  supplierCheck: z.object({
    documentInns: z.array(z.string()),
    referenceInns: z.array(z.string()),
    matchedInn: z.string().nullable(),
  }),
});

const EdoPreviewSchema = z.object({
  docNumber: z.string().nullable(),
  docDate: z.string().nullable(),
  supplierName: z.string().nullable(),
  supplierInn: z.string().nullable(),
  buyerName: z.string().nullable(),
  buyerInn: z.string().nullable(),
  totalSum: z.number().nullable(),
  vatSum: z.number().nullable(),
  shippedAt: z.string().nullable(),
  items: z.array(
    z.object({
      lineNo: z.number().int(),
      nameRaw: z.string(),
      qty: z.number(),
      unit: z.string().nullable(),
      price: z.number().nullable(),
      sum: z.number().nullable(),
    }),
  ),
});
type EdoPreview = z.infer<typeof EdoPreviewSchema>;

/**
 * Документ реестра, который можно открыть из окна подбора — файлом или PDF.
 *
 * Условия — статус и состав, те же, что у списка кандидатов (queryExport).
 * Правила ВЫБОРА кандидата (уже привязан к этой приёмке, привязан на другом
 * объекте, есть импортированная копия) сюда намеренно не входят: это не права
 * на чтение, тот же XML менеджер и так получает.
 */
function openableExportDocument(documentId: string) {
  return and(
    eq(edoExportDocuments.id, documentId),
    eq(edoExportDocuments.status, 'stored'),
    isNotNull(edoExportDocuments.s3Key),
    or(
      eq(edoExportDocuments.contentCategory, 'materials'),
      eq(edoExportDocuments.contentCategory, 'undetermined'),
      isNull(edoExportDocuments.contentCategory),
    ),
  );
}

/** Чем закончилась сборка PDF внутри слота: файл или причина отказа. */
type ExportPdfOutcome =
  | { kind: 'ok'; pdf: Buffer; docNumber: string }
  | { kind: 'storage_failed' | 'too_large' | 'parse_failed' | 'render_failed' };

/**
 * Ответы об отказе. Код ошибки `apiDownload` на фронте не доносит — он
 * показывает `message`, поэтому текст здесь и есть то, что увидит менеджер.
 */
const PDF_TOO_LARGE = {
  error: 'too_large',
  message: 'Документ слишком большой для просмотра — откройте XML',
} as const;

/** Имя файла из номера УПД: номер приходит из XML, в имя — только безопасное. */
function pdfFilename(docNumber: string): string {
  const safe = docNumber.trim().replace(/[^\p{L}\p{N}._-]+/gu, '_');
  return `УПД_${safe || 'без_номера'}.pdf`;
}

function toNumber(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Импортированная УПД уже разобрана — позиции берём из базы, без S3. */
async function previewImported(db: Db, documentId: string): Promise<EdoPreview | 'not_found'> {
  const directory = alias(suppliers, 'preview_directory');
  const supplier = alias(counterparties, 'preview_supplier');
  const [document] = await db
    .select({
      docNumber: sourceDocuments.docNumber,
      docDate: sourceDocuments.docDate,
      supplierName: drSql<string | null>`coalesce(${directory.name}, ${supplier.name})`,
      supplierInn: sourceDocuments.supplierInnRaw,
      buyerName: sourceDocuments.buyerNameRaw,
      buyerInn: sourceDocuments.buyerInnRaw,
      totalSum: sourceDocuments.totalSum,
      vatSum: sourceDocuments.vatSum,
    })
    .from(sourceDocuments)
    .leftJoin(directory, eq(sourceDocuments.supplierDirectoryId, directory.id))
    .leftJoin(supplier, eq(sourceDocuments.supplierId, supplier.id))
    .where(
      and(
        eq(sourceDocuments.id, documentId),
        eq(sourceDocuments.origin, 'edo_diadoc'),
        eq(sourceDocuments.kind, 'upd'),
      ),
    )
    .limit(1);
  if (!document) return 'not_found';
  const items = await db
    .select({
      lineNo: sourceDocumentItems.lineNo,
      nameRaw: sourceDocumentItems.nameRaw,
      qty: sourceDocumentItems.qty,
      unit: sourceDocumentItems.unit,
      price: sourceDocumentItems.price,
      sum: sourceDocumentItems.sum,
    })
    .from(sourceDocumentItems)
    .where(eq(sourceDocumentItems.sourceDocumentId, documentId))
    .orderBy(asc(sourceDocumentItems.lineNo));
  return {
    docNumber: document.docNumber,
    docDate: document.docDate?.toISOString().slice(0, 10) ?? null,
    supplierName: document.supplierName,
    supplierInn: document.supplierInn,
    buyerName: document.buyerName,
    buyerInn: document.buyerInn,
    totalSum: toNumber(document.totalSum),
    vatSum: toNumber(document.vatSum),
    shippedAt: null,
    items: items.map((item) => ({
      lineNo: item.lineNo,
      nameRaw: item.nameRaw,
      qty: toNumber(item.qty) ?? 0,
      unit: item.unit,
      price: toNumber(item.price),
      sum: toNumber(item.sum),
    })),
  };
}

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

export function registerDeliveryEdoRoutes(rawApp: FastifyInstance): void {
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
        .where(openableExportDocument(req.params.documentId))
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

  // PDF-представление УПД из реестра — сверка с бумагой глазами. Только
  // чтение: XML из S3 → разбор → PDF в ответе, ничего не сохраняется.
  //
  // Весь путь (чтение S3, разбор, рендер) идёт в одном слоте ограничителя:
  // ограничивать один рендер мало — память держат и прочитанный XML, и
  // разобранное дерево. Сверх очереди — сразу 503, а не копить запросы.
  const pdfSlot = createBoundedLimiter({ concurrency: 2, maxQueue: 8 });

  async function buildExportPdf(
    s3Key: string,
    documentId: string,
    log: FastifyBaseLogger,
  ): Promise<ExportPdfOutcome> {
    let buffer: Buffer;
    try {
      buffer = await getObject(s3Key);
    } catch (err) {
      log.warn({ err, documentId }, 'edo pdf: s3 read failed');
      return { kind: 'storage_failed' };
    }
    // Размер уже сверен по реестру, но строка реестра могла разойтись с объектом.
    if (buffer.length > UPD_PDF_MAX_XML_BYTES) return { kind: 'too_large' };
    let parsed: UpdParsed;
    try {
      parsed = parseUpdXml(decodeXmlBuffer(buffer));
    } catch (err) {
      log.warn({ err, documentId }, 'edo pdf: xml parse failed');
      return { kind: 'parse_failed' };
    }
    if (parsed.items.length > UPD_PDF_MAX_ITEMS) return { kind: 'too_large' };
    try {
      const { pdf, warnings } = await renderUpdPdf(parsed);
      if (warnings.length) {
        log.info({ documentId, warnings }, 'edo pdf: parse incomplete, flagged in document');
      }
      return { kind: 'ok', pdf, docNumber: parsed.docNumber };
    } catch (err) {
      log.error({ err, documentId }, 'edo pdf: render failed');
      return { kind: 'render_failed' };
    }
  }

  app.get(
    '/api/v1/deliveries/:id/edo-candidates/export/:documentId/pdf',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid(), documentId: z.string().uuid() }),
        response: {
          // Только для типов: Buffer Fastify отдаёт как есть, мимо сериализатора.
          200: z.custom<Buffer>((value) => Buffer.isBuffer(value)),
          404: ErrorResponseSchema,
          413: ErrorResponseSchema,
          422: ErrorResponseSchema,
          502: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [delivery] = await app.db
        .select({ id: deliveries.id })
        .from(deliveries)
        .where(eq(deliveries.id, req.params.id))
        .limit(1);
      if (!delivery) {
        return reply.code(404).send({ error: 'not_found', message: 'Приёмка не найдена' });
      }
      const [document] = await app.db
        .select({ s3Key: edoExportDocuments.s3Key, sizeBytes: edoExportDocuments.sizeBytes })
        .from(edoExportDocuments)
        .where(openableExportDocument(req.params.documentId))
        .limit(1);
      if (!document?.s3Key) {
        return reply
          .code(404)
          .send({ error: 'file_not_found', message: 'Документ не найден в реестре ЭДО' });
      }
      // Размер — из реестра и ДО чтения: getObject держит объект в памяти целиком.
      // У сохранённых строк он есть всегда (export-upd.ts пишет его вместе с
      // ключом); пустой — аномалия, читать вслепую не будем.
      if (document.sizeBytes === null) {
        return reply.code(413).send({
          error: 'size_unknown',
          message: 'Размер файла в реестре не указан — откройте XML',
        });
      }
      if (document.sizeBytes > UPD_PDF_MAX_XML_BYTES) {
        return reply.code(413).send(PDF_TOO_LARGE);
      }

      const s3Key = document.s3Key;
      let outcome: ExportPdfOutcome;
      try {
        outcome = await pdfSlot(() => buildExportPdf(s3Key, req.params.documentId, req.log));
      } catch (err) {
        if (!(err instanceof LimiterBusyError)) throw err;
        req.log.warn(
          { documentId: req.params.documentId, ...pdfSlot.stats() },
          'edo pdf: queue full',
        );
        reply.header('retry-after', '5');
        return reply.code(503).send({
          error: 'busy',
          message: 'Сервер занят построением других PDF — повторите через несколько секунд',
        });
      }

      switch (outcome.kind) {
        case 'storage_failed':
          return reply.code(502).send({
            error: 'storage_failed',
            message: 'Не удалось прочитать УПД из хранилища — попробуйте ещё раз',
          });
        case 'too_large':
          return reply.code(413).send(PDF_TOO_LARGE);
        case 'parse_failed':
          return reply
            .code(422)
            .send({ error: 'parse_failed', message: 'Файл УПД не разобрался — откройте XML' });
        case 'render_failed':
          return reply
            .code(502)
            .send({ error: 'render_failed', message: 'Не удалось построить PDF — откройте XML' });
        case 'ok':
          reply
            .code(200)
            .header('content-type', 'application/pdf')
            .header(
              'content-disposition',
              `inline; filename*=UTF-8''${encodeURIComponent(pdfFilename(outcome.docNumber))}`,
            )
            .header('cache-control', 'private, max-age=600')
            .header('x-content-type-options', 'nosniff');
          return reply.send(outcome.pdf);
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

  // Подбор УПД из ЭДО к приёмке. Связь не создаётся: несколько документов
  // бывают с одинаковыми датой и суммой, выбор всегда за менеджером. Правила
  // поиска и сверки — в domain/operations/edo-candidates.ts.
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
            truncated: z.array(FoundBySchema),
            diagnostics: z.object({
              registryReceivedUntil: z.string().nullable(),
              registryAsOf: z
                .object({ at: z.string(), basis: z.enum(['checked', 'received']) })
                .nullable(),
              referencesAfterRegistry: z.array(
                z.object({ label: z.string().nullable(), date: z.string() }),
              ),
              registry: z.array(
                z.object({
                  accountId: z.string().uuid(),
                  name: z.string(),
                  state: z.enum(['never', 'catching_up', 'stale', 'ok']),
                  checkedAt: z.string().nullable(),
                  failedPending: z.number().int(),
                  nextRetryAt: z.string().nullable(),
                  failedFinal: z.number().int(),
                }),
              ),
              census: z
                .object({
                  count: z.number().int(),
                  withoutUtd: z.number().int(),
                  lastReceivedAt: z.string().nullable(),
                  categories: z.array(z.string()),
                  fromTitle: z.string().nullable(),
                })
                .nullable(),
              innsAbsentInRegistry: z.array(z.string()),
              innUnreadable: z.boolean(),
              contractorDelivery: z.boolean(),
              dateOnly: z.boolean(),
            }),
          }),
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const result = await findEdoCandidates(app.db, req.params.id, { q: req.query.q });
      if (!result) return reply.code(404).send({ error: 'not_found' });
      return result;
    },
  );

  // Просмотр УПД перед привязкой: шапка и позиции вместо сырого XML.
  app.get(
    '/api/v1/deliveries/:id/edo-candidates/:source/:documentId/preview',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({
          id: z.string().uuid(),
          source: z.enum(['import', 'export']),
          documentId: z.string().uuid(),
        }),
        response: {
          200: EdoPreviewSchema,
          404: ErrorResponseSchema,
          502: ErrorResponseSchema,
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
      const result =
        req.params.source === 'export'
          ? await previewExported(req.params.documentId, req.log)
          : await previewImported(app.db, req.params.documentId);
      if (result === 'not_found') return reply.code(404).send({ error: 'not_found' });
      if (result === 'storage_failed') {
        return reply.code(502).send({
          error: 'storage_failed',
          message: 'Не удалось прочитать УПД из хранилища — попробуйте ещё раз',
        });
      }
      if (result === 'parse_failed') {
        return reply.code(502).send({
          error: 'parse_failed',
          message: 'Файл УПД не разобрался — откройте его кнопкой «Открыть файл»',
        });
      }
      return result;
    },
  );

  async function previewExported(
    documentId: string,
    log: FastifyBaseLogger,
  ): Promise<EdoPreview | 'not_found' | 'storage_failed' | 'parse_failed'> {
    const [document] = await app.db
      .select({ s3Key: edoExportDocuments.s3Key })
      .from(edoExportDocuments)
      .where(
        and(
          eq(edoExportDocuments.id, documentId),
          eq(edoExportDocuments.status, 'stored'),
          isNotNull(edoExportDocuments.s3Key),
        ),
      )
      .limit(1);
    if (!document?.s3Key) return 'not_found';
    let buffer: Buffer;
    try {
      buffer = await getObject(document.s3Key);
    } catch (err) {
      log.warn({ err, documentId }, 'edo preview: s3 read failed');
      return 'storage_failed';
    }
    let parsed: UpdParsed;
    try {
      parsed = parseUpdXml(decodeXmlBuffer(buffer));
    } catch (err) {
      log.warn({ err, documentId }, 'edo preview: xml parse failed');
      return 'parse_failed';
    }
    return {
      docNumber: parsed.docNumber || null,
      docDate: toIsoDate(parsed.docDate),
      supplierName: parsed.supplier.name || null,
      supplierInn: parsed.supplier.inn || null,
      buyerName: parsed.recipient?.name || null,
      buyerInn: parsed.recipient?.inn || null,
      totalSum: parsed.totalSum,
      vatSum: parsed.vatSum,
      shippedAt: toIsoDate(parsed.transfer?.date ?? null),
      items: parsed.items.map((item) => ({
        lineNo: item.lineNo,
        nameRaw: item.nameRaw,
        qty: item.qty,
        unit: item.unit || null,
        price: item.price,
        sum: item.sum,
      })),
    };
  }
}
