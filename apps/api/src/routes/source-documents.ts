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
  SourceDocumentBulkDeleteRequestSchema,
  SourceDocumentBulkDeleteResponseSchema,
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
  getDocumentDisplayStatus,
  getDocumentDisplayStatusLabel,
} from '@matcheck/contracts';
import {
  counterparties,
  deliverySources,
  entityDeletions,
  llmCalls,
  materials,
  responsiblePersons,
  shipmentSources,
  sites,
  sourceBundles,
  sourceDocuments,
  sourceDocumentItems,
  sourceDocumentAttachments,
  suppliers,
  users,
} from '../db/schema.js';
import { parseUpdXml } from '../domain/edo/upd.parser.js';
import { validateUpdTotals } from '../domain/edo/upd-validation.js';
import { presign, putObject } from '../domain/storage/s3.signer.js';
import { buildS3Key } from '../domain/storage/s3.path.js';
import { publishEvent } from './events.js';
import { matchOrCreateSupplier } from '../domain/sourceDocuments/supplierMatcher.js';

const KIND_VALUES = ['upd', 'request', 'transport_waybill', 'os2_transfer'] as const;
type KindValue = (typeof KIND_VALUES)[number];

// kind принимает либо одно значение, либо CSV-список значений
// (например kind=upd,transport_waybill) — нужно для «Ожидаемые» в
// КПП/Отгрузках, где должны попадать и УПД, и ТН одновременно.
const KindFilterSchema = z
  .string()
  .transform((s, ctx) => {
    const parts = s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    if (parts.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'empty kind' });
      return z.NEVER;
    }
    for (const p of parts) {
      if (!(KIND_VALUES as readonly string[]).includes(p)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown kind: ${p}` });
        return z.NEVER;
      }
    }
    return parts as KindValue[];
  })
  .optional();

const ListQuerySchema = z.object({
  kind: KindFilterSchema,
  direction: z.enum(['inbound', 'outbound']).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  unaccepted: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().positive().max(2000).default(50),
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

// Поддерживаемые форматы для /upload-upd-pdf endpoint.
//   pdf  — электронный PDF, парсится через pdf-parse + LLM;
//   xlsx — Excel, парсится локально регулярками;
//   jpg/png/webp — фото или скан, парсится через vision-LLM (Gemini);
// PDF-сканы без текстового слоя автоматически переключаются на vision-LLM
// в worker.ts (см. PdfNoTextError → parseUpdVision fallback).
//
// Хранение в БД использует один origin='manual_pdf' независимо от формата
// — enum намеренно не расширяем, чтобы не делать миграцию ради метаданных.
// Контракт SourceDocumentSchema тоже не трогаем — мобила и веб-портал
// продолжают видеть source_documents без новых полей.
type UpdFileFormat = {
  ext: 'pdf' | 'xlsx' | 'jpg' | 'png' | 'webp';
  mimeType: string;
};

function detectUpdFileFormat(mime: string, filename: string): UpdFileFormat | null {
  const m = (mime ?? '').toLowerCase();
  const f = (filename ?? '').toLowerCase();
  if (m.includes('pdf') || f.endsWith('.pdf')) {
    return { ext: 'pdf', mimeType: 'application/pdf' };
  }
  if (
    m.includes('spreadsheetml') ||
    m.includes('vnd.ms-excel') ||
    f.endsWith('.xlsx') ||
    f.endsWith('.xls')
  ) {
    return {
      ext: 'xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }
  if (m === 'image/jpeg' || m === 'image/jpg' || f.endsWith('.jpg') || f.endsWith('.jpeg')) {
    return { ext: 'jpg', mimeType: 'image/jpeg' };
  }
  if (m === 'image/png' || f.endsWith('.png')) {
    return { ext: 'png', mimeType: 'image/png' };
  }
  if (m === 'image/webp' || f.endsWith('.webp')) {
    return { ext: 'webp', mimeType: 'image/webp' };
  }
  return null;
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
  recipientName?: string | null;
  recipientMolName?: string | null;
  siteName?: string | null;
  // Email и телефон автора УПД (того, кто загрузил через /upload-upd*).
  // Для EDO/mail-полученных — null. Используется мобильным клиентом
  // для кнопки звонка в шапке списка материалов.
  createdByUserEmail?: string | null;
  createdByUserPhone?: string | null;
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
    recipientMolId: sd.recipientMolId,
    siteId: sd.siteId,
    supplierName: names.supplierName ?? null,
    contractorName: names.contractorName ?? null,
    recipientName: names.recipientName ?? null,
    recipientMolName: names.recipientMolName ?? null,
    siteName: names.siteName ?? null,
    createdByUserId: sd.createdByUserId,
    createdByUserEmail: names.createdByUserEmail ?? null,
    createdByUserPhone: names.createdByUserPhone ?? null,
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
      | 'partial_parse'
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
    inventoryNumber: i.inventoryNumber,
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
  const [supplier, contractor, recipient, mol, site, createdBy] = await Promise.all([
    // Поставщик: приоритет — справочник `suppliers` (для распознанных УПД
    // после миграции 0064). Fallback — counterparties (исторические УПД и
    // manual XML). Один из ID должен быть заполнен; если оба null — supplier
    // в шапке покажется как «не указан».
    sd.supplierDirectoryId
      ? app.db
          .select({ name: suppliers.name })
          .from(suppliers)
          .where(eq(suppliers.id, sd.supplierDirectoryId))
          .limit(1)
      : sd.supplierId
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
    sd.recipientId
      ? app.db
          .select({ name: counterparties.name })
          .from(counterparties)
          .where(eq(counterparties.id, sd.recipientId))
          .limit(1)
      : Promise.resolve([] as { name: string }[]),
    sd.recipientMolId
      ? app.db
          .select({ name: responsiblePersons.fullName })
          .from(responsiblePersons)
          .where(eq(responsiblePersons.id, sd.recipientMolId))
          .limit(1)
      : Promise.resolve([] as { name: string }[]),
    sd.siteId
      ? app.db
          .select({ name: sites.name })
          .from(sites)
          .where(eq(sites.id, sd.siteId))
          .limit(1)
      : Promise.resolve([] as { name: string }[]),
    sd.createdByUserId
      ? app.db
          .select({ email: users.email, phone: users.phone })
          .from(users)
          .where(eq(users.id, sd.createdByUserId))
          .limit(1)
      : Promise.resolve([] as { email: string; phone: string | null }[]),
  ]);
  return {
    supplierName: supplier[0]?.name ?? null,
    contractorName: contractor[0]?.name ?? null,
    recipientName: recipient[0]?.name ?? null,
    recipientMolName: mol[0]?.name ?? null,
    siteName: site[0]?.name ?? null,
    createdByUserEmail: createdBy[0]?.email ?? null,
    createdByUserPhone: createdBy[0]?.phone ?? null,
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
  deletedByUserId: string | null,
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

  // Забираем s3-ключи ДО hard delete (cascade удалит строки attachments)
  // и siteId — для журнала удалений.
  const attachments = await app.db
    .select({ s3Key: sourceDocumentAttachments.s3Key })
    .from(sourceDocumentAttachments)
    .where(eq(sourceDocumentAttachments.sourceDocumentId, id));
  const [doc] = await app.db
    .select({ siteId: sourceDocuments.siteId })
    .from(sourceDocuments)
    .where(eq(sourceDocuments.id, id))
    .limit(1);

  // Журнал hard-delete + физическое удаление одной транзакцией:
  // офлайн-клиент узнаёт об удалении через /sync.deletedIds.
  await app.db.transaction(async (tx: typeof app.db) => {
    await tx.insert(entityDeletions).values({
      entityType: 'source_document',
      entityId: id,
      siteId: doc?.siteId ?? null,
      deletedByUserId,
    });
    await tx.delete(sourceDocuments).where(eq(sourceDocuments.id, id));
  });

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
      if (kind && kind.length > 0) {
        const first = kind[0];
        if (kind.length === 1 && first) {
          conditions.push(eq(sourceDocuments.kind, first));
        } else {
          conditions.push(inArray(sourceDocuments.kind, kind));
        }
      }
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
      // Фильтр «непринятые»: УПД считается ожидаемой, пока на неё нет
      // привязки в delivery_sources / shipment_sources. Статус приёмки/
      // отгрузки не учитываем — любая привязка (включая draft) делает УПД
      // занятой. При удалении приёмки/отгрузки FK CASCADE снесёт строку
      // junction → УПД автоматически вернётся в «Ожидаемые».
      if (unaccepted) {
        if (direction !== 'outbound') {
          const linkedToDelivery = app.db
            .select({ id: deliverySources.sourceDocumentId })
            .from(deliverySources);
          conditions.push(drSql`${sourceDocuments.id} not in ${linkedToDelivery}`);
        }
        if (direction !== 'inbound') {
          const linkedToShipment = app.db
            .select({ id: shipmentSources.sourceDocumentId })
            .from(shipmentSources);
          conditions.push(drSql`${sourceDocuments.id} not in ${linkedToShipment}`);
        }
      }
      const where = conditions.length ? and(...conditions) : undefined;
      const supplier = alias(counterparties, 'supplier');
      const supplierDir = alias(suppliers, 'supplier_dir');
      const contractor = alias(counterparties, 'contractor');
      const recipient = alias(counterparties, 'recipient');
      const rows = await app.db
        .select({
          sd: sourceDocuments,
          // Поставщик — приоритет справочника (новый путь), fallback на
          // counterparties (исторические УПД до миграции 0064).
          supplierName: drSql<string | null>`COALESCE(${supplierDir.name}, ${supplier.name})`,
          contractorName: contractor.name,
          recipientName: recipient.name,
          recipientMolName: responsiblePersons.fullName,
          siteName: sites.name,
        })
        .from(sourceDocuments)
        .leftJoin(supplier, eq(sourceDocuments.supplierId, supplier.id))
        .leftJoin(supplierDir, eq(sourceDocuments.supplierDirectoryId, supplierDir.id))
        .leftJoin(contractor, eq(sourceDocuments.contractorId, contractor.id))
        .leftJoin(recipient, eq(sourceDocuments.recipientId, recipient.id))
        .leftJoin(
          responsiblePersons,
          eq(sourceDocuments.recipientMolId, responsiblePersons.id),
        )
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
            recipientName: r.recipientName,
            recipientMolName: r.recipientMolName,
            siteName: r.siteName,
          }),
        ),
        total: count,
      };
    },
  );

  // Экспорт документов с фильтрами в .xlsx. Каждый документ — строка
  // верхнего уровня; его позиции — строки с outlineLevel=1 (свёрнуты по
  // умолчанию, раскрываются по «+» в Excel). Фильтры зеркалят фильтры
  // в UI: contractor/supplier/site CSV-списками, q — по номеру документа.
  {
    const csvUuids = (raw: string | undefined): string[] => {
      if (!raw) return [];
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^[0-9a-fA-F-]{36}$/.test(s));
    };
    const fmtDateRu = (d: Date | string | null): string => {
      if (!d) return '';
      const date = d instanceof Date ? d : new Date(d);
      if (Number.isNaN(date.getTime())) return '';
      const dd = String(date.getUTCDate()).padStart(2, '0');
      const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
      const yyyy = date.getUTCFullYear();
      return `${dd}.${mm}.${yyyy}`;
    };
    const kindLabel = (k: string): string =>
      k === 'upd'
        ? 'УПД'
        : k === 'transport_waybill' || k === 'os2_transfer'
          ? 'Накладная'
          : k === 'request'
            ? 'Заявка'
            : k;
    // Используем общий helper из contracts: пересчитывает status в
    // отображаемый («Черновик» / «обработано» / т.д.) по тем же правилам,
    // что и UI. Это даёт согласованный статус в Excel-выгрузке.
    const statusLabelFor = (sd: typeof sourceDocuments.$inferSelect): string => {
      const display = getDocumentDisplayStatus({
        status: sd.status,
        contractorId: sd.contractorId,
        recipientMolId: sd.recipientMolId,
        expectedDate: sd.expectedDate ? sd.expectedDate.toISOString() : null,
        siteId: sd.siteId,
      });
      return getDocumentDisplayStatusLabel(display).label;
    };

    const ExportQuerySchema = z.object({
      direction: z.enum(['inbound', 'outbound']),
      contractorIds: z.string().optional(),
      supplierIds: z.string().optional(),
      siteIds: z.string().optional(),
      q: z.string().trim().min(1).max(200).optional(),
      // unaccepted=true — только документы без привязки к delivery/shipment
      // (то, что показывается во вкладке «Ожидаемые» Приёмки/Отгрузки).
      unaccepted: z.coerce.boolean().optional(),
    });

    app.get(
      '/api/v1/source-documents/export.xlsx',
      {
        preHandler: [app.authenticate],
        schema: { querystring: ExportQuerySchema },
      },
      async (req, reply) => {
        const { direction, contractorIds, supplierIds, siteIds, q, unaccepted } = req.query;
        const conditions = [eq(sourceDocuments.direction, direction)];
        if (q) conditions.push(ilike(sourceDocuments.docNumber, `%${q}%`));
        const cIds = csvUuids(contractorIds);
        if (cIds.length) conditions.push(inArray(sourceDocuments.contractorId, cIds));
        const sIds = csvUuids(supplierIds);
        if (sIds.length) {
          // ID может быть либо из counterparties (исторические УПД), либо
          // из suppliers (новые после миграции 0064). Не сужаем выборку
          // только до старого пути — иначе новые УПД пропадут из экспорта.
          conditions.push(
            drSql`(${sourceDocuments.supplierId} in ${sIds} or ${sourceDocuments.supplierDirectoryId} in ${sIds})`,
          );
        }
        const stIds = csvUuids(siteIds);
        if (stIds.length) conditions.push(inArray(sourceDocuments.siteId, stIds));
        // unaccepted: документ ещё не привязан к delivery (для inbound) или
        // shipment (для outbound). Логика повторяет GET /source-documents.
        if (unaccepted) {
          if (direction !== 'outbound') {
            const linkedToDelivery = app.db
              .select({ id: deliverySources.sourceDocumentId })
              .from(deliverySources);
            conditions.push(drSql`${sourceDocuments.id} not in ${linkedToDelivery}`);
          }
          if (direction !== 'inbound') {
            const linkedToShipment = app.db
              .select({ id: shipmentSources.sourceDocumentId })
              .from(shipmentSources);
            conditions.push(drSql`${sourceDocuments.id} not in ${linkedToShipment}`);
          }
        }
        // inspector_kpp видит только свой объект — те же правила, что в GET /.
        if (req.user?.role === 'inspector_kpp') {
          if (!req.user.siteId) {
            conditions.push(drSql`false`);
          } else {
            conditions.push(eq(sourceDocuments.siteId, req.user.siteId));
          }
        }

        const supplier = alias(counterparties, 'supplier');
        const supplierDir = alias(suppliers, 'supplier_dir');
        const contractor = alias(counterparties, 'contractor');
        const rows = await app.db
          .select({
            sd: sourceDocuments,
            supplierName: drSql<string | null>`COALESCE(${supplierDir.name}, ${supplier.name})`,
            contractorName: contractor.name,
            siteName: sites.name,
          })
          .from(sourceDocuments)
          .leftJoin(supplier, eq(sourceDocuments.supplierId, supplier.id))
          .leftJoin(supplierDir, eq(sourceDocuments.supplierDirectoryId, supplierDir.id))
          .leftJoin(contractor, eq(sourceDocuments.contractorId, contractor.id))
          .leftJoin(sites, eq(sourceDocuments.siteId, sites.id))
          .where(and(...conditions))
          .orderBy(desc(sourceDocuments.parsedAt));

        const sdIds = rows.map((r) => r.sd.id);
        const itemsBySd = new Map<string, (typeof sourceDocumentItems.$inferSelect)[]>();
        if (sdIds.length > 0) {
          const items = await app.db
            .select()
            .from(sourceDocumentItems)
            .where(inArray(sourceDocumentItems.sourceDocumentId, sdIds))
            .orderBy(sourceDocumentItems.sourceDocumentId, sourceDocumentItems.lineNo);
          for (const it of items) {
            const arr = itemsBySd.get(it.sourceDocumentId) ?? [];
            arr.push(it);
            itemsBySd.set(it.sourceDocumentId, arr);
          }
        }

        // exceljs импортируем динамически — большая либа, грузить только
        // когда реально нужно (не в холодном старте Fastify).
        const ExcelJS = (await import('exceljs')).default;
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Документы', {
          views: [{ state: 'frozen', ySplit: 1 }],
          properties: { defaultRowHeight: 16 },
        });

        ws.columns = [
          { header: '№', key: 'idx', width: 6 },
          { header: 'Тип', key: 'kind', width: 11 },
          { header: 'Статус', key: 'status', width: 14 },
          { header: '№ документа', key: 'docNumber', width: 16 },
          { header: 'Дата', key: 'docDate', width: 12 },
          { header: 'Дата поставки', key: 'expectedDate', width: 14 },
          { header: 'Объект', key: 'siteName', width: 24 },
          { header: 'Подрядчик', key: 'contractorName', width: 28 },
          { header: 'Поставщик', key: 'supplierName', width: 28 },
          { header: 'Наименование', key: 'nameRaw', width: 40 },
          { header: 'Кол-во', key: 'qty', width: 10 },
          { header: 'Ед.', key: 'unit', width: 7 },
          { header: 'Цена', key: 'price', width: 12 },
          { header: 'Сумма НДС', key: 'vatSum', width: 14 },
          { header: 'Сумма', key: 'sum', width: 16 },
        ];
        const headerRow = ws.getRow(1);
        headerRow.font = { bold: true };
        headerRow.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
        headerRow.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFEDEDED' },
        };

        const MONEY_FMT = '# ##0.00 "₽"';
        // QTY: формат подбирается per-row — целые числа без разделителя
        // («30»), дробные с запятой («19,985», до 4 знаков). Раньше был
        // только `# ##0.####`, и в RU-локали для целого 30 Excel рисовал
        // «30,» с висящей запятой.
        const QTY_FMT_INT = '# ##0';
        const QTY_FMT_DEC = '# ##0.####';

        let idx = 0;
        for (const r of rows) {
          idx++;
          const sd = r.sd;
          const docRow = ws.addRow({
            idx,
            kind: kindLabel(sd.kind),
            status: statusLabelFor(sd),
            docNumber: sd.docNumber ?? '',
            docDate: fmtDateRu(sd.docDate),
            expectedDate: fmtDateRu(sd.expectedDate),
            siteName: r.siteName ?? '',
            contractorName: r.contractorName ?? '',
            supplierName: r.supplierName ?? '',
            nameRaw: '',
            qty: null,
            unit: '',
            price: null,
            vatSum: sd.vatSum != null ? Number(sd.vatSum) : null,
            sum: sd.totalSum != null ? Number(sd.totalSum) : null,
          });
          docRow.font = { bold: true };
          docRow.getCell('vatSum').numFmt = MONEY_FMT;
          docRow.getCell('sum').numFmt = MONEY_FMT;
          docRow.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFF7F7F7' },
          };

          const items = itemsBySd.get(sd.id) ?? [];
          for (const it of items) {
            const itemRow = ws.addRow({
              idx: it.lineNo,
              kind: '',
              status: '',
              docNumber: '',
              docDate: '',
              expectedDate: '',
              siteName: '',
              contractorName: '',
              supplierName: '',
              nameRaw: it.nameRaw,
              qty: Number(it.qty),
              unit: it.unit,
              price: it.price != null ? Number(it.price) : null,
              vatSum: it.vatSum != null ? Number(it.vatSum) : null,
              sum: it.sum != null ? Number(it.sum) : null,
            });
            itemRow.outlineLevel = 1; // строка позиции — внутри +/- группы
            const qtyNum = Number(it.qty);
            itemRow.getCell('qty').numFmt = Number.isInteger(qtyNum)
              ? QTY_FMT_INT
              : QTY_FMT_DEC;
            itemRow.getCell('price').numFmt = MONEY_FMT;
            itemRow.getCell('vatSum').numFmt = MONEY_FMT;
            itemRow.getCell('sum').numFmt = MONEY_FMT;
          }
        }

        // По умолчанию все группы свернуты — пользователь видит чистый
        // список документов, при необходимости разворачивает «+».
        ws.properties.outlineLevelRow = 1;

        const buf = await wb.xlsx.writeBuffer();
        const today = new Date().toISOString().slice(0, 10);
        const filename = `documents-${direction}-${today}.xlsx`;
        return reply
          .header(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          )
          .header(
            'Content-Disposition',
            `attachment; filename="${filename}"`,
          )
          .send(Buffer.from(buf));
      },
    );
  }

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
      const supplierDir = alias(suppliers, 'supplier_dir');
      const contractor = alias(counterparties, 'contractor');
      const recipient = alias(counterparties, 'recipient');
      const [row] = await app.db
        .select({
          sd: sourceDocuments,
          supplierName: drSql<string | null>`COALESCE(${supplierDir.name}, ${supplier.name})`,
          contractorName: contractor.name,
          recipientName: recipient.name,
          recipientMolName: responsiblePersons.fullName,
          siteName: sites.name,
        })
        .from(sourceDocuments)
        .leftJoin(supplier, eq(sourceDocuments.supplierId, supplier.id))
        .leftJoin(supplierDir, eq(sourceDocuments.supplierDirectoryId, supplierDir.id))
        .leftJoin(contractor, eq(sourceDocuments.contractorId, contractor.id))
        .leftJoin(recipient, eq(sourceDocuments.recipientId, recipient.id))
        .leftJoin(
          responsiblePersons,
          eq(sourceDocuments.recipientMolId, responsiblePersons.id),
        )
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
      // Validation на лету. В БД лежит snapshot первой проверки (момент
      // распознавания), но логика валидатора иногда меняется (например,
      // переход на price из графы 4 + sum из графы 9 с пересчётом
      // qty × price ≈ sum / (1 + ставка/100)). Чтобы Alert «Расхождения
      // в суммах» отражал актуальную логику, а не устарел вместе с
      // конкретным документом, пересчитываем validation по текущим
      // данным items + шапке. Стоимость операции — O(n) по строкам.
      const liveValidation = validateUpdTotals({
        totalSum: sd.totalSum != null ? Number(sd.totalSum) : null,
        vatSum: sd.vatSum != null ? Number(sd.vatSum) : null,
        itemsCount: null,
        items: items.map((it) => ({
          qty: it.qty != null ? Number(it.qty) : null,
          price: it.price != null ? Number(it.price) : null,
          sum: it.sum != null ? Number(it.sum) : null,
          vatRate: it.vatRate != null ? Number(it.vatRate) : null,
          vatSum: it.vatSum != null ? Number(it.vatSum) : null,
        })),
      });
      const base = sdRow(sd, {
        supplierName: row.supplierName,
        contractorName: row.contractorName,
        recipientName: row.recipientName,
        recipientMolName: row.recipientMolName,
        siteName: row.siteName,
      });
      return {
        ...base,
        validation: liveValidation,
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
      schema: {
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({
          attachmentId: z.string().uuid().optional(),
          // download=1 — явно просим Content-Disposition: attachment вместо
          // inline. Используется кнопкой «Скачать оригинал» в модалке
          // деталей УПД (для xlsx attachment ставится автоматически по
          // mime-типу, см. ниже; флаг нужен в основном для PDF/изображений).
          download: z.enum(['1']).optional(),
        }),
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
      // Если передан attachmentId — отдаём именно его (нужно для пакетов
      // ТН, где несколько фото в одном source_document). Иначе fallback на
      // «первый original» (текущее поведение для УПД с одним PDF).
      let att: typeof sourceDocumentAttachments.$inferSelect | null = null;
      if (req.query.attachmentId) {
        const [a] = await app.db
          .select()
          .from(sourceDocumentAttachments)
          .where(
            and(
              eq(sourceDocumentAttachments.id, req.query.attachmentId),
              eq(sourceDocumentAttachments.sourceDocumentId, req.params.id),
            ),
          )
          .limit(1);
        att = a ?? null;
      } else {
        att = await findOriginalAttachment(app, req.params.id);
      }
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
      // PDF и изображения встроены в iframe/<Image> на портале — отдаём
      // inline, чтобы Chrome открыл свой viewer. Excel браузер inline не
      // показывает (нет viewer'а) — при inline-CD загрузка iframe запускает
      // автоматическое скачивание файла. Фронт для xlsx и не подставляет
      // этот URL в iframe, но даже если по ошибке подставит — серверная
      // автозащита: для xlsx-mime отдаём attachment и явное `download=1`
      // — клиент сохранит файл через apiDownload, а не «как-будто-вьюер».
      const isExcelMime =
        (att.mimeType?.includes('spreadsheetml') ?? false) ||
        att.mimeType === 'application/vnd.ms-excel';
      const wantAttachment = req.query.download === '1' || isExcelMime;
      reply.header(
        'content-disposition',
        `${wantAttachment ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
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
      const { contractorId, siteId, replaceExistingId, expectedDate } = req.body;

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
          await deleteUpdWithRefsCheck(app, duplicate.id, req.user?.id ?? null, req.log);
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
          expectedDate: expectedDate ? new Date(expectedDate) : null,
          totalSum: parsed.totalSum?.toString() ?? null,
          vatSum: parsed.vatSum?.toString() ?? null,
          validation,
          status: 'parsed',
          // Привязываем УПД к пользователю, который её загрузил, — нужно
          // мобильному клиенту для кнопки «☎ менеджер» в шапке материалов.
          createdByUserId: req.user?.id ?? null,
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
        return reply.code(400).send({ error: 'no_file', message: 'Файл не приложен' });
      }
      const format = detectUpdFileFormat(fileData.mimetype, fileData.filename);
      if (!format) {
        return reply.code(400).send({
          error: 'bad_mime',
          message: 'Ожидается PDF или Excel (xlsx) файл',
        });
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
      const { direction, contractorId, recipientMolId, siteId, expectedDate } = meta.data;

      const buffer = await fileData.toBuffer();
      if (buffer.length === 0) {
        return reply.code(400).send({ error: 'empty_file', message: 'Файл пустой' });
      }

      const contentHash = createHash('sha256').update(buffer).digest('hex');

      // Идемпотентность по content_hash среди живых документов.
      // parse_failed / archived не блокируют повторную загрузку
      // — пользователь мог исправить файл и хочет попробовать снова.
      // Если contractorId указан — дополнительно фильтруем по нему,
      // чтобы один и тот же шаблон у разных подрядчиков не сливался.
      const existingWhere = [
        eq(sourceDocuments.contentHash, contentHash),
        inArray(sourceDocuments.status, [
          'queued',
          'processing',
          'parsed',
          'needs_resolution',
        ]),
      ];
      if (contractorId) {
        existingWhere.push(eq(sourceDocuments.contractorId, contractorId));
      }
      const [existing] = await app.db
        .select()
        .from(sourceDocuments)
        .where(and(...existingWhere))
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
      // Ключ: {site.code}/{contractor.inn}__{slug(name)}/source-documents/{id}/source.pdf.
      // Когда получатель — МОЛ или не указан, подрядчика для пути нет;
      // buildS3Key падает обратно на 'unknown' в этом сегменте.
      const newId = randomUUID();
      const [pdfSite] = await app.db
        .select({ code: sites.code })
        .from(sites)
        .where(eq(sites.id, siteId))
        .limit(1);
      const [pdfCp] = contractorId
        ? await app.db
            .select({ inn: counterparties.inn, name: counterparties.name })
            .from(counterparties)
            .where(eq(counterparties.id, contractorId))
            .limit(1)
        : [];
      const s3Key = buildS3Key({
        site: pdfSite ?? null,
        counterparty: pdfCp ?? null,
        entityType: 'source-documents',
        entityId: newId,
        filename: `source.${format.ext}`,
      });
      try {
        await putObject(s3Key, buffer, format.mimeType);
      } catch (err) {
        req.log.error({ err }, 's3 putObject failed for upd file');
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
          contractorId: contractorId ?? null,
          recipientMolId: recipientMolId ?? null,
          siteId,
          expectedDate: expectedDate ? new Date(expectedDate) : null,
          status: 'queued',
          contentHash,
          originalFilename: fileData.filename,
          queuedAt: now,
          parsedAt: now,
          // См. комментарий в /upload-upd: пробрасываем автора для мобильного.
          createdByUserId: req.user?.id ?? null,
        })
        .returning();
      if (!created) throw new Error('Failed to insert source_document');

      await app.db.insert(sourceDocumentAttachments).values({
        sourceDocumentId: created.id,
        s3Key,
        filename: fileData.filename || `source.${format.ext}`,
        mimeType: format.mimeType,
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

  // ──────────── Накладные (ТН-2116 + ОС-2): загрузка пакета файлов ─────────
  // Юзер кладёт ПАКЕТ изображений (лицевая+оборотная одной ТН, или две ОС-2,
  // или микс «ТН + ОС-2 + паспорт качества + рукописная»). Все файлы пишутся
  // в S3 и регистрируются в source_bundles. На пакет создаётся одна
  // техническая запись source_documents (kind='transport_waybill', status='queued') —
  // под ней висят attachments и сидит job в очереди. Worker (см.
  // handleWaybillBundleJob) запускает vision-LLM, получает массив документов
  // и:
  //   - если массив пустой → bundle=parse_failed, тех. документ помечается
  //     no_waybill_found, никаких реальных строк в «Ожидаемых» не появляется.
  //   - иначе создаёт N реальных source_documents (kind=transport_waybill
  //     или os2_transfer по форме), привязывает к каждому копию пакета
  //     attachments, удаляет техническую запись.
  app.post(
    '/api/v1/source-documents/upload-waybill',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
    },
    async (req, reply) => {
      const mp = req as unknown as {
        files: (opts?: { limits?: { files?: number; fileSize?: number } }) => AsyncIterable<{
          filename: string;
          mimetype: string;
          toBuffer: () => Promise<Buffer>;
          fields: Record<string, { value?: string } | undefined>;
        }>;
      };

      // Собираем все файлы пакета + поля метаданных. Поля multipart лежат
      // как «псевдо-файлы» с .value, разбираемся отдельно. Глобальный
      // лимит multipart — 1 файл; для пакета ТН переопределяем на 20
      // (типичный пакет — 2–5 фото, но мобильные клиенты могут пакетно
      // фотать оба разворота + сопроводилки).
      const collected: Array<{ filename: string; mimetype: string; buffer: Buffer }> = [];
      const rawFields: Record<string, string | undefined> = {};
      let lastFields: Record<string, { value?: string } | undefined> = {};
      for await (const part of mp.files({ limits: { files: 20, fileSize: 10 * 1024 * 1024 } })) {
        // Поля из формы тоже идут в .files() с заполненным fields.
        // Запоминаем последний набор fields — они одинаковы у всех parts.
        lastFields = part.fields;
        const buf = await part.toBuffer();
        if (buf.length === 0) continue;
        const mime = (part.mimetype ?? '').toLowerCase();
        const isImage =
          mime.startsWith('image/') ||
          /\.(jpg|jpeg|png|webp|heic|heif)$/i.test(part.filename);
        const isPdf = mime.includes('pdf') || /\.pdf$/i.test(part.filename);
        if (!isImage && !isPdf) {
          // Молча пропускаем неподдерживаемые типы — это могут быть поля
          // form-data, ошибочно прилетевшие через .files().
          continue;
        }
        collected.push({ filename: part.filename, mimetype: part.mimetype, buffer: buf });
      }
      for (const [k, v] of Object.entries(lastFields)) {
        if (v && typeof v === 'object' && 'value' in v && typeof v.value === 'string') {
          rawFields[k] = v.value;
        }
      }

      if (collected.length === 0) {
        return reply
          .code(400)
          .send({ error: 'no_files', message: 'Не приложен ни один файл' });
      }

      const meta = UpdPdfQueueRequestSchema.safeParse(rawFields);
      if (!meta.success) {
        return reply.code(400).send({
          error: 'bad_request',
          message: meta.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        });
      }
      const { direction, contractorId, recipientMolId, siteId, expectedDate } = meta.data;

      // Идемпотентность по совокупному хешу пакета: сортируем хеши отдельных
      // файлов и берём sha256 от их конкатенации. Тот же набор фоток в разном
      // порядке → тот же bundleHash → возвращаем технический документ
      // существующего пакета (как alreadyExists=true).
      const fileHashes = collected
        .map((f) => createHash('sha256').update(f.buffer).digest('hex'))
        .sort();
      const bundleHash = createHash('sha256').update(fileHashes.join('|')).digest('hex');

      // Уникальный индекс на source_bundles.bundle_hash гарантирует, что
      // повторная загрузка того же набора файлов попадёт в существующую
      // запись. Возможны три случая:
      //   1. Bundle есть, к нему привязан хотя бы один source_document
      //      (тех. или реальный) → возвращаем alreadyExists.
      //   2. Bundle есть, но все его документы удалены или сам он в
      //      parse_failed → «переиспользуем»: сбрасываем status='queued',
      //      создаём новый тех. документ + attachments, кладём в очередь.
      //   3. Bundle нет → INSERT нового.
      const [existingBundle] = await app.db
        .select()
        .from(sourceBundles)
        .where(eq(sourceBundles.bundleHash, bundleHash))
        .limit(1);
      if (existingBundle) {
        const [existingDoc] = await app.db
          .select()
          .from(sourceDocuments)
          .where(eq(sourceDocuments.bundleId, existingBundle.id))
          .limit(1);
        if (existingDoc) {
          const names = await loadSdNames(app, existingDoc);
          return UpdPdfQueueResponseSchema.parse({
            created: sdRow(existingDoc, names),
            alreadyExists: true,
          });
        }
        // Bundle есть, но «осиротевший» — перезапускаем распознавание.
      }

      const [wbSite] = await app.db
        .select({ code: sites.code })
        .from(sites)
        .where(eq(sites.id, siteId))
        .limit(1);
      const [wbCp] = contractorId
        ? await app.db
            .select({ inn: counterparties.inn, name: counterparties.name })
            .from(counterparties)
            .where(eq(counterparties.id, contractorId))
            .limit(1)
        : [];

      // 1) Создаём (или переиспользуем существующий «осиротевший») bundle.
      let bundle: typeof sourceBundles.$inferSelect;
      if (existingBundle) {
        // Переиспользование: сбрасываем статус и метаданные перезагрузки,
        // bundle_hash остаётся (уникальный индекс не пересоздаётся).
        const [updated] = await app.db
          .update(sourceBundles)
          .set({
            direction,
            siteId,
            contractorId: contractorId ?? null,
            recipientMolId: recipientMolId ?? null,
            expectedDate: expectedDate ? new Date(expectedDate) : null,
            status: 'queued',
            parseErrorCode: null,
            parseErrorMessage: null,
            docCount: 0,
            createdByUserId: req.user?.id ?? existingBundle.createdByUserId,
            updatedAt: new Date(),
          })
          .where(eq(sourceBundles.id, existingBundle.id))
          .returning();
        if (!updated) throw new Error('Failed to update existing source_bundle');
        bundle = updated;
      } else {
        const [inserted] = await app.db
          .insert(sourceBundles)
          .values({
            bundleHash,
            direction,
            siteId,
            contractorId: contractorId ?? null,
            recipientMolId: recipientMolId ?? null,
            expectedDate: expectedDate ? new Date(expectedDate) : null,
            status: 'queued',
            createdByUserId: req.user?.id ?? null,
          })
          .returning();
        if (!inserted) throw new Error('Failed to insert source_bundles');
        bundle = inserted;
      }

      // 2) Грузим файлы в S3 под bundle.id.
      const attachmentsToInsert: Array<{
        s3Key: string;
        filename: string;
        mimeType: string;
        sizeBytes: number;
      }> = [];
      try {
        for (let i = 0; i < collected.length; i++) {
          const f = collected[i]!;
          const safeName = f.filename.replace(/[/\\]/g, '_').slice(-100) || `page-${i + 1}.bin`;
          const s3Key = buildS3Key({
            site: wbSite ?? null,
            counterparty: wbCp ?? null,
            entityType: 'source-documents',
            entityId: bundle.id,
            filename: `wb-${i + 1}-${safeName}`,
          });
          await putObject(s3Key, f.buffer, f.mimetype || 'application/octet-stream');
          attachmentsToInsert.push({
            s3Key,
            filename: safeName,
            mimeType: f.mimetype || 'application/octet-stream',
            sizeBytes: f.buffer.length,
          });
        }
      } catch (err) {
        req.log.error({ err }, 's3 putObject failed for waybill bundle');
        await app.db
          .update(sourceBundles)
          .set({
            status: 'parse_failed',
            parseErrorCode: 'internal_error',
            parseErrorMessage: 's3_unavailable',
            updatedAt: new Date(),
          })
          .where(eq(sourceBundles.id, bundle.id));
        return reply.code(503).send({ error: 's3_unavailable', message: 'S3 недоступен' });
      }

      // 3) Техническая source_document для пакета. Worker после распознавания
      // удалит её и вставит N реальных документов.
      const now = new Date();
      const [tech] = await app.db
        .insert(sourceDocuments)
        .values({
          kind: 'transport_waybill',
          direction,
          origin: 'manual_pdf',
          contractorId: contractorId ?? null,
          recipientMolId: recipientMolId ?? null,
          siteId,
          expectedDate: expectedDate ? new Date(expectedDate) : null,
          status: 'queued',
          contentHash: bundleHash,
          originalFilename: collected[0]?.filename ?? null,
          queuedAt: now,
          parsedAt: now,
          bundleId: bundle.id,
          createdByUserId: req.user?.id ?? null,
        })
        .returning();
      if (!tech) throw new Error('Failed to insert technical source_document');

      await app.db.insert(sourceDocumentAttachments).values(
        attachmentsToInsert.map((a) => ({
          sourceDocumentId: tech.id,
          s3Key: a.s3Key,
          filename: a.filename,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          role: 'original' as const,
        })),
      );

      // 4) В очередь. Worker определит формат job по наличию bundleId.
      await app.queues.updParse.add('parse', { bundleId: bundle.id });

      const names = await loadSdNames(app, tech);
      reply.code(201);
      return UpdPdfQueueResponseSchema.parse({
        created: { ...sdRow(tech, names), jobAttempts: 0 },
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
          await deleteUpdWithRefsCheck(app, sd.id, req.user?.id ?? null, req.log);
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
        await deleteUpdWithRefsCheck(app, existingId, req.user?.id ?? null, req.log);
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
    expectedDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    contractorId: z.string().uuid().nullable().optional(),
    // recipientId — внешний контрагент-получатель для outbound-документов
    // (например, ООО «ТЕПЛО»). Раньше не редактировался через UI, и mobile
    // на «Выезд» Stage1 получал docMeta.recipientId=null → POST shipment с
    // null receiverCounterpartyId → сервер 400. Поле уже есть в БД и в DTO,
    // не достаёт лишь возможности проставить из портала.
    recipientId: z.string().uuid().nullable().optional(),
    recipientMolId: z.string().uuid().nullable().optional(),
    siteId: z.string().uuid().nullable().optional(),
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
      if (req.body.expectedDate !== undefined) {
        upd.expectedDate = req.body.expectedDate ? new Date(req.body.expectedDate) : null;
      }
      if (req.body.contractorId !== undefined) upd.contractorId = req.body.contractorId;
      if (req.body.recipientId !== undefined) upd.recipientId = req.body.recipientId;
      if (req.body.recipientMolId !== undefined) upd.recipientMolId = req.body.recipientMolId;
      if (req.body.siteId !== undefined) upd.siteId = req.body.siteId;
      if (req.body.totalSum !== undefined) {
        upd.totalSum =
          req.body.totalSum === null
            ? null
            : typeof req.body.totalSum === 'number'
              ? req.body.totalSum.toString()
              : req.body.totalSum;
      }
      if (req.body.supplier) {
        // Ручная правка поставщика — пишем в справочник `suppliers` (тот же
        // путь, что у распознавания). counterparties не растёт, supplier_id
        // обнуляем — DTO supplierName собирается через COALESCE.
        const match = await matchOrCreateSupplier(app, {
          inn: req.body.supplier.inn ?? null,
          kpp: req.body.supplier.kpp ?? null,
          name: req.body.supplier.name,
        });
        upd.supplierId = null;
        upd.supplierDirectoryId = match?.id ?? null;
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
      // SSE: мобила слушает source_document_updated и дёргает /sync, чтобы
      // обновить локальную копию документа. Без этого PATCH-эвента
      // изменения (дата поставки, получатель, реквизиты) долетали до
      // мобилы только через periodic Worker (15 мин) или onResume —
      // и УПД не перепрыгивала «Сегодня» ↔ «Остальные» вовремя.
      publishEvent(app, {
        type: 'source_document_updated',
        entityId: updated.id,
        ts: new Date().toISOString(),
      });
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
      // SSE: переключение direction УПД («Приёмка»↔«Отгрузка») должно
      // мгновенно убрать документ из противоположного списка ожидаемых
      // на мобиле, иначе менеджер правит direction, а инспектор всё ещё
      // видит документ в старой вкладке до периодического sync.
      publishEvent(app, {
        type: 'source_document_updated',
        entityId: updated.id,
        ts: new Date().toISOString(),
      });
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
        await deleteUpdWithRefsCheck(app, req.params.id, req.user?.id ?? null, req.log);
      } catch (err) {
        if (err instanceof HasReferencesError) {
          return reply.code(409).send({ error: 'has_references', message: err.message });
        }
        throw err;
      }

      publishEvent(app, {
        type: 'source_document_deleted',
        entityId: req.params.id,
        ts: new Date().toISOString(),
      });
      return { ok: true as const };
    },
  );

  // ──────────── Массовое удаление source_documents ────────────
  // Best-effort: каждая запись — независимая транзакция. С привязками
  // к приёмке/отгрузке (delivery_sources/shipment_sources) НЕ удаляются,
  // попадают в `skipped` с reason='has_references'. Это позволяет фронту
  // показать пользователю «удалено X, пропущено Y» без отката всей пачки.
  app.post(
    '/api/v1/source-documents/bulk-delete',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        body: SourceDocumentBulkDeleteRequestSchema,
        response: { 200: SourceDocumentBulkDeleteResponseSchema },
      },
    },
    async (req) => {
      const deleted: string[] = [];
      const skipped: Array<{ id: string; reason: 'has_references' | 'not_found' | 'internal_error' }> = [];

      for (const id of req.body.ids) {
        const [existing] = await app.db
          .select({ id: sourceDocuments.id })
          .from(sourceDocuments)
          .where(eq(sourceDocuments.id, id))
          .limit(1);
        if (!existing) {
          skipped.push({ id, reason: 'not_found' });
          continue;
        }
        try {
          await deleteUpdWithRefsCheck(app, id, req.user?.id ?? null, req.log);
          deleted.push(id);
          publishEvent(app, {
            type: 'source_document_deleted',
            entityId: id,
            ts: new Date().toISOString(),
          });
        } catch (err) {
          if (err instanceof HasReferencesError) {
            skipped.push({ id, reason: 'has_references' });
          } else {
            req.log.error({ err, id }, 'bulk-delete: failed to delete source_document');
            skipped.push({ id, reason: 'internal_error' });
          }
        }
      }

      return { deleted, skipped };
    },
  );
}
