import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, sql as drSql } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import {
  ManualUpdUploadResponseSchema,
  SourceDocumentListResponseSchema,
  SourceDocumentDetailSchema,
  UpdPdfConfirmRequestSchema,
  UpdPdfParseResponseSchema,
  ErrorResponseSchema,
} from '@matcheck/contracts';
import {
  counterparties,
  sourceDocuments,
  sourceDocumentItems,
  sourceDocumentAttachments,
} from '../db/schema.js';
import { parseUpdXml } from '../domain/edo/upd.parser.js';
import { parseUpdPdf, PdfNoTextError } from '../domain/edo/upd-pdf.parser.js';
import { copyObject, deleteObject, putObject } from '../domain/storage/s3.signer.js';

const ListQuerySchema = z.object({
  kind: z.enum(['upd', 'request']).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

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
  };
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
      const { kind, limit, offset } = req.query;
      const where = kind ? eq(sourceDocuments.kind, kind) : undefined;
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

  app.post(
    '/api/v1/source-documents/upload-upd',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        body: z.object({ xml: z.string().min(1).max(10_000_000) }),
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

      const [created] = await app.db
        .insert(sourceDocuments)
        .values({
          kind: 'upd',
          origin: 'manual_xml',
          supplierId,
          recipientId,
          docNumber: parsed.docNumber,
          docDate: parsed.docDate ? new Date(parsed.docDate) : null,
          totalSum: parsed.totalSum?.toString() ?? null,
          vatSum: parsed.vatSum?.toString() ?? null,
          status: 'parsed',
        })
        .returning({ id: sourceDocuments.id });
      if (!created) throw new Error('Failed to insert source_document');

      if (parsed.items.length) {
        await app.db.insert(sourceDocumentItems).values(
          parsed.items.map((it) => ({
            sourceDocumentId: created.id,
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

      let parseResult;
      try {
        parseResult = await parseUpdPdf(buffer);
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
      const { draftS3Key, parsed } = req.body;

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

      const [created] = await app.db
        .insert(sourceDocuments)
        .values({
          kind: 'upd',
          origin: 'manual_pdf',
          supplierId,
          recipientId,
          docNumber: parsed.docNumber ?? null,
          docDate: parsed.docDate ? new Date(parsed.docDate) : null,
          totalSum: parsed.totalSum != null ? parsed.totalSum.toString() : null,
          vatSum: parsed.vatSum != null ? parsed.vatSum.toString() : null,
          llmProviderId,
          llmConfidence: parsed.confidence.toString(),
          status: 'parsed',
        })
        .returning();
      if (!created) throw new Error('Failed to insert source_document');

      if (parsed.items.length) {
        await app.db.insert(sourceDocumentItems).values(
          parsed.items.map((it, idx) => ({
            sourceDocumentId: created.id,
            nameRaw: it.nameRaw,
            qty: it.qty.toString(),
            unit: it.unit,
            price: it.price != null ? it.price.toString() : null,
            sum: it.sum != null ? it.sum.toString() : null,
            vatRate: it.vatRate != null ? it.vatRate.toString() : null,
            vatSum: it.vatSum != null ? it.vatSum.toString() : null,
            lineNo: idx + 1,
          })),
        );
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
