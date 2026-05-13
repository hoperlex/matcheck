import type { FastifyInstance } from 'fastify';
import { and, desc, eq, sql as drSql } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import {
  ManualUpdUploadResponseSchema,
  SourceDocumentListResponseSchema,
  SourceDocumentDetailSchema,
  ErrorResponseSchema,
} from '@matcheck/contracts';
import {
  counterparties,
  sourceDocuments,
  sourceDocumentItems,
  sourceDocumentAttachments,
} from '../db/schema.js';
import { parseUpdXml } from '../domain/edo/upd.parser.js';

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
}
