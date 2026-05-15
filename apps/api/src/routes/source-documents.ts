import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, ilike, inArray, sql as drSql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import {
  LlmCallListResponseSchema,
  ManualUpdUploadRequestSchema,
  ManualUpdUploadResponseSchema,
  SourceDocumentDirectionUpdateSchema,
  SourceDocumentListResponseSchema,
  SourceDocumentDetailSchema,
  SourceDocumentFileResponseSchema,
  UpdAcknowledgeMismatchRequestSchema,
  UpdDuplicateConflictSchema,
  UpdPdfQueueRequestSchema,
  UpdPdfQueueResponseSchema,
  UpdResolveDuplicateRequestSchema,
  ErrorResponseSchema,
} from '@matcheck/contracts';
import {
  counterparties,
  deliveries,
  deliverySources,
  llmCalls,
  materials,
  shipmentSources,
  sites,
  sourceDocuments,
  sourceDocumentItems,
  sourceDocumentAttachments,
} from '../db/schema.js';
import { parseUpdXml } from '../domain/edo/upd.parser.js';
import { validateUpdTotals } from '../domain/edo/upd-validation.js';
import { presign, putObject } from '../domain/storage/s3.signer.js';
import { resolveStatusId } from '../domain/statuses/lookup.js';
import { publishEvent } from './events.js';

const ListQuerySchema = z.object({
  kind: z.enum(['upd', 'request']).optional(),
  direction: z.enum(['inbound', 'outbound']).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  unaccepted: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

async function findOrCreateMaterial(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  { name, unit }: { name: string; unit?: string | null },
): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('material name is empty');
  const existing = await app.db
    .select({ id: materials.id })
    .from(materials)
    .where(drSql`lower(${materials.name}) = lower(${trimmed})`)
    .limit(1);
  if (existing[0]) return existing[0].id;
  const [created] = await app.db
    .insert(materials)
    .values({ name: trimmed, unit: unit && unit.trim() ? unit.trim() : 'шт' })
    .returning({ id: materials.id });
  if (!created) throw new Error('Failed to create material');
  return created.id;
}

async function findOrCreateCounterparty(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  party: { inn: string; kpp: string | null; name: string },
  role: 'supplier' | 'customer',
): Promise<string> {
  const existing = await app.db
    .select({ id: counterparties.id })
    .from(counterparties)
    .where(
      and(
        eq(counterparties.inn, party.inn),
        party.kpp ? eq(counterparties.kpp, party.kpp) : drSql`${counterparties.kpp} is null`,
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0].id;
  const [created] = await app.db
    .insert(counterparties)
    .values({
      inn: party.inn,
      kpp: party.kpp,
      name: party.name,
      isSupplier: role === 'supplier',
      isCustomer: role === 'customer',
    })
    .returning({ id: counterparties.id });
  if (!created) throw new Error('Failed to create counterparty');
  return created.id;
}

type SdNames = {
  supplierName?: string | null;
  contractorName?: string | null;
  siteName?: string | null;
};

function sdRow(sd: typeof sourceDocuments.$inferSelect, names: SdNames = {}) {
  return {
    id: sd.id,
    kind: sd.kind,
    direction: sd.direction,
    status: sd.status,
    supplierId: sd.supplierId,
    recipientId: sd.recipientId,
    contractorId: sd.contractorId,
    siteId: sd.siteId,
    supplierName: names.supplierName ?? null,
    contractorName: names.contractorName ?? null,
    siteName: names.siteName ?? null,
    docNumber: sd.docNumber,
    docDate: sd.docDate?.toISOString().slice(0, 10) ?? null,
    totalSum: sd.totalSum,
    vatSum: sd.vatSum,
    expectedDate: sd.expectedDate?.toISOString().slice(0, 10) ?? null,
    origin: sd.origin,
    llmProviderId: sd.llmProviderId,
    llmConfidence: sd.llmConfidence,
    parsedAt: sd.parsedAt.toISOString(),
    queuedAt: sd.queuedAt?.toISOString() ?? null,
    processedAt: sd.processedAt?.toISOString() ?? null,
    parseErrorCode: (sd.parseErrorCode as
      | 'duplicate_upd'
      | 'validation_mismatch'
      | 'pdf_no_text'
      | 'parse_failed'
      | 'internal_error'
      | null) ?? null,
    parseErrorDetails: sd.parseErrorDetails ?? null,
    originalFilename: sd.originalFilename,
    contentHash: sd.contentHash,
    jobAttempts: sd.jobAttempts,
    version: sd.version,
    createdAt: sd.createdAt.toISOString(),
    updatedAt: sd.updatedAt.toISOString(),
    validation: sd.validation ?? null,
  };
}

function itemDto(i: typeof sourceDocumentItems.$inferSelect) {
  return {
    id: i.id,
    materialId: i.materialId,
    nameRaw: i.nameRaw,
    qty: i.qty,
    unit: i.unit,
    price: i.price,
    sum: i.sum,
    vatRate: i.vatRate,
    vatSum: i.vatSum,
    expectedDate: i.expectedDate?.toISOString().slice(0, 10) ?? null,
    lineNo: i.lineNo,
    volumeM3: i.volumeM3,
    massKg: i.massKg,
    volumeConfidence: i.volumeConfidence as 'low' | 'medium' | 'high' | null,
    groupName: i.groupName,
  };
}

function attachmentDto(a: typeof sourceDocumentAttachments.$inferSelect) {
  return {
    id: a.id,
    s3Key: a.s3Key,
    filename: a.filename,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    role: a.role,
  };
}

// Подтягивает имена supplier/contractor/site по ID документа. Используется
// в обработчиках, где sd получен без JOIN (insert/update/single fetch).
async function loadSdNames(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  sd: typeof sourceDocuments.$inferSelect,
): Promise<SdNames> {
  const [supplier, contractor, site] = await Promise.all([
    sd.supplierId
      ? app.db
          .select({ name: counterparties.name })
          .from(counterparties)
          .where(eq(counterparties.id, sd.supplierId))
          .limit(1)
      : Promise.resolve([] as { name: string }[]),
    sd.contractorId
      ? app.db
          .select({ name: counterparties.name })
          .from(counterparties)
          .where(eq(counterparties.id, sd.contractorId))
          .limit(1)
      : Promise.resolve([] as { name: string }[]),
    sd.siteId
      ? app.db
          .select({ name: sites.name })
          .from(sites)
          .where(eq(sites.id, sd.siteId))
          .limit(1)
      : Promise.resolve([] as { name: string }[]),
  ]);
  return {
    supplierName: supplier[0]?.name ?? null,
    contractorName: contractor[0]?.name ?? null,
    siteName: site[0]?.name ?? null,
  };
}

async function findOriginalAttachment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  sourceDocumentId: string,
) {
  const [att] = await app.db
    .select()
    .from(sourceDocumentAttachments)
    .where(
      and(
        eq(sourceDocumentAttachments.sourceDocumentId, sourceDocumentId),
        eq(sourceDocumentAttachments.role, 'original'),
      ),
    )
    .orderBy(desc(sourceDocumentAttachments.createdAt))
    .limit(1);
  return att ?? null;
}

class HasReferencesError extends Error {
  constructor(
    public readonly deliveries: number,
    public readonly shipments: number,
  ) {
    super(
      `УПД используется в приёмках (${deliveries}) или отгрузках (${shipments}) — сначала удалите их`,
    );
  }
}

// Поиск дубля УПД по тройке (supplier_id, doc_number, doc_date). Учитывается
// только kind='upd'. Используется и при /upload-upd, и при /confirm-upd-pdf.
async function findUpdDuplicate(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  {
    supplierId,
    docNumber,
    docDate,
  }: { supplierId: string | null; docNumber: string | null; docDate: Date | null },
): Promise<typeof sourceDocuments.$inferSelect | null> {
  if (!supplierId || !docNumber || !docDate) return null;
  const [existing] = await app.db
    .select()
    .from(sourceDocuments)
    .where(
      and(
        eq(sourceDocuments.kind, 'upd'),
        eq(sourceDocuments.supplierId, supplierId),
        eq(sourceDocuments.docNumber, docNumber),
        eq(sourceDocuments.docDate, docDate),
      ),
    )
    .limit(1);
  return existing ?? null;
}

function duplicateConflictPayload(sd: typeof sourceDocuments.$inferSelect) {
  return {
    error: 'duplicate_upd' as const,
    existing: {
      id: sd.id,
      docNumber: sd.docNumber,
      docDate: sd.docDate?.toISOString().slice(0, 10) ?? null,
      supplierId: sd.supplierId,
      totalSum: sd.totalSum,
      createdAt: sd.createdAt.toISOString(),
    },
  };
}

// Удаление УПД с проверкой привязок к приёмкам/отгрузкам. Бросает
// HasReferencesError, если есть привязки. Сами позиции, attachments и
// llm_calls удаляются каскадно по FK; реальная чистка S3-объектов
// выполняется асинхронно через очередь s3-cleanup (см. worker.ts), чтобы
// HTTP-ответ возвращался мгновенно.
async function deleteUpdWithRefsCheck(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  id: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log?: { warn: (...args: any[]) => void },
): Promise<void> {
  const [{ count: deliveriesCount } = { count: 0 }] = await app.db
    .select({ count: drSql<number>`count(*)::int` })
    .from(deliverySources)
    .where(eq(deliverySources.sourceDocumentId, id));
  const [{ count: shipmentsCount } = { count: 0 }] = await app.db
    .select({ count: drSql<number>`count(*)::int` })
    .from(shipmentSources)
    .where(eq(shipmentSources.sourceDocumentId, id));
  if (deliveriesCount > 0 || shipmentsCount > 0) {
    throw new HasReferencesError(deliveriesCount, shipmentsCount);
  }

  // Забираем s3-ключи ДО hard delete (cascade удалит строки attachments).
  const attachments = await app.db
    .select({ s3Key: sourceDocumentAttachments.s3Key })
    .from(sourceDocumentAttachments)
    .where(eq(sourceDocumentAttachments.sourceDocumentId, id));

  await app.db.delete(sourceDocuments).where(eq(sourceDocuments.id, id));

  const s3Keys = attachments
    .map((a: { s3Key: string }) => a.s3Key)
    .filter((k: string): k is string => Boolean(k));
  if (s3Keys.length > 0) {
    try {
      await app.queues.s3Cleanup.add(
        'cleanup',
        { s3Keys },
        { jobId: `sd-${id}` },
      );
    } catch (err) {
      // Падение enqueue не должно ронять удаление — БД уже консистентна,
      // S3-объекты при необходимости можно будет почистить вручную.
      log?.warn({ err, sourceDocumentId: id, s3Keys }, 'failed to enqueue s3 cleanup');
    }
  }
}

export async function sourceDocumentRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);
  app.get(
    '/api/v1/source-documents',
    {
      preHandler: [app.authenticate],
      schema: { querystring: ListQuerySchema, response: { 200: SourceDocumentListResponseSchema } },
    },
    async (req) => {
      const { kind, direction, q, unaccepted, limit, offset } = req.query;
      const conditions = [];
      if (kind) conditions.push(eq(sourceDocuments.kind, kind));
      if (direction) conditions.push(eq(sourceDocuments.direction, direction));
      if (q) conditions.push(ilike(sourceDocuments.docNumber, `%${q}%`));
      // inspector_kpp видит только документы своего объекта.
      // Без объекта — пустой результат.
      if (req.user?.role === 'inspector_kpp') {
        if (!req.user.siteId) {
          conditions.push(drSql`false`);
        } else {
          conditions.push(eq(sourceDocuments.siteId, req.user.siteId));
        }
      }
      // Фильтр «непринятые» имеет смысл только для входящих документов:
      // он смотрит привязки к deliveries. Для outbound — игнорируем.
      if (unaccepted && direction !== 'outbound') {
        const filledStatusId = await resolveStatusId(app, 'delivery', 'filled');
        const acceptedSub = app.db
          .select({ id: deliverySources.sourceDocumentId })
          .from(deliverySources)
          .innerJoin(deliveries, eq(deliveries.id, deliverySources.deliveryId))
          .where(eq(deliveries.statusId, filledStatusId));
        conditions.push(drSql`${sourceDocuments.id} not in ${acceptedSub}`);
      }
      const where = conditions.length ? and(...conditions) : undefined;
      const supplier = alias(counterparties, 'supplier');
      const contractor = alias(counterparties, 'contractor');
      const rows = await app.db
        .select({
          sd: sourceDocuments,
          supplierName: supplier.name,
          contractorName: contractor.name,
          siteName: sites.name,
        })
        .from(sourceDocuments)
        .leftJoin(supplier, eq(sourceDocuments.supplierId, supplier.id))
        .leftJoin(contractor, eq(sourceDocuments.contractorId, contractor.id))
        .leftJoin(sites, eq(sourceDocuments.siteId, sites.id))
        .where(where)
        .orderBy(desc(sourceDocuments.parsedAt))
        .limit(limit)
        .offset(offset);
      const [{ count } = { count: 0 }] = await app.db
        .select({ count: drSql<number>`count(*)::int` })
        .from(sourceDocuments)
        .where(where);
      return {
        items: rows.map((r) =>
          sdRow(r.sd, {
            supplierName: r.supplierName,
            contractorName: r.contractorName,
            siteName: r.siteName,
          }),
        ),
        total: count,
      };
    },
  );

  app.get(
    '/api/v1/source-documents/:id',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: SourceDocumentDetailSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const supplier = alias(counterparties, 'supplier');
      const contractor = alias(counterparties, 'contractor');
      const [row] = await app.db
        .select({
          sd: sourceDocuments,
          supplierName: supplier.name,
          contractorName: contractor.name,
          siteName: sites.name,
        })
        .from(sourceDocuments)
        .leftJoin(supplier, eq(sourceDocuments.supplierId, supplier.id))
        .leftJoin(contractor, eq(sourceDocuments.contractorId, contractor.id))
        .leftJoin(sites, eq(sourceDocuments.siteId, sites.id))
        .where(eq(sourceDocuments.id, req.params.id))
        .limit(1);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      const sd = row.sd;
      // inspector_kpp видит только документы своего объекта.
      if (
        req.user?.role === 'inspector_kpp' &&
        (!req.user.siteId || sd.siteId !== req.user.siteId)
      ) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const items = await app.db
        .select()
        .from(sourceDocumentItems)
        .where(eq(sourceDocumentItems.sourceDocumentId, sd.id))
        .orderBy(sourceDocumentItems.lineNo);
      const attachments = await app.db
        .select()
        .from(sourceDocumentAttachments)
        .where(eq(sourceDocumentAttachments.sourceDocumentId, sd.id));
      return {
        ...sdRow(sd, {
          supplierName: row.supplierName,
          contractorName: row.contractorName,
          siteName: row.siteName,
        }),
        items: items.map(itemDto),
        attachments: attachments.map(attachmentDto),
      };
    },
  );

  app.get(
    '/api/v1/source-documents/:id/file',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: SourceDocumentFileResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      // inspector_kpp видит файлы только документов своего объекта.
      if (req.user?.role === 'inspector_kpp') {
        const [sd] = await app.db
          .select({ siteId: sourceDocuments.siteId })
          .from(sourceDocuments)
          .where(eq(sourceDocuments.id, req.params.id))
          .limit(1);
        if (!sd || !req.user.siteId || sd.siteId !== req.user.siteId) {
          return reply.code(404).send({ error: 'not_found' });
        }
      }
      const att = await findOriginalAttachment(app, req.params.id);
      if (!att) return reply.code(404).send({ error: 'no_attachment' });
      try {
        const url = await presign({ method: 'GET', key: att.s3Key, expiresIn: 3600 });
        return { url, filename: att.filename, mimeType: att.mimeType };
      } catch (err) {
        req.log.warn({ err, key: att.s3Key }, 'presign failed');
        return reply.code(404).send({ error: 'presign_failed' });
      }
    },
  );

  // Стрим оригинала через бэкенд — same-origin для CSP `frame-src 'self' blob:`.
  // Браузер вызывает этот URL из <iframe>; presigned URL на S3 не покидает сервер.
  app.get(
    '/api/v1/source-documents/:id/file/raw',
    {
      preHandler: [app.authenticate],
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      // inspector_kpp видит файлы только документов своего объекта.
      if (req.user?.role === 'inspector_kpp') {
        const [sd] = await app.db
          .select({ siteId: sourceDocuments.siteId })
          .from(sourceDocuments)
          .where(eq(sourceDocuments.id, req.params.id))
          .limit(1);
        if (!sd || !req.user.siteId || sd.siteId !== req.user.siteId) {
          return reply.code(404).send({ error: 'not_found' });
        }
      }
      const att = await findOriginalAttachment(app, req.params.id);
      if (!att) return reply.code(404).send({ error: 'no_attachment' });

      let signedUrl: string;
      try {
        signedUrl = await presign({ method: 'GET', key: att.s3Key, expiresIn: 60 });
      } catch (err) {
        req.log.warn({ err, key: att.s3Key }, 'presign failed (raw)');
        return reply.code(404).send({ error: 'presign_failed' });
      }

      const upstreamHeaders: Record<string, string> = {};
      const range = req.headers.range;
      if (typeof range === 'string') upstreamHeaders.range = range;
      const inm = req.headers['if-none-match'];
      if (typeof inm === 'string') upstreamHeaders['if-none-match'] = inm;
      const ims = req.headers['if-modified-since'];
      if (typeof ims === 'string') upstreamHeaders['if-modified-since'] = ims;

      let upstream: Response;
      try {
        upstream = await fetch(signedUrl, { headers: upstreamHeaders });
      } catch (err) {
        req.log.warn({ err, key: att.s3Key }, 'S3 fetch failed');
        return reply.code(502).send({ error: 's3_unavailable' });
      }

      const ok = upstream.ok || upstream.status === 206 || upstream.status === 304;
      if (!ok) {
        req.log.warn(
          { status: upstream.status, key: att.s3Key },
          'S3 returned non-OK for raw fetch',
        );
        return reply.code(502).send({ error: 's3_unavailable' });
      }

      reply.code(upstream.status);
      for (const h of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        const v = upstream.headers.get(h);
        if (v) reply.header(h, v);
      }
      reply.header('content-type', att.mimeType);
      reply.header(
        'content-disposition',
        `inline; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
      );
      reply.header('cache-control', 'private, max-age=300');

      if (upstream.status === 304 || !upstream.body) {
        return reply.send();
      }
      return reply.send(Readable.fromWeb(upstream.body as never));
    },
  );

  app.post(
    '/api/v1/source-documents/upload-upd',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        body: ManualUpdUploadRequestSchema,
        response: {
          201: ManualUpdUploadResponseSchema,
          400: ErrorResponseSchema,
          409: UpdDuplicateConflictSchema.or(ErrorResponseSchema),
        },
      },
    },
    async (req, reply) => {
      let parsed;
      try {
        parsed = parseUpdXml(req.body.xml);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: 'upd_parse_failed', message: msg });
      }

      const supplierId = await findOrCreateCounterparty(app, parsed.supplier, 'supplier');
      const recipientId = parsed.recipient
        ? await findOrCreateCounterparty(app, parsed.recipient, 'customer')
        : null;
      const { contractorId, siteId, replaceExistingId } = req.body;

      const docDate = parsed.docDate ? new Date(parsed.docDate) : null;
      const duplicate = await findUpdDuplicate(app, {
        supplierId,
        docNumber: parsed.docNumber,
        docDate,
      });
      if (duplicate && duplicate.id !== replaceExistingId) {
        return reply.code(409).send(duplicateConflictPayload(duplicate));
      }
      if (duplicate && replaceExistingId === duplicate.id) {
        try {
          await deleteUpdWithRefsCheck(app, duplicate.id, req.log);
        } catch (err) {
          if (err instanceof HasReferencesError) {
            return reply.code(409).send({ error: 'has_references', message: err.message });
          }
          throw err;
        }
      }

      const validation = validateUpdTotals({
        totalSum: parsed.totalSum,
        vatSum: parsed.vatSum,
        items: parsed.items,
      });

      const [created] = await app.db
        .insert(sourceDocuments)
        .values({
          kind: 'upd',
          direction: req.body.direction,
          origin: 'manual_xml',
          supplierId,
          recipientId,
          contractorId,
          siteId,
          docNumber: parsed.docNumber,
          docDate,
          totalSum: parsed.totalSum?.toString() ?? null,
          vatSum: parsed.vatSum?.toString() ?? null,
          validation,
          status: 'parsed',
        })
        .returning({ id: sourceDocuments.id });
      if (!created) throw new Error('Failed to insert source_document');

      if (parsed.items.length) {
        const itemsWithMaterial = await Promise.all(
          parsed.items.map(async (it) => ({
            sourceDocumentId: created.id,
            materialId: await findOrCreateMaterial(app, { name: it.nameRaw, unit: it.unit }),
            nameRaw: it.nameRaw,
            qty: it.qty.toString(),
            unit: it.unit,
            price: it.price?.toString() ?? null,
            sum: it.sum?.toString() ?? null,
            vatRate: it.vatRate?.toString() ?? null,
            vatSum: it.vatSum?.toString() ?? null,
            lineNo: it.lineNo,
          })),
        );
        await app.db.insert(sourceDocumentItems).values(itemsWithMaterial);
      }

      reply.code(201);
      return { id: created.id, itemsCount: parsed.items.length };
    },
  );

  // ──────────── PDF УПД: загрузка в очередь ────────────
  // Файл и метаданные принимаются multipart/form-data. Распознавание идёт
  // в фоне (apps/api/src/worker.ts), модалка на фронте закрывается сразу.
  // Идемпотентность: повторная загрузка того же файла у того же подрядчика
  // возвращает существующий документ с alreadyExists=true (нового джоба
  // не ставим).
  app.post(
    '/api/v1/source-documents/upload-upd-pdf',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
    },
    async (req, reply) => {
      const mp = req as unknown as {
        file: () => Promise<
          | {
              filename: string;
              mimetype: string;
              toBuffer: () => Promise<Buffer>;
              fields: Record<string, { value?: string } | undefined>;
            }
          | undefined
        >;
      };
      const fileData = await mp.file();
      if (!fileData) {
        return reply.code(400).send({ error: 'no_file', message: 'PDF не приложен' });
      }
      if (!fileData.mimetype.includes('pdf') && !fileData.filename.toLowerCase().endsWith('.pdf')) {
        return reply.code(400).send({ error: 'bad_mime', message: 'Ожидается PDF файл' });
      }

      const rawFields: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(fileData.fields)) {
        if (v && typeof v === 'object' && 'value' in v && typeof v.value === 'string') {
          rawFields[k] = v.value;
        }
      }
      const meta = UpdPdfQueueRequestSchema.safeParse(rawFields);
      if (!meta.success) {
        return reply.code(400).send({
          error: 'bad_request',
          message: meta.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        });
      }
      const { direction, contractorId, siteId } = meta.data;

      const buffer = await fileData.toBuffer();
      if (buffer.length === 0) {
        return reply.code(400).send({ error: 'empty_file', message: 'Файл пустой' });
      }

      const contentHash = createHash('sha256').update(buffer).digest('hex');

      // Идемпотентность по (contractor_id, content_hash) среди живых
      // документов. parse_failed / archived не блокируют повторную загрузку
      // — пользователь мог исправить файл и хочет попробовать снова.
      const [existing] = await app.db
        .select()
        .from(sourceDocuments)
        .where(
          and(
            eq(sourceDocuments.contractorId, contractorId),
            eq(sourceDocuments.contentHash, contentHash),
            inArray(sourceDocuments.status, [
              'queued',
              'processing',
              'parsed',
              'needs_resolution',
            ]),
          ),
        )
        .limit(1);
      if (existing) {
        const names = await loadSdNames(app, existing);
        const body = {
          created: sdRow(existing, names),
          alreadyExists: true,
        };
        return UpdPdfQueueResponseSchema.parse(body);
      }

      // S3 загрузка перед INSERT — если упадёт, документа в БД не появится.
      const newId = randomUUID();
      const s3Key = `documents/${newId}/source.pdf`;
      try {
        await putObject(s3Key, buffer, 'application/pdf');
      } catch (err) {
        req.log.error({ err }, 's3 putObject failed for upd pdf');
        return reply.code(503).send({ error: 's3_unavailable', message: 'S3 недоступен' });
      }

      const now = new Date();
      const [created] = await app.db
        .insert(sourceDocuments)
        .values({
          id: newId,
          kind: 'upd',
          direction,
          origin: 'manual_pdf',
          contractorId,
          siteId,
          status: 'queued',
          contentHash,
          originalFilename: fileData.filename,
          queuedAt: now,
          parsedAt: now,
        })
        .returning();
      if (!created) throw new Error('Failed to insert source_document');

      await app.db.insert(sourceDocumentAttachments).values({
        sourceDocumentId: created.id,
        s3Key,
        filename: fileData.filename || 'source.pdf',
        mimeType: 'application/pdf',
        sizeBytes: buffer.length,
        role: 'original',
      });

      const job = await app.queues.updParse.add('parse', {
        sourceDocumentId: created.id,
        s3Key,
      });
      if (job.id) {
        await app.db
          .update(sourceDocuments)
          .set({ jobId: job.id })
          .where(eq(sourceDocuments.id, created.id));
      }

      const names = await loadSdNames(app, created);
      reply.code(201);
      return UpdPdfQueueResponseSchema.parse({
        created: { ...sdRow(created, names), jobAttempts: 0 },
        alreadyExists: false,
      });
    },
  );

  // ──────────── Разрешение дубликата УПД (needs_resolution+duplicate_upd) ────────────
  app.post(
    '/api/v1/source-documents/:id/resolve-duplicate',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: UpdResolveDuplicateRequestSchema,
        response: {
          200: SourceDocumentDetailSchema,
          204: z.object({ ok: z.literal(true) }),
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [sd] = await app.db
        .select()
        .from(sourceDocuments)
        .where(eq(sourceDocuments.id, req.params.id))
        .limit(1);
      if (!sd) return reply.code(404).send({ error: 'not_found' });
      if (sd.parseErrorCode !== 'duplicate_upd') {
        return reply.code(400).send({ error: 'not_duplicate', message: 'Документ не в статусе дубликата' });
      }
      const existingId =
        sd.parseErrorDetails && typeof sd.parseErrorDetails === 'object'
          ? (sd.parseErrorDetails as { existingId?: string }).existingId ?? null
          : null;
      if (req.body.action === 'skip') {
        // Удаляем загруженный дубль (не существующий оригинал).
        try {
          await deleteUpdWithRefsCheck(app, sd.id, req.log);
        } catch (err) {
          if (err instanceof HasReferencesError) {
            return reply.code(409).send({ error: 'has_references', message: err.message });
          }
          throw err;
        }
        return reply.code(204).send({ ok: true as const });
      }

      // 'replace': удаляем старый документ (если нет ссылок), а новый
      // отправляем обратно в очередь — он добежит до конца и сохранит данные.
      if (!existingId) {
        return reply
          .code(400)
          .send({ error: 'bad_request', message: 'В деталях ошибки нет existingId' });
      }
      try {
        await deleteUpdWithRefsCheck(app, existingId, req.log);
      } catch (err) {
        if (err instanceof HasReferencesError) {
          return reply.code(409).send({ error: 'has_references', message: err.message });
        }
        throw err;
      }

      // Найдём S3-ключ оригинального PDF (он остался в attachments дубля).
      const att = await findOriginalAttachment(app, sd.id);
      if (!att) {
        return reply.code(400).send({ error: 'no_attachment', message: 'Файл не найден' });
      }
      await app.db
        .update(sourceDocuments)
        .set({
          status: 'queued',
          parseErrorCode: null,
          parseErrorDetails: null,
          updatedAt: new Date(),
        })
        .where(eq(sourceDocuments.id, sd.id));
      await app.queues.updParse.add('parse', {
        sourceDocumentId: sd.id,
        s3Key: att.s3Key,
      });

      const [refetched] = await app.db
        .select()
        .from(sourceDocuments)
        .where(eq(sourceDocuments.id, sd.id))
        .limit(1);
      if (!refetched) throw new Error('Failed to refetch source_document');
      const names = await loadSdNames(app, refetched);
      return SourceDocumentDetailSchema.parse({
        ...sdRow(refetched, names),
        items: [],
        attachments: [
          {
            id: att.id,
            s3Key: att.s3Key,
            filename: att.filename,
            mimeType: att.mimeType,
            sizeBytes: att.sizeBytes,
            role: att.role,
          },
        ],
      });
    },
  );

  // ──────────── Принять расхождение сумм (needs_resolution+validation_mismatch) ────────────
  // Пользователь видел alert «суммы не сходятся», убедился, что в исходной
  // накладной так и должно быть (например, округление), и подтверждает
  // документ как есть. Сами поля validation/totalSum не меняются — только
  // статус и parse_error_code.
  app.post(
    '/api/v1/source-documents/:id/acknowledge-mismatch',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: UpdAcknowledgeMismatchRequestSchema,
        response: {
          200: SourceDocumentDetailSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [sd] = await app.db
        .select()
        .from(sourceDocuments)
        .where(eq(sourceDocuments.id, req.params.id))
        .limit(1);
      if (!sd) return reply.code(404).send({ error: 'not_found' });
      if (sd.parseErrorCode !== 'validation_mismatch') {
        return reply.code(400).send({
          error: 'not_mismatch',
          message: 'Документ не в статусе расхождения сумм',
        });
      }
      const ackDetails = {
        ...(typeof sd.parseErrorDetails === 'object' && sd.parseErrorDetails !== null
          ? sd.parseErrorDetails
          : {}),
        acknowledgement: {
          reason: req.body.reason ?? null,
          userId: req.user?.id ?? null,
          at: new Date().toISOString(),
        },
      };
      const [updated] = await app.db
        .update(sourceDocuments)
        .set({
          status: 'parsed',
          parseErrorCode: null,
          parseErrorDetails: ackDetails,
          updatedAt: new Date(),
        })
        .where(eq(sourceDocuments.id, sd.id))
        .returning();
      if (!updated) throw new Error('Failed to update source_document');

      const items = await app.db
        .select()
        .from(sourceDocumentItems)
        .where(eq(sourceDocumentItems.sourceDocumentId, updated.id))
        .orderBy(sourceDocumentItems.lineNo);
      const attachments = await app.db
        .select()
        .from(sourceDocumentAttachments)
        .where(eq(sourceDocumentAttachments.sourceDocumentId, updated.id));
      const names = await loadSdNames(app, updated);
      return {
        ...sdRow(updated, names),
        items: items.map(itemDto),
        attachments: attachments.map(attachmentDto),
      };
    },
  );

  // ──────────── Журнал LLM-вызовов по документу (только админ) ────────────
  app.get(
    '/api/v1/source-documents/:id/llm-calls',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: LlmCallListResponseSchema },
      },
    },
    async (req) => {
      const rows = await app.db
        .select()
        .from(llmCalls)
        .where(eq(llmCalls.sourceDocumentId, req.params.id))
        .orderBy(desc(llmCalls.createdAt));
      return {
        items: rows.map((r) => ({
          id: r.id,
          sourceDocumentId: r.sourceDocumentId,
          providerId: r.providerId,
          promptId: r.promptId,
          docKind: r.docKind,
          model: r.model,
          requestMessages: r.requestMessages,
          requestSchema: r.requestSchema ?? null,
          responseRaw: r.responseRaw,
          responseParsed: r.responseParsed ?? null,
          promptTokens: r.promptTokens,
          completionTokens: r.completionTokens,
          latencyMs: r.latencyMs,
          errorCode: r.errorCode,
          errorMessage: r.errorMessage,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },
  );

  // ──────────── PATCH редактирование полей УПД ────────────
  // Поправляет шапку и/или позиции уже распознанного документа. После
  // сохранения пересчитывается validation и, если расхождения исчезли —
  // статус needs_resolution/validation_mismatch автоматически переходит
  // в parsed.
  const UpdPatchSchema = z.object({
    docNumber: z.string().nullable().optional(),
    docDate: z.string().nullable().optional(),
    totalSum: z.union([z.number(), z.string()]).nullable().optional(),
    supplier: z
      .object({
        inn: z.string().min(10).max(12),
        kpp: z.string().min(9).max(9).nullable().optional(),
        name: z.string().min(1),
      })
      .nullable()
      .optional(),
    items: z
      .array(
        z.object({
          nameRaw: z.string().min(1),
          qty: z.union([z.number(), z.string()]),
          unit: z.string().default('шт'),
          price: z.union([z.number(), z.string()]).nullable().optional(),
          sum: z.union([z.number(), z.string()]).nullable().optional(),
        }),
      )
      .optional(),
  });

  app.patch(
    '/api/v1/source-documents/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: UpdPatchSchema,
        response: { 200: SourceDocumentDetailSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const [sd] = await app.db
        .select()
        .from(sourceDocuments)
        .where(eq(sourceDocuments.id, req.params.id))
        .limit(1);
      if (!sd) return reply.code(404).send({ error: 'not_found' });

      const upd: Partial<typeof sourceDocuments.$inferInsert> = { updatedAt: new Date() };
      if (req.body.docNumber !== undefined) upd.docNumber = req.body.docNumber;
      if (req.body.docDate !== undefined) {
        upd.docDate = req.body.docDate ? new Date(req.body.docDate) : null;
      }
      if (req.body.totalSum !== undefined) {
        upd.totalSum =
          req.body.totalSum === null
            ? null
            : typeof req.body.totalSum === 'number'
              ? req.body.totalSum.toString()
              : req.body.totalSum;
      }
      if (req.body.supplier) {
        const supplierId = await findOrCreateCounterparty(
          app,
          {
            inn: req.body.supplier.inn,
            kpp: req.body.supplier.kpp ?? null,
            name: req.body.supplier.name,
          },
          'supplier',
        );
        upd.supplierId = supplierId;
      }

      if (req.body.items) {
        // Полная замена позиций. Старые удаляются каскадом по delete + insert.
        await app.db
          .delete(sourceDocumentItems)
          .where(eq(sourceDocumentItems.sourceDocumentId, sd.id));
        if (req.body.items.length > 0) {
          const rows = await Promise.all(
            req.body.items.map(async (it, idx) => ({
              sourceDocumentId: sd.id,
              materialId: await findOrCreateMaterial(app, { name: it.nameRaw, unit: it.unit }),
              nameRaw: it.nameRaw,
              qty: typeof it.qty === 'number' ? it.qty.toString() : it.qty,
              unit: it.unit,
              price:
                it.price === null || it.price === undefined
                  ? null
                  : typeof it.price === 'number'
                    ? it.price.toString()
                    : it.price,
              sum:
                it.sum === null || it.sum === undefined
                  ? null
                  : typeof it.sum === 'number'
                    ? it.sum.toString()
                    : it.sum,
              lineNo: idx + 1,
            })),
          );
          await app.db.insert(sourceDocumentItems).values(rows);
        }
      }

      // Пересчёт validation. Берём актуальные значения шапки и позиций.
      const updatedItems = await app.db
        .select()
        .from(sourceDocumentItems)
        .where(eq(sourceDocumentItems.sourceDocumentId, sd.id))
        .orderBy(sourceDocumentItems.lineNo);
      const totalSumForCheck =
        upd.totalSum !== undefined ? upd.totalSum : sd.totalSum;
      const validation = validateUpdTotals({
        totalSum: totalSumForCheck != null ? Number(totalSumForCheck) : null,
        vatSum: sd.vatSum != null ? Number(sd.vatSum) : null,
        items: updatedItems.map((i) => ({
          qty: Number(i.qty),
          price: i.price != null ? Number(i.price) : null,
          sum: i.sum != null ? Number(i.sum) : null,
          vatRate: i.vatRate != null ? Number(i.vatRate) : null,
          vatSum: i.vatSum != null ? Number(i.vatSum) : null,
        })),
      });
      upd.validation = validation;

      // Авто-перевод needs_resolution → parsed, если расхождения исчезли.
      if (
        sd.status === 'needs_resolution' &&
        sd.parseErrorCode === 'validation_mismatch' &&
        !validation.hasMismatch
      ) {
        upd.status = 'parsed';
        upd.parseErrorCode = null;
        upd.parseErrorDetails = null;
      }

      const [updated] = await app.db
        .update(sourceDocuments)
        .set(upd)
        .where(eq(sourceDocuments.id, sd.id))
        .returning();
      if (!updated) throw new Error('Failed to update source_document');

      const attachments = await app.db
        .select()
        .from(sourceDocumentAttachments)
        .where(eq(sourceDocumentAttachments.sourceDocumentId, updated.id));
      const names = await loadSdNames(app, updated);
      return {
        ...sdRow(updated, names),
        items: updatedItems.map(itemDto),
        attachments: attachments.map(attachmentDto),
      };
    },
  );

  // Переключение направления документа («Приёмка» ↔ «Отгрузка») для
  // правки авто-импорта из ЭДО/почты, где direction подставляется дефолтом.
  app.patch(
    '/api/v1/source-documents/:id/direction',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: SourceDocumentDirectionUpdateSchema,
        response: { 200: SourceDocumentDetailSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const [updated] = await app.db
        .update(sourceDocuments)
        .set({ direction: req.body.direction, updatedAt: new Date() })
        .where(eq(sourceDocuments.id, req.params.id))
        .returning();
      if (!updated) return reply.code(404).send({ error: 'not_found' });
      const items = await app.db
        .select()
        .from(sourceDocumentItems)
        .where(eq(sourceDocumentItems.sourceDocumentId, updated.id))
        .orderBy(sourceDocumentItems.lineNo);
      const attachments = await app.db
        .select()
        .from(sourceDocumentAttachments)
        .where(eq(sourceDocumentAttachments.sourceDocumentId, updated.id));
      const names = await loadSdNames(app, updated);
      return {
        ...sdRow(updated, names),
        items: items.map(itemDto),
        attachments: attachments.map(attachmentDto),
      };
    },
  );

  // Удаление УПД. Если документ привязан к приёмке/отгрузке — 409
  // has_references; иначе hard delete с каскадом позиций/attachments
  // и чисткой S3.
  app.delete(
    '/api/v1/source-documents/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: z.object({ ok: z.literal(true) }), 404: ErrorResponseSchema, 409: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const [existing] = await app.db
        .select()
        .from(sourceDocuments)
        .where(eq(sourceDocuments.id, req.params.id))
        .limit(1);
      if (!existing) return reply.code(404).send({ error: 'not_found' });

      try {
        await deleteUpdWithRefsCheck(app, req.params.id, req.log);
      } catch (err) {
        if (err instanceof HasReferencesError) {
          return reply.code(409).send({ error: 'has_references', message: err.message });
        }
        throw err;
      }

      publishEvent(app, {
        type: 'source_document_deleted',
        id: req.params.id,
        ts: new Date().toISOString(),
      });
      return { ok: true as const };
    },
  );
}
