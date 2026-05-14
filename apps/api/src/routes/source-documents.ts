import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, ilike, sql as drSql } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import {
  ManualUpdUploadRequestSchema,
  ManualUpdUploadResponseSchema,
  SourceDocumentDirectionUpdateSchema,
  SourceDocumentListResponseSchema,
  SourceDocumentDetailSchema,
  SourceDocumentFileResponseSchema,
  UpdPdfConfirmRequestSchema,
  UpdPdfParseResponseSchema,
  ErrorResponseSchema,
} from '@matcheck/contracts';
import {
  counterparties,
  deliveries,
  deliverySources,
  materials,
  sourceDocuments,
  sourceDocumentItems,
  sourceDocumentAttachments,
} from '../db/schema.js';
import { parseUpdXml } from '../domain/edo/upd.parser.js';
import { parseUpdPdf, PdfNoTextError } from '../domain/edo/upd-pdf.parser.js';
import { parseUpdPdfLocal } from '../domain/edo/upd-pdf-local.parser.js';
import { validateUpdTotals } from '../domain/edo/upd-validation.js';
import { copyObject, deleteObject, presign, putObject } from '../domain/storage/s3.signer.js';
import { getUpdParseMode } from '../domain/settings/app-settings.js';
import { resolveStatusId } from '../domain/statuses/lookup.js';

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

function sdRow(sd: typeof sourceDocuments.$inferSelect) {
  return {
    id: sd.id,
    kind: sd.kind,
    direction: sd.direction,
    status: sd.status,
    supplierId: sd.supplierId,
    recipientId: sd.recipientId,
    docNumber: sd.docNumber,
    docDate: sd.docDate?.toISOString().slice(0, 10) ?? null,
    totalSum: sd.totalSum,
    vatSum: sd.vatSum,
    expectedDate: sd.expectedDate?.toISOString().slice(0, 10) ?? null,
    origin: sd.origin,
    llmProviderId: sd.llmProviderId,
    llmConfidence: sd.llmConfidence,
    parsedAt: sd.parsedAt.toISOString(),
    version: sd.version,
    createdAt: sd.createdAt.toISOString(),
    updatedAt: sd.updatedAt.toISOString(),
    validation: sd.validation ?? null,
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
      const rows = await app.db
        .select()
        .from(sourceDocuments)
        .where(where)
        .orderBy(desc(sourceDocuments.parsedAt))
        .limit(limit)
        .offset(offset);
      const [{ count } = { count: 0 }] = await app.db
        .select({ count: drSql<number>`count(*)::int` })
        .from(sourceDocuments)
        .where(where);
      return { items: rows.map(sdRow), total: count };
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
      const [sd] = await app.db
        .select()
        .from(sourceDocuments)
        .where(eq(sourceDocuments.id, req.params.id))
        .limit(1);
      if (!sd) return reply.code(404).send({ error: 'not_found' });
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
        ...sdRow(sd),
        items: items.map((i) => ({
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
        })),
        attachments: attachments.map((a) => ({
          id: a.id,
          s3Key: a.s3Key,
          filename: a.filename,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          role: a.role,
        })),
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
        response: { 201: ManualUpdUploadResponseSchema, 400: ErrorResponseSchema },
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
          docNumber: parsed.docNumber,
          docDate: parsed.docDate ? new Date(parsed.docDate) : null,
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

  // ──────────── PDF УПД: parse (без записи в БД) ────────────
  app.post(
    '/api/v1/source-documents/parse-upd-pdf',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
    },
    async (req, reply) => {
      const fileData = await (
        req as unknown as {
          file: () => Promise<
            { filename: string; mimetype: string; toBuffer: () => Promise<Buffer> } | undefined
          >;
        }
      ).file();
      if (!fileData) {
        return reply.code(400).send({ error: 'no_file', message: 'PDF не приложен' });
      }
      if (!fileData.mimetype.includes('pdf') && !fileData.filename.toLowerCase().endsWith('.pdf')) {
        return reply.code(400).send({ error: 'bad_mime', message: 'Ожидается PDF файл' });
      }

      const buffer = await fileData.toBuffer();
      if (buffer.length === 0) {
        return reply.code(400).send({ error: 'empty_file', message: 'Файл пустой' });
      }

      // Режим парсинга: query-override (для кнопки «Распознать через LLM»),
      // иначе настройка из таблицы settings (по умолчанию 'llm').
      const overrideMode = (req.query as { mode?: string } | undefined)?.mode;
      const effectiveMode =
        overrideMode === 'local' || overrideMode === 'llm'
          ? overrideMode
          : await getUpdParseMode();

      let parseResult;
      try {
        parseResult =
          effectiveMode === 'local'
            ? await parseUpdPdfLocal(buffer)
            : await parseUpdPdf(buffer);
      } catch (err) {
        if (err instanceof PdfNoTextError) {
          return reply.code(400).send({
            error: 'pdf_no_text',
            message:
              'PDF не содержит текстового слоя (вероятно скан). Сканы пока не поддерживаются.',
          });
        }
        const msg = err instanceof Error ? err.message : String(err);
        req.log.warn({ err }, 'pdf parse failed');
        return reply.code(400).send({ error: 'parse_failed', message: msg });
      }

      const contentHash = createHash('sha256').update(buffer).digest('hex');
      const draftId = randomUUID();
      const draftS3Key = `documents/_drafts/${draftId}/source.pdf`;
      try {
        await putObject(draftS3Key, buffer, 'application/pdf');
      } catch (err) {
        req.log.warn({ err }, 'S3 upload draft PDF failed — proceeding without preview');
      }

      const response = {
        draftS3Key,
        contentHash,
        parsed: parseResult.parsed,
        llmProviderId: parseResult.llmProviderId,
        llmConfidence: parseResult.parsed.confidence,
        textLength: parseResult.textLength,
        parseSource: effectiveMode,
      };
      return UpdPdfParseResponseSchema.parse(response);
    },
  );

  // ──────────── PDF УПД: confirm (сохранение после правки) ────────────
  app.post(
    '/api/v1/source-documents/confirm-upd-pdf',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        body: UpdPdfConfirmRequestSchema,
        response: { 201: SourceDocumentDetailSchema, 400: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { draftS3Key, parsed, direction } = req.body;

      const supplier = parsed.supplier;
      const supplierId =
        supplier && supplier.inn && supplier.name
          ? await findOrCreateCounterparty(
              app,
              { inn: supplier.inn, kpp: supplier.kpp ?? null, name: supplier.name },
              'supplier',
            )
          : null;
      const recipient = parsed.recipient;
      const recipientId =
        recipient && recipient.inn && recipient.name
          ? await findOrCreateCounterparty(
              app,
              { inn: recipient.inn, kpp: recipient.kpp ?? null, name: recipient.name },
              'customer',
            )
          : null;

      const llmProviderId = (req.body as { llmProviderId?: string | null }).llmProviderId ?? null;

      const validation = validateUpdTotals({
        totalSum: parsed.totalSum,
        vatSum: parsed.vatSum,
        itemsCount: parsed.itemsCount,
        items: parsed.items,
      });

      const [created] = await app.db
        .insert(sourceDocuments)
        .values({
          kind: 'upd',
          direction,
          origin: 'manual_pdf',
          supplierId,
          recipientId,
          docNumber: parsed.docNumber ?? null,
          docDate: parsed.docDate ? new Date(parsed.docDate) : null,
          totalSum: parsed.totalSum != null ? parsed.totalSum.toString() : null,
          vatSum: parsed.vatSum != null ? parsed.vatSum.toString() : null,
          llmProviderId,
          llmConfidence: parsed.confidence.toString(),
          validation,
          status: 'parsed',
        })
        .returning();
      if (!created) throw new Error('Failed to insert source_document');

      if (parsed.items.length) {
        const itemsWithMaterial = await Promise.all(
          parsed.items.map(async (it, idx) => ({
            sourceDocumentId: created.id,
            materialId: await findOrCreateMaterial(app, { name: it.nameRaw, unit: it.unit }),
            nameRaw: it.nameRaw,
            qty: it.qty.toString(),
            unit: it.unit,
            price: it.price != null ? it.price.toString() : null,
            sum: it.sum != null ? it.sum.toString() : null,
            vatRate: it.vatRate != null ? it.vatRate.toString() : null,
            vatSum: it.vatSum != null ? it.vatSum.toString() : null,
            volumeM3: it.volumeM3 != null ? it.volumeM3.toString() : null,
            massKg: it.massKg != null ? it.massKg.toString() : null,
            volumeConfidence: it.volumeConfidence ?? null,
            groupName: it.groupName ?? null,
            lineNo: idx + 1,
          })),
        );
        await app.db.insert(sourceDocumentItems).values(itemsWithMaterial);
      }

      // Перемещаем draft → final S3-ключ
      const finalS3Key = `documents/${created.id}/source.pdf`;
      try {
        await copyObject(draftS3Key, finalS3Key);
        await deleteObject(draftS3Key);
        await app.db.insert(sourceDocumentAttachments).values({
          sourceDocumentId: created.id,
          s3Key: finalS3Key,
          filename: 'source.pdf',
          mimeType: 'application/pdf',
          role: 'original',
        });
      } catch (err) {
        req.log.warn({ err, draftS3Key, finalS3Key }, 'S3 copy/delete failed');
      }

      // Возвращаем DTO (как в GET /:id)
      const items = await app.db
        .select()
        .from(sourceDocumentItems)
        .where(eq(sourceDocumentItems.sourceDocumentId, created.id))
        .orderBy(sourceDocumentItems.lineNo);
      const attachments = await app.db
        .select()
        .from(sourceDocumentAttachments)
        .where(eq(sourceDocumentAttachments.sourceDocumentId, created.id));

      reply.code(201);
      return {
        ...sdRow(created),
        items: items.map((i) => ({
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
        })),
        attachments: attachments.map((a) => ({
          id: a.id,
          s3Key: a.s3Key,
          filename: a.filename,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          role: a.role,
        })),
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
      return {
        ...sdRow(updated),
        items: items.map((i) => ({
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
        })),
        attachments: attachments.map((a) => ({
          id: a.id,
          s3Key: a.s3Key,
          filename: a.filename,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          role: a.role,
        })),
      };
    },
  );
}
