import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, ilike, inArray, isNull, sql as drSql } from 'drizzle-orm';
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
  SourceReparseResponseSchema,
  UploadDocumentsResponseSchema,
  ImportResultSchema,
  ExtraOnlyBundleListResponseSchema,
  ErrorResponseSchema,
  getDocumentDisplayStatus,
  getDocumentDisplayStatusLabel,
  isActionableStub,
} from '@matcheck/contracts';
import {
  counterparties,
  deliverySources,
  entityDeletions,
  ingestEvents,
  llmCalls,
  materials,
  responsiblePersons,
  shipmentSources,
  sites,
  sourceBundles,
  sourceDocuments,
  sourceDocumentItems,
  sourceDocumentAttachments,
  bundleImportItems,
  suppliers,
  users,
} from '../db/schema.js';
import { parseUpdXml } from '../domain/edo/upd.parser.js';
import { validateUpdTotals } from '../domain/edo/upd-validation.js';
import { presign, putObject } from '../domain/storage/s3.signer.js';
import { buildS3Key } from '../domain/storage/s3.path.js';
import { publishEvent } from './events.js';
import { matchOrCreateSupplier } from '../domain/sourceDocuments/supplierMatcher.js';
import { collectUploadParts, uploadLimitMessage } from '../domain/sourceDocuments/collect-upload.js';
import { ingestDocumentsBundle } from '../domain/sourceDocuments/ingest-bundle.js';
import {
  documentGroupIdSql,
  documentGroupRevisionSql,
} from '../domain/sourceDocuments/document-group.js';
import { fromSupplierPortalSql } from '../domain/sourceDocuments/public-origin.js';
import { manualRecipientSource } from '../domain/sourceDocuments/resolve-contractor.js';
import {
  selectExtraFiles,
  selectRegistryRows,
  type RegistryRow,
} from '../domain/sourceDocuments/bundle-import-registry.js';
import {
  closeRegistryRowsForDeletedDocument,
  notStubDocumentSql,
} from '../domain/sourceDocuments/stub-documents.js';
import {
  REPARSE_BLOCK_MESSAGES,
  isBlocked,
  resolveReparsePlan,
  type ReparsePlanKind,
} from '../domain/sourceDocuments/reparse-plan.js';
import { enqueueJob } from '../domain/jobs/job-outbox.js';
import { UPD_PARSE_QUEUE } from '../plugins/queue.js';
import type { Db } from '../db/client.js';
import {
  resolveContractorOpIds,
  sourceDocumentContractorPredicate,
  sourceDocumentVisible,
} from '../lib/contractor-scope.js';

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

// Волна 1C: поля серверной сортировки Inbox (совпадают с колонками таблицы).
const SORT_FIELDS = [
  'kind',
  'status',
  'docNumber',
  'docDate',
  'expectedDate',
  'siteName',
  'contractorName',
  'buyerName',
  'consigneeName',
  'supplierName',
  'vatSum',
  'totalSum',
] as const;

const ListQuerySchema = z.object({
  kind: KindFilterSchema,
  direction: z.enum(['inbound', 'outbound']).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  unaccepted: z.coerce.boolean().optional(),
  // Волна 1C — серверные фильтры/сортировка под будущую серверную пагинацию
  // Inbox. ВСЕ опциональные: при отсутствии параметров поведение эндпоинта
  // (фильтры/сортировка/offset/total) не меняется. Текущий Inbox их не шлёт.
  contractorIds: z.string().optional(),
  supplierIds: z.string().optional(),
  siteIds: z.string().optional(),
  docDateFrom: z.string().optional(),
  docDateTo: z.string().optional(),
  expectedDateFrom: z.string().optional(),
  expectedDateTo: z.string().optional(),
  sort: z.enum(SORT_FIELDS).optional(),
  order: z.enum(['asc', 'desc']).optional(),
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
  ext: 'pdf' | 'xlsx' | 'xls' | 'jpg' | 'png' | 'webp';
  mimeType: string;
};

function detectUpdFileFormat(mime: string, filename: string): UpdFileFormat | null {
  const m = (mime ?? '').toLowerCase();
  const f = (filename ?? '').toLowerCase();
  if (m.includes('pdf') || f.endsWith('.pdf')) {
    return { ext: 'pdf', mimeType: 'application/pdf' };
  }
  // .xlsx — OOXML (zip-based). Сигнатура: 'PK' (50 4B 03 04).
  // mime: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
  // или короткое 'spreadsheetml' в варианте от браузеров.
  if (m.includes('spreadsheetml') || f.endsWith('.xlsx')) {
    return {
      ext: 'xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }
  // .xls — BIFF / OLE2 Compound Document. Сигнатура: D0 CF 11 E0 (LE
  // = 0xe011cfd0), та самая, что ExcelJS отвергает с invalid signature.
  // mime: application/vnd.ms-excel. Обрабатываем отдельно — в worker
  // сначала конвертируется в xlsx-буфер через SheetJS, затем уходит
  // в обычный parseUpdXlsx. Раньше всё валилось сюда же что и xlsx,
  // ExcelJS падал на BIFF-сигнатуре с internal_error.
  if (m === 'application/vnd.ms-excel' || f.endsWith('.xls')) {
    return { ext: 'xls', mimeType: 'application/vnd.ms-excel' };
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
  // Стороны самого документа. Имя приходит из COALESCE(*_name_raw, имя
  // контрагента): графу 4 печатают без ИНН, и тогда FK у стороны нет,
  // а показать её всё равно нужно.
  buyerName?: string | null;
  consigneeName?: string | null;
  // ИНН сторон из СПРАВОЧНИКА (suppliers.inn / counterparties.inn по FK).
  // Распознанный ИНН лежит в самом документе и в sdRow идёт первым — здесь
  // только запасной путь для документов, разобранных до миграции 0095.
  supplierInn?: string | null;
  buyerInn?: string | null;
  consigneeInn?: string | null;
  // Email и телефон автора УПД (того, кто загрузил через /upload-upd*).
  // Для EDO/mail-полученных — null. Используется мобильным клиентом
  // для кнопки звонка в шапке списка материалов.
  createdByUserEmail?: string | null;
  createdByUserPhone?: string | null;
  // Документ пришёл с публичной страницы (от поставщика). Считается по
  // наличию ingest_event с channel='public' у КОРНЕВОГО пакета.
  fromSupplierPortal?: boolean;
  // «Машина»: id корневого пакета и версия состава группы. Непустые только для
  // logical_v1-сборки. См. domain/sourceDocuments/document-group.ts.
  groupId?: string | null;
  groupRevision?: number | null;
};

/**
 * Пустая строка — это отсутствие значения, а не значение.
 *
 * И распознавание, и справочники отдают ИНН строкой: модель может вернуть '',
 * а suppliers.inn объявлен NOT NULL DEFAULT '' — в справочнике заказчика таких
 * записей много. Без нормализации '' выиграл бы у `??` и заблокировал
 * запасной источник, показав пустую вторую строку там, где ИНН на самом деле
 * известен.
 */
function cleanInn(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

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
    recipientSource: sd.recipientSource ?? null,
    siteId: sd.siteId,
    supplierName: names.supplierName ?? null,
    contractorName: names.contractorName ?? null,
    recipientName: names.recipientName ?? null,
    recipientMolName: names.recipientMolName ?? null,
    siteName: names.siteName ?? null,
    buyerId: sd.buyerId,
    buyerName: names.buyerName ?? sd.buyerNameRaw ?? null,
    consigneeId: sd.consigneeId,
    consigneeName: names.consigneeName ?? sd.consigneeNameRaw ?? null,
    // Распознанный ИНН первым, справочный вторым. Порядок обратен именам выше
    // не по недосмотру: names.*Name уже приходят COALESCE-выражением, где raw
    // стоит первым, а names.*Inn из loadSdNames — чисто справочные, и они
    // перебили бы то, что напечатано в документе.
    supplierInn: cleanInn(sd.supplierInnRaw) ?? cleanInn(names.supplierInn),
    buyerInn: cleanInn(sd.buyerInnRaw) ?? cleanInn(names.buyerInn),
    consigneeInn: cleanInn(sd.consigneeInnRaw) ?? cleanInn(names.consigneeInn),
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
      | 'unrecognized_type'
      | null) ?? null,
    parseErrorDetails: sd.parseErrorDetails ?? null,
    originalFilename: sd.originalFilename,
    contentHash: sd.contentHash,
    jobAttempts: sd.jobAttempts,
    version: sd.version,
    createdAt: sd.createdAt.toISOString(),
    updatedAt: sd.updatedAt.toISOString(),
    validation: sd.validation ?? null,
    fromSupplierPortal: names.fromSupplierPortal ?? false,
    // Через detail-роут планшет дотягивает документы, которых не хватает после
    // дельты (reconcile и backfill привязанных УПД). Пропустить здесь поля
    // группы — значит оставить их NULL навсегда у всего, что уже закэшировано:
    // дельта по updated_at новую колонку не привозит.
    groupId: names.groupId ?? null,
    groupRevision: names.groupRevision ?? null,
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

// Файл поставки, сохранённый без распознавания. s3Key наружу не отдаём: ссылку
// выдаёт отдельный маршрут, который заново проверяет права.
function extraFileDto(r: RegistryRow) {
  return {
    id: r.id,
    bundleId: r.bundleId,
    filename: r.filename,
    mimeType: r.mimeType,
    sizeBytes: r.sizeBytes,
    detectedKind: r.detectedKind,
    reason: r.reason,
  };
}

/**
 * Общая выдача ссылки на дополнительный файл — для маршрута от документа и для
 * маршрута от пакета.
 *
 * Права вызывающий проверяет сам, здесь — принадлежность файла: строка обязана
 * входить в ЭФФЕКТИВНЫЙ набор корневого пакета и быть терминальным `skipped` с
 * живым ключом S3. Иначе по угаданному itemId достали бы файл брошенной попытки
 * загрузки или чужого статуса.
 */
async function presignExtraFile(
  app: FastifyInstance,
  log: { warn: (o: unknown, m?: string) => void },
  bundleId: string | null,
  itemId: string,
): Promise<
  | { ok: true; url: string; filename: string; mimeType: string | null }
  | { ok: false; error: 'not_found' | 'presign_failed' }
> {
  if (!bundleId) return { ok: false, error: 'not_found' };
  const files = await selectExtraFiles(app.db, bundleId);
  const file = files.find((f) => f.id === itemId);
  if (!file || !file.s3Key) return { ok: false, error: 'not_found' };
  try {
    const url = await presign({ method: 'GET', key: file.s3Key, expiresIn: 3600 });
    return { ok: true, url, filename: file.filename, mimeType: file.mimeType };
  } catch (err) {
    log.warn({ err, key: file.s3Key }, 'presign failed (extra)');
    return { ok: false, error: 'presign_failed' };
  }
}

// Подтягивает имена supplier/contractor/site по ID документа. Используется
// в обработчиках, где sd получен без JOIN (insert/update/single fetch).
async function loadSdNames(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  sd: typeof sourceDocuments.$inferSelect,
): Promise<SdNames> {
  const [supplier, contractor, recipient, buyer, consignee, mol, site, createdBy] =
    await Promise.all([
    // Поставщик: приоритет — справочник `suppliers` (для распознанных УПД
    // после миграции 0064). Fallback — counterparties (исторические УПД и
    // manual XML). Один из ID должен быть заполнен; если оба null — supplier
    // в шапке покажется как «не указан».
    sd.supplierDirectoryId
      ? app.db
          .select({ name: suppliers.name, inn: suppliers.inn })
          .from(suppliers)
          .where(eq(suppliers.id, sd.supplierDirectoryId))
          .limit(1)
      : sd.supplierId
        ? app.db
            .select({ name: counterparties.name, inn: counterparties.inn })
            .from(counterparties)
            .where(eq(counterparties.id, sd.supplierId))
            .limit(1)
        : Promise.resolve([] as { name: string; inn: string | null }[]),
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
    // Стороны документа: запрашиваем имя только когда сторона нормализована.
    // Если ИНН в документе не было, FK пустой — имя возьмётся из *_name_raw
    // ниже, в sdRow.
    sd.buyerId
      ? app.db
          .select({ name: counterparties.name, inn: counterparties.inn })
          .from(counterparties)
          .where(eq(counterparties.id, sd.buyerId))
          .limit(1)
      : Promise.resolve([] as { name: string; inn: string | null }[]),
    sd.consigneeId
      ? app.db
          .select({ name: counterparties.name, inn: counterparties.inn })
          .from(counterparties)
          .where(eq(counterparties.id, sd.consigneeId))
          .limit(1)
      : Promise.resolve([] as { name: string; inn: string | null }[]),
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
    // Источник истины — распознанный текст; имя контрагента лишь fallback для
    // исторических строк, где *_name_raw пуст (см. бэкфилл в миграции 0083).
    buyerName: sd.buyerNameRaw ?? buyer[0]?.name ?? null,
    consigneeName: sd.consigneeNameRaw ?? consignee[0]?.name ?? null,
    // Только справочная часть: распознанный ИНН приоритетнее, и его подставит
    // sdRow. Здесь плейсхолдер '' из suppliers.inn не отсеиваем — это делает
    // cleanInn в sdRow, единым правилом для всех трёх сборщиков DTO.
    supplierInn: supplier[0]?.inn ?? null,
    buyerInn: buyer[0]?.inn ?? null,
    consigneeInn: consignee[0]?.inn ?? null,
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
    // Закрываем строку реестра ДО удаления документа, в той же транзакции.
    // Иначе проверка «у каждого принятого файла есть документ» увидит файл без
    // документа и заведёт заглушку заново — причём призраком: ключи этого
    // документа уходят ниже в очередь на физическое удаление из S3.
    await closeRegistryRowsForDeletedDocument(tx, id, deletedByUserId);
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
      const {
        kind,
        direction,
        q,
        unaccepted,
        limit,
        offset,
        contractorIds,
        supplierIds,
        siteIds,
        docDateFrom,
        docDateTo,
        expectedDateFrom,
        expectedDateTo,
        sort,
        order,
      } = req.query;
      // Техническая запись пакета — служебная: она живёт от загрузки до
      // разбора и не является документом. В списке ей делать нечего.
      const conditions = [eq(sourceDocuments.isTechnical, false)];
      if (kind && kind.length > 0) {
        const first = kind[0];
        if (kind.length === 1 && first) {
          conditions.push(eq(sourceDocuments.kind, first));
        } else {
          conditions.push(inArray(sourceDocuments.kind, kind));
        }
      }
      if (direction) conditions.push(eq(sourceDocuments.direction, direction));
      // Поиск и по имени файла: у заглушки номера нет вовсе, и поиск только по
      // doc_number прятал бы её при любом непустом запросе — то есть ровно те
      // документы, которые менеджер и ищет глазами по названию файла.
      if (q) {
        conditions.push(
          drSql`(${ilike(sourceDocuments.docNumber, `%${q}%`)}
                 or ${ilike(sourceDocuments.originalFilename, `%${q}%`)})`,
        );
      }
      // inspector_kpp видит только документы своего объекта.
      // Без объекта — пустой результат.
      if (req.user?.role === 'inspector_kpp') {
        if (!req.user.siteId) {
          conditions.push(drSql`false`);
        } else {
          conditions.push(eq(sourceDocuments.siteId, req.user.siteId));
        }
      } else if (req.user?.role === 'contractor') {
        // contractor видит только документы своего подрядчика (по contractor_id).
        const opIds = await resolveContractorOpIds(app, req.user);
        if (!opIds || opIds.length === 0) {
          conditions.push(drSql`false`);
        } else {
          conditions.push(sourceDocumentContractorPredicate(opIds));
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
        // Заглушка под ручной разбор (тип не определён, накладная не читается,
        // сертификат, технический сбой) реквизитов не содержит. В «Ожидаемых»
        // на приёмке и КПП ей не место: инспектор не сможет по ней ничего
        // принять, а при массовой загрузке фото такие строки забьют рабочий
        // список. partial_parse остаётся ожидаемой — там шапка распознана, не
        // хватает только позиций.
        conditions.push(notStubDocumentSql());
      }
      // Волна 1C — серверные фильтры (contractor/supplier/site/даты). Опциональны:
      // добавляются в conditions, только если параметр задан → при пустых
      // параметрах WHERE не меняется. Логика повторяет экспорт (supplier матчит
      // и counterparties, и справочник suppliers — как в export.xlsx).
      const csvIds = (raw: string | undefined): string[] =>
        (raw ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      const fContractor = csvIds(contractorIds);
      if (fContractor.length) conditions.push(inArray(sourceDocuments.contractorId, fContractor));
      const fSupplier = csvIds(supplierIds);
      if (fSupplier.length) {
        conditions.push(
          drSql`(${sourceDocuments.supplierId} in ${fSupplier} or ${sourceDocuments.supplierDirectoryId} in ${fSupplier})`,
        );
      }
      const fSite = csvIds(siteIds);
      if (fSite.length) conditions.push(inArray(sourceDocuments.siteId, fSite));
      // Диапазоны дат (docDate/expectedDate — timestamp без TZ, mode:date).
      // Включительно по дню: >= from и < to+1день.
      if (docDateFrom) conditions.push(drSql`${sourceDocuments.docDate} >= ${docDateFrom}::date`);
      if (docDateTo)
        conditions.push(drSql`${sourceDocuments.docDate} < (${docDateTo}::date + interval '1 day')`);
      if (expectedDateFrom)
        conditions.push(drSql`${sourceDocuments.expectedDate} >= ${expectedDateFrom}::date`);
      if (expectedDateTo)
        conditions.push(
          drSql`${sourceDocuments.expectedDate} < (${expectedDateTo}::date + interval '1 day')`,
        );
      const where = conditions.length ? and(...conditions) : undefined;
      const supplier = alias(counterparties, 'supplier');
      const supplierDir = alias(suppliers, 'supplier_dir');
      const contractor = alias(counterparties, 'contractor');
      const recipient = alias(counterparties, 'recipient');
      // Стороны документа: покупатель (графа 6) и грузополучатель (графа 4).
      const buyer = alias(counterparties, 'buyer');
      const consignee = alias(counterparties, 'consignee');
      // Волна 1C — динамическая сортировка (совпадает с клиентскими sorter'ами:
      // приоритет для kind/status, NULLS LAST, tie-breaker по id для детерминизма).
      // Без sort — прежний порядок parsed_at DESC (+ id).
      const dirNulls = drSql.raw(order === 'desc' ? 'desc nulls last' : 'asc nulls last');
      const kindPriority = drSql`case ${sourceDocuments.kind} when 'upd' then 0 when 'request' then 1 when 'transport_waybill' then 2 when 'os2_transfer' then 3 else 4 end`;
      const statusPriority = drSql`case ${sourceDocuments.status} when 'processing' then 0 when 'queued' then 1 when 'needs_resolution' then 2 when 'parse_failed' then 3 when 'parsed' then 4 when 'archived' then 5 else 6 end`;
      const sortExprMap = {
        kind: kindPriority,
        status: statusPriority,
        docNumber: drSql`${sourceDocuments.docNumber}`,
        docDate: drSql`${sourceDocuments.docDate}`,
        expectedDate: drSql`${sourceDocuments.expectedDate}`,
        siteName: drSql`${sites.name}`,
        contractorName: drSql`${contractor.name}`,
        // Сортируем по тому же выражению, что показываем.
        buyerName: drSql`coalesce(${sourceDocuments.buyerNameRaw}, ${buyer.name})`,
        consigneeName: drSql`coalesce(${sourceDocuments.consigneeNameRaw}, ${consignee.name})`,
        supplierName: drSql`coalesce(${supplierDir.name}, ${supplier.name})`,
        vatSum: drSql`${sourceDocuments.vatSum}`,
        totalSum: drSql`${sourceDocuments.totalSum}`,
      } as const;
      const orderByArgs = sort
        ? [drSql`${sortExprMap[sort]} ${dirNulls}`, desc(sourceDocuments.id)]
        : [desc(sourceDocuments.parsedAt), desc(sourceDocuments.id)];
      const rows = await app.db
        .select({
          sd: sourceDocuments,
          // Поставщик — приоритет справочника (новый путь), fallback на
          // counterparties (исторические УПД до миграции 0064).
          supplierName: drSql<string | null>`COALESCE(${supplierDir.name}, ${supplier.name})`,
          contractorName: contractor.name,
          recipientName: recipient.name,
          // Показываем распознанный текст, имя контрагента — fallback для
          // исторических строк (бэкфилл миграции 0083 заполнил только FK).
          buyerName: drSql<string | null>`COALESCE(${sourceDocuments.buyerNameRaw}, ${buyer.name})`,
          consigneeName: drSql<string | null>`COALESCE(${sourceDocuments.consigneeNameRaw}, ${consignee.name})`,
          // Только справочная часть ИНН: распознанный подставит sdRow, у него
          // приоритет. NULLIF(BTRIM(…)) обязателен — suppliers.inn объявлен
          // NOT NULL DEFAULT '', и без него пустая строка справочника выиграла
          // бы у legacy-контрагента с настоящим ИНН.
          supplierInn: drSql<string | null>`COALESCE(NULLIF(BTRIM(${supplierDir.inn}), ''), NULLIF(BTRIM(${supplier.inn}), ''))`,
          buyerInn: drSql<string | null>`NULLIF(BTRIM(${buyer.inn}), '')`,
          consigneeInn: drSql<string | null>`NULLIF(BTRIM(${consignee.inn}), '')`,
          recipientMolName: responsiblePersons.fullName,
          siteName: sites.name,
          fromSupplierPortal: fromSupplierPortalSql,
          groupId: documentGroupIdSql,
          groupRevision: documentGroupRevisionSql,
        })
        .from(sourceDocuments)
        .leftJoin(supplier, eq(sourceDocuments.supplierId, supplier.id))
        .leftJoin(supplierDir, eq(sourceDocuments.supplierDirectoryId, supplierDir.id))
        .leftJoin(contractor, eq(sourceDocuments.contractorId, contractor.id))
        .leftJoin(recipient, eq(sourceDocuments.recipientId, recipient.id))
        .leftJoin(buyer, eq(sourceDocuments.buyerId, buyer.id))
        .leftJoin(consignee, eq(sourceDocuments.consigneeId, consignee.id))
        .leftJoin(
          responsiblePersons,
          eq(sourceDocuments.recipientMolId, responsiblePersons.id),
        )
        .leftJoin(sites, eq(sourceDocuments.siteId, sites.id))
        .where(where)
        .orderBy(...orderByArgs)
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
            buyerName: r.buyerName,
            consigneeName: r.consigneeName,
            supplierInn: r.supplierInn,
            buyerInn: r.buyerInn,
            consigneeInn: r.consigneeInn,
            recipientMolName: r.recipientMolName,
            siteName: r.siteName,
            fromSupplierPortal: r.fromSupplierPortal,
            groupId: r.groupId,
            groupRevision: r.groupRevision,
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
        } else if (req.user?.role === 'contractor') {
          // Экспорт строит свой WHERE отдельно — дублируем contractor-скоуп.
          const opIds = await resolveContractorOpIds(app, req.user);
          if (!opIds || opIds.length === 0) {
            conditions.push(drSql`false`);
          } else {
            conditions.push(sourceDocumentContractorPredicate(opIds));
          }
        }

        const supplier = alias(counterparties, 'supplier');
        const supplierDir = alias(suppliers, 'supplier_dir');
        const contractor = alias(counterparties, 'contractor');
        // Стороны документа — те же колонки, что на экране Документов.
        const buyer = alias(counterparties, 'buyer');
        const consignee = alias(counterparties, 'consignee');
        const rows = await app.db
          .select({
            sd: sourceDocuments,
            supplierName: drSql<string | null>`COALESCE(${supplierDir.name}, ${supplier.name})`,
            contractorName: contractor.name,
            buyerName: drSql<string | null>`COALESCE(${sourceDocuments.buyerNameRaw}, ${buyer.name})`,
            consigneeName: drSql<string | null>`COALESCE(${sourceDocuments.consigneeNameRaw}, ${consignee.name})`,
            siteName: sites.name,
          })
          .from(sourceDocuments)
          .leftJoin(supplier, eq(sourceDocuments.supplierId, supplier.id))
          .leftJoin(supplierDir, eq(sourceDocuments.supplierDirectoryId, supplierDir.id))
          .leftJoin(contractor, eq(sourceDocuments.contractorId, contractor.id))
          .leftJoin(buyer, eq(sourceDocuments.buyerId, buyer.id))
          .leftJoin(consignee, eq(sourceDocuments.consigneeId, consignee.id))
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
          { header: 'Покупатель', key: 'buyerName', width: 28 },
          { header: 'Грузополучатель', key: 'consigneeName', width: 28 },
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
            buyerName: r.buyerName ?? '',
            consigneeName: r.consigneeName ?? '',
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
              buyerName: '',
              consigneeName: '',
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
      // Стороны документа: покупатель (графа 6) и грузополучатель (графа 4).
      const buyer = alias(counterparties, 'buyer');
      const consignee = alias(counterparties, 'consignee');
      const [row] = await app.db
        .select({
          sd: sourceDocuments,
          supplierName: drSql<string | null>`COALESCE(${supplierDir.name}, ${supplier.name})`,
          contractorName: contractor.name,
          recipientName: recipient.name,
          // Показываем распознанный текст, имя контрагента — fallback для
          // исторических строк (бэкфилл миграции 0083 заполнил только FK).
          buyerName: drSql<string | null>`COALESCE(${sourceDocuments.buyerNameRaw}, ${buyer.name})`,
          consigneeName: drSql<string | null>`COALESCE(${sourceDocuments.consigneeNameRaw}, ${consignee.name})`,
          // Только справочная часть ИНН: распознанный подставит sdRow, у него
          // приоритет. NULLIF(BTRIM(…)) обязателен — suppliers.inn объявлен
          // NOT NULL DEFAULT '', и без него пустая строка справочника выиграла
          // бы у legacy-контрагента с настоящим ИНН.
          supplierInn: drSql<string | null>`COALESCE(NULLIF(BTRIM(${supplierDir.inn}), ''), NULLIF(BTRIM(${supplier.inn}), ''))`,
          buyerInn: drSql<string | null>`NULLIF(BTRIM(${buyer.inn}), '')`,
          consigneeInn: drSql<string | null>`NULLIF(BTRIM(${consignee.inn}), '')`,
          recipientMolName: responsiblePersons.fullName,
          siteName: sites.name,
          fromSupplierPortal: fromSupplierPortalSql,
          groupId: documentGroupIdSql,
          groupRevision: documentGroupRevisionSql,
        })
        .from(sourceDocuments)
        .leftJoin(supplier, eq(sourceDocuments.supplierId, supplier.id))
        .leftJoin(supplierDir, eq(sourceDocuments.supplierDirectoryId, supplierDir.id))
        .leftJoin(contractor, eq(sourceDocuments.contractorId, contractor.id))
        .leftJoin(recipient, eq(sourceDocuments.recipientId, recipient.id))
        .leftJoin(buyer, eq(sourceDocuments.buyerId, buyer.id))
        .leftJoin(consignee, eq(sourceDocuments.consigneeId, consignee.id))
        .leftJoin(
          responsiblePersons,
          eq(sourceDocuments.recipientMolId, responsiblePersons.id),
        )
        .leftJoin(sites, eq(sourceDocuments.siteId, sites.id))
        .where(eq(sourceDocuments.id, req.params.id))
        .limit(1);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      const sd = row.sd;
      if (!(await sourceDocumentVisible(app, req.user, sd))) {
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
        buyerName: row.buyerName,
        consigneeName: row.consigneeName,
        supplierInn: row.supplierInn,
        buyerInn: row.buyerInn,
        consigneeInn: row.consigneeInn,
        recipientMolName: row.recipientMolName,
        siteName: row.siteName,
        fromSupplierPortal: row.fromSupplierPortal,
        groupId: row.groupId,
        groupRevision: row.groupRevision,
      });

      // Комментарий поставщика к поставке. Персональных данных здесь нет
      // (контактные поля убраны миграцией 0082), поэтому отдаём всем, кто
      // вообще видит документ — инспектору на объекте он тоже полезен.
      let submission: { comment: string | null; submittedAt: string } | null = null;
      if (row.fromSupplierPortal) {
        // Отправок на одном пакете может быть несколько (тот же комплект
        // прислали повторно) — показываем последнюю.
        const [ev] = await app.db
          .select({
            comment: ingestEvents.submissionComment,
            createdAt: ingestEvents.createdAt,
          })
          .from(ingestEvents)
          .where(
            and(
              eq(ingestEvents.channel, 'public'),
              drSql`${ingestEvents.bundleId} = (
                select coalesce(b.parent_bundle_id, b.id)
                  from ${sourceBundles} b
                 where b.id = ${sd.bundleId}
              )`,
            ),
          )
          .orderBy(desc(ingestEvents.createdAt))
          .limit(1);
        if (ev) {
          submission = { comment: ev.comment, submittedAt: ev.createdAt.toISOString() };
        }
      }

      // Файлы поставки, сохранённые без распознавания. Берутся с КОРНЕВОГО
      // пакета: накладные router разворачивает в дочерний, а сертификаты висят
      // на родителе — иначе в карточке накладной блок был бы пуст. У документа
      // без пакета (загружен поштучно) дополнительных файлов быть не может.
      //
      // Строку, из которой вырос САМ этот документ, из блока убираем: файл уже
      // показан как оригинал документа, и висеть приложением к себе же он не
      // должен. Актуально для заглушек — у них исход строки «документ есть», но
      // у исторических строк исход мог остаться прежним.
      const extraFiles = sd.bundleId
        ? (await selectExtraFiles(app.db, sd.bundleId)).filter(
            (r) => r.stubDocumentId !== sd.id && !r.createdDocumentIds.includes(sd.id),
          )
        : [];

      return {
        ...base,
        validation: liveValidation,
        items: items.map(itemDto),
        attachments: attachments.map(attachmentDto),
        extraFiles: extraFiles.map(extraFileDto),
        submission,
      };
    },
  );

  // Ссылка на дополнительный файл поставки, открытая из карточки документа.
  // Права те же, что у оригинала документа: сам файл ими и защищён.
  app.get(
    '/api/v1/source-documents/:id/extra/:itemId/url',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid(), itemId: z.string().uuid() }),
        response: { 200: SourceDocumentFileResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const [sd] = await app.db
        .select({
          bundleId: sourceDocuments.bundleId,
          siteId: sourceDocuments.siteId,
          contractorId: sourceDocuments.contractorId,
          recipientSource: sourceDocuments.recipientSource,
          isTechnical: sourceDocuments.isTechnical,
        })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.id, req.params.id))
        .limit(1);
      if (!sd || !(await sourceDocumentVisible(app, req.user, sd))) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const link = await presignExtraFile(app, req.log, sd.bundleId, req.params.itemId);
      if (!link.ok) return reply.code(404).send({ error: link.error });
      return { url: link.url, filename: link.filename, mimeType: link.mimeType };
    },
  );

  // Скачивание дополнительного файла поставки: поток через бэкенд с
  // Content-Disposition: attachment. Presigned-ссылка (маршрут `/url` выше) для
  // этого не годится — S3 отдаёт файл inline, и браузер jpg/pdf показал бы
  // вкладкой вместо сохранения. Карточке документа нужно именно сохранение,
  // поэтому presigned URL наружу здесь не выходит вовсе.
  app.get(
    '/api/v1/source-documents/:id/extra/:itemId/raw',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid(), itemId: z.string().uuid() }),
      },
    },
    async (req, reply) => {
      // Права и принадлежность файла — теми же двумя проверками, что и у `/url`.
      const [sd] = await app.db
        .select({
          bundleId: sourceDocuments.bundleId,
          siteId: sourceDocuments.siteId,
          contractorId: sourceDocuments.contractorId,
          recipientSource: sourceDocuments.recipientSource,
          isTechnical: sourceDocuments.isTechnical,
        })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.id, req.params.id))
        .limit(1);
      if (!sd || !(await sourceDocumentVisible(app, req.user, sd))) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const link = await presignExtraFile(app, req.log, sd.bundleId, req.params.itemId);
      if (!link.ok) return reply.code(404).send({ error: link.error });

      let upstream: Response;
      try {
        upstream = await fetch(link.url);
      } catch (err) {
        req.log.warn({ err, itemId: req.params.itemId }, 'S3 fetch failed (extra)');
        return reply.code(502).send({ error: 's3_unavailable' });
      }
      // Условных заголовков не шлём, диапазонов не запрашиваем — 206/304 здесь
      // взяться неоткуда, любой не-2xx означает проблему на стороне S3. Пустое
      // тело при 200 — тоже: файлы нулевой длины отсеиваются ещё на приёме.
      if (!upstream.ok || !upstream.body) {
        req.log.warn(
          { status: upstream.status, itemId: req.params.itemId },
          'S3 returned non-OK for extra download',
        );
        return reply.code(502).send({ error: 's3_unavailable' });
      }

      const len = upstream.headers.get('content-length');
      if (len) reply.header('content-length', len);
      reply.header('content-type', link.mimeType ?? 'application/octet-stream');
      reply.header(
        'content-disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(link.filename)}`,
      );
      reply.header('cache-control', 'private, max-age=300');
      return reply.send(Readable.fromWeb(upstream.body as never));
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
      // Права те же, что у карточки документа: одно правило на все маршруты,
      // иначе следующая правка ролей разойдётся с одной из копий.
      const [visible] = await app.db
        .select({
          siteId: sourceDocuments.siteId,
          contractorId: sourceDocuments.contractorId,
          // Без recipient_source проверка пропустила бы автоподставленного
          // подрядчика и отдала оригинал файла — см. contractor-scope.ts.
          recipientSource: sourceDocuments.recipientSource,
          isTechnical: sourceDocuments.isTechnical,
        })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.id, req.params.id))
        .limit(1);
      if (!visible || !(await sourceDocumentVisible(app, req.user, visible))) {
        return reply.code(404).send({ error: 'not_found' });
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
      // Права те же, что у карточки документа: одно правило на все маршруты,
      // иначе следующая правка ролей разойдётся с одной из копий.
      const [visible] = await app.db
        .select({
          siteId: sourceDocuments.siteId,
          contractorId: sourceDocuments.contractorId,
          // Без recipient_source проверка пропустила бы автоподставленного
          // подрядчика и отдала оригинал файла — см. contractor-scope.ts.
          recipientSource: sourceDocuments.recipientSource,
          isTechnical: sourceDocuments.isTechnical,
        })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.id, req.params.id))
        .limit(1);
      if (!visible || !(await sourceDocumentVisible(app, req.user, visible))) {
        return reply.code(404).send({ error: 'not_found' });
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
          supplierInnRaw: parsed.supplier.inn ?? null,
          recipientId,
          // Покупатель документа. Раньше XML-путь писал распознанного получателя
          // только в recipient_id, и в списке колонка «Покупатель» у таких
          // документов оставалась пустой: бэкфилл миграции 0083 закрыл лишь то,
          // что было в базе на момент миграции, а новые записи приходили без
          // buyer_*.
          //
          // Здесь копируем не «операционного получателя», а распознанную сторону:
          // recipientId на этом маршруте всегда собран из parsed.recipient, чем
          // и отличается от outbound-документов, где то же поле позже правит
          // человек в карточке. Поэтому копия безопасна для обоих направлений.
          buyerId: recipientId,
          buyerNameRaw: parsed.recipient?.name ?? null,
          buyerInnRaw: parsed.recipient?.inn ?? null,
          contractorId,
          recipientSource: manualRecipientSource({
            direction: req.body.direction,
            contractorId,
            recipientMolId: null,
          }),
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
          // Получателя выбрал человек в форме — см. manualRecipientSource.
          recipientSource: manualRecipientSource({
            direction,
            contractorId: contractorId ?? null,
            recipientMolId: recipientMolId ?? null,
          }),
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
          // Служебная запись: исключается из /sync, списка и экспорта. Флагом,
          // а не по kind — у реальных накладных тот же kind.
          isTechnical: true,
          direction,
          origin: 'manual_pdf',
          contractorId: contractorId ?? null,
          recipientMolId: recipientMolId ?? null,
          // Получателя выбрал человек в форме — см. manualRecipientSource.
          recipientSource: manualRecipientSource({
            direction,
            contractorId: contractorId ?? null,
            recipientMolId: recipientMolId ?? null,
          }),
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

  // ──────────── Единый вход «Загрузить документы» (router) ────────────
  // Экспериментальный общий вход: принимает любые поддерживаемые файлы
  // (PDF/Excel/изображения), кладёт пакет как source_bundle(kind='mixed') и
  // ставит job с mode:'router'. Worker (handleDocumentRouterJob) сам
  // классифицирует каждый файл и разворачивает в существующие парсеры,
  // записывая решение в bundle_import_items. Старые точечные эндпоинты не
  // трогаются. Структурно — форк upload-waybill с расширенным accept.
  app.post(
    '/api/v1/source-documents/upload-documents',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
    },
    async (req, reply) => {
      // Разбор тела и запись пакета вынесены в domain/sourceDocuments:
      // тем же ядром пользуется публичная страница поставщика. Здесь остаётся
      // только контракт HTTP. Режимы 'legacy' сохраняют прежнее поведение
      // внутреннего входа: молчаливое отбрасывание неподдерживаемых файлов,
      // перезапуск осиротевшего пакета без окна ожидания, queue.add напрямую.
      const collected = await collectUploadParts(
        req,
        {
          maxFiles: 20,
          maxFileBytes: 10 * 1024 * 1024,
          maxTotalBytes: 20 * 1024 * 1024,
          maxFields: 20,
          maxFieldBytes: 4096,
          maxParts: 50,
        },
        'legacy',
      );
      if (!collected.ok) {
        return reply.code(413).send({
          error: collected.error,
          message: uploadLimitMessage(collected.error),
        });
      }
      if (collected.accepted.length === 0) {
        return reply.code(400).send({ error: 'no_files', message: 'Не приложен ни один файл' });
      }

      const meta = UpdPdfQueueRequestSchema.safeParse(collected.fields);
      if (!meta.success) {
        return reply.code(400).send({
          error: 'bad_request',
          message: meta.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        });
      }
      const { direction, contractorId, recipientMolId, siteId, expectedDate } = meta.data;

      const result = await ingestDocumentsBundle(
        { db: app.db, queue: app.queues.updParse, log: req.log },
        {
          files: collected.accepted,
          direction,
          siteId,
          contractorId,
          recipientMolId,
          expectedDate,
          actorUserId: req.user?.id ?? null,
          dispatch: 'direct',
          concurrency: 'legacy',
        },
      );

      if (result.outcome === 's3_unavailable') {
        return reply.code(503).send({ error: 's3_unavailable', message: 'S3 недоступен' });
      }
      // Отказа cross_scope больше нет. Он появился как защита от «прилипания»
      // к чужому пакету, но лечил следствие: bundle_hash был чистым хешем
      // содержимого под UNIQUE, поэтому тот же комплект физически не мог
      // существовать на двух объектах. Теперь в bundle_hash лежит хеш scope +
      // содержимого, пакеты по построению разные, и прилипать не к чему.
      if (result.outcome === 'reused') {
        return UploadDocumentsResponseSchema.parse({
          bundleId: result.bundleId,
          status: result.status,
          alreadyExists: true,
        });
      }

      reply.code(201);
      return UploadDocumentsResponseSchema.parse({
        bundleId: result.bundleId,
        status: 'queued',
        alreadyExists: false,
      });
    },
  );

  // ──────────── Результат импорта пачки (журнал решений router) ────────────
  app.get(
    '/api/v1/source-documents/import-result/:bundleId',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
    },
    async (req, reply) => {
      const { bundleId } = req.params as { bundleId: string };
      const [bundle] = await app.db
        .select({
          id: sourceBundles.id,
          status: sourceBundles.status,
          activeUploadGeneration: sourceBundles.activeUploadGeneration,
        })
        .from(sourceBundles)
        .where(eq(sourceBundles.id, bundleId))
        .limit(1);
      if (!bundle) {
        return reply.code(404).send({ error: 'not_found', message: 'Пакет не найден' });
      }
      // Только строки живой загрузки. Раньше брались все строки пакета, и у
      // перезалитого пакета рядом с активным поколением оказались бы строки
      // прошлой попытки — сводка и список показали бы каждый файл дважды.
      const rows = await selectRegistryRows(app.db, bundleId, bundle.activeUploadGeneration);

      const items = [...rows]
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((r) => ({
          id: r.id,
          sourceFilename: r.filename,
          detectedKind: r.detectedKind,
          confidence: r.confidence != null ? Number(r.confidence) : null,
          parserUsed: r.parserUsed,
          status: r.status,
          reason: r.reason,
          createdDocumentIds: Array.isArray(r.createdDocumentIds) ? r.createdDocumentIds : [],
        }));
      const summary = {
        created: items.filter((i) => i.status === 'created').length,
        needsReview: items.filter((i) => i.status === 'needs_review').length,
        failed: items.filter((i) => i.status === 'failed').length,
        skipped: items.filter((i) => i.status === 'skipped').length,
      };
      return ImportResultSchema.parse({ bundleId, status: bundle.status, summary, items });
    },
  );

  // ──────────── Комплекты без распознанных документов ────────────
  //
  // Поставка, из которой не появилось ни одного документа: прислали только
  // сертификаты, либо тип ни одного файла определить не удалось. Карточки у неё
  // нет, и это единственный способ добраться до её файлов. Ограничено
  // admin/manager: инструмент разбора, а не витрина для объекта.
  app.get(
    '/api/v1/source-bundles/extra-only',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: ExtraOnlyBundleListResponseSchema },
      },
    },
    async (req) => {
      // Пакет попадает сюда, когда у него нет документов ни своих, ни в
      // дочернем пакете (накладные разворачиваются именно туда), но есть хотя
      // бы один файл, сохранённый без распознавания. Дочерний пакет
      // адресуется алиасом прямо в SQL: alias() из drizzle рендерит только имя
      // алиаса и в сырой подзапрос не годится.
      // Технические записи (служебная строка router-пакета, заглушка дочернего
      // waybill-пакета) документом не считаются: пакет, где разбор кончился
      // ничем, отличается от разобранного именно наличием ЖИВОГО документа.
      // Без этого условия провалившаяся накладная прятала пакет целиком.
      const noDocuments = drSql`not exists (
        select 1 from ${sourceDocuments} sd
         where sd.bundle_id = ${sourceBundles.id} and not sd.is_technical
      ) and not exists (
        select 1
          from ${sourceDocuments} sd
          join ${sourceBundles} cb on cb.id = sd.bundle_id
         where cb.parent_bundle_id = ${sourceBundles.id} and not sd.is_technical
      ) and exists (
        select 1
          from ${bundleImportItems} bi
         where bi.bundle_id = ${sourceBundles.id}
           and (bi.effective_status = 'failed'
                or bi.status in ('skipped', 'failed', 'needs_review'))
           and bi.input_s3_key is not null
      )`;
      const where = and(isNull(sourceBundles.parentBundleId), noDocuments);

      const [counted] = await app.db
        .select({ total: drSql<number>`count(*)::int` })
        .from(sourceBundles)
        .where(where);
      const total = counted?.total ?? 0;

      const rows = await app.db
        .select({
          bundleId: sourceBundles.id,
          activeUploadGeneration: sourceBundles.activeUploadGeneration,
          siteName: sites.name,
          expectedDate: sourceBundles.expectedDate,
          createdAt: sourceBundles.createdAt,
          comment: ingestEvents.submissionComment,
        })
        .from(sourceBundles)
        .leftJoin(sites, eq(sites.id, sourceBundles.siteId))
        // Публичных отправок на пакете может быть несколько — берём последнюю.
        .leftJoin(
          ingestEvents,
          drSql`${ingestEvents.id} = (
            select ie.id from ${ingestEvents} ie
             where ie.bundle_id = ${sourceBundles.id} and ie.channel = 'public'
             order by ie.created_at desc
             limit 1
          )`,
        )
        .where(where)
        .orderBy(desc(sourceBundles.createdAt))
        .limit(req.query.limit)
        .offset(req.query.offset);

      const items = await Promise.all(
        rows.map(async (b) => ({
          bundleId: b.bundleId,
          siteName: b.siteName,
          expectedDate: b.expectedDate ? new Date(b.expectedDate).toISOString().slice(0, 10) : null,
          createdAt: b.createdAt.toISOString(),
          comment: b.comment,
          files: (await selectExtraFiles(app.db, b.bundleId)).map(extraFileDto),
        })),
      );
      return { items, total: total ?? 0 };
    },
  );

  // Ссылка на дополнительный файл из раздела выше: документа, к которому можно
  // было бы привязать права, у такого пакета нет.
  app.get(
    '/api/v1/source-bundles/:bundleId/extra/:itemId/url',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ bundleId: z.string().uuid(), itemId: z.string().uuid() }),
        response: { 200: SourceDocumentFileResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const link = await presignExtraFile(app, req.log, req.params.bundleId, req.params.itemId);
      if (!link.ok) return reply.code(404).send({ error: link.error });
      return { url: link.url, filename: link.filename, mimeType: link.mimeType };
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
        .where(
          and(
            eq(sourceDocuments.id, req.params.id),
            // Служебная запись пакета — держатель вложений на время разбора и
            // промежуточный документ сборки логических УПД. Снаружи её не
            // существует, поэтому мутация по прямому id отвечает 404.
            eq(sourceDocuments.isTechnical, false),
          ),
        )
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

  // ──────────── Повторное распознавание ────────────
  //
  // Кнопка «Распознать повторно»: документ распознаётся заново ТЕМ ЖЕ путём,
  // каким появился (см. resolveReparsePlan). Исходный файл не трогается вовсе —
  // ни S3-объект, ни строка вложения; заменяются только распознанные данные.
  //
  // Позиции здесь НЕ удаляются: до конца разбора в списке видны прежние, а
  // замена происходит одной транзакцией в воркере. Так неудачный повтор не
  // оставляет документ без позиций.
  app.post(
    '/api/v1/source-documents/:id/reparse',
    {
      // Только admin в allow-list: в дефолте повтор не выдан никому, а роль,
      // которой администратор поставил галочку, проходит сюда расширением —
      // req.permissionExpanded снимает список ролей (см. plugins/auth.ts).
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: SourceReparseResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const userId = req.user?.id ?? null;
      type Outcome =
        | { ok: true; plan: ReparsePlanKind }
        | { ok: false; error: string; code: 404 | 409; message?: string };
      const result: Outcome = await app.db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        // FOR UPDATE: два клика подряд и гонка с воркером иначе поставили бы два
        // задания на один документ. В соседнем resolve-duplicate этой защиты
        // нет — повторять пробел не нужно.
        const [sd] = await tx
          .select()
          .from(sourceDocuments)
          .where(
            and(
              eq(sourceDocuments.id, req.params.id),
              // Служебная запись пакета снаружи не существует.
              eq(sourceDocuments.isTechnical, false),
            ),
          )
          .for('update')
          .limit(1);
        if (!sd) return { ok: false, error: 'not_found', code: 404 };
        if (sd.status === 'queued' || sd.status === 'processing') {
          return {
            ok: false,
            error: 'already_running',
            code: 409,
            message: 'Документ уже в очереди на распознавание',
          };
        }

        const generation = sd.dispatchGeneration + 1;
        const plan = await resolveReparsePlan(tx, sd, generation);
        if (isBlocked(plan)) {
          return {
            ok: false,
            error: plan.blocked,
            code: 409,
            message: REPARSE_BLOCK_MESSAGES[plan.blocked],
          };
        }

        // Снимок «что было до». Нужен не для истории, а для отката: ниже
        // меняются статус и second_pass, и без снимка неудачный повтор оставил
        // бы документ хуже, чем он был. Всё остальное (parse_error*, validation,
        // processed_at) не трогаем вовсе — их погасит успешный разбор.
        await tx
          .update(sourceDocuments)
          .set({
            status: 'queued',
            dispatchGeneration: generation,
            queuedAt: new Date(),
            jobId: plan.dedupeKey,
            jobAttempts: 0,
            // Иначе queueSecondPass сочтёт, что повтор картинкой уже был, и
            // слабый результат второго шанса не получит.
            secondPass: null,
            reparse: {
              state: 'queued',
              generation,
              at: new Date().toISOString(),
              by: userId,
              snapshot: {
                status: sd.status,
                parseErrorCode: sd.parseErrorCode,
                parseErrorDetails: sd.parseErrorDetails,
                validation: sd.validation,
                processedAt: sd.processedAt ? sd.processedAt.toISOString() : null,
                secondPass: sd.secondPass,
              },
            },
            updatedAt: new Date(),
          })
          .where(eq(sourceDocuments.id, sd.id));

        // Через outbox, а не queue.add: задание и новое состояние документа
        // попадают в БД одной транзакцией, и недоступность Redis не оставит
        // документ в queued без задания.
        await enqueueJob(tx, {
          queue: UPD_PARSE_QUEUE,
          jobName: 'parse',
          payload: plan.payload,
          dedupeKey: plan.dedupeKey,
        });

        return { ok: true, plan: plan.kind };
      });

      if (!result.ok) {
        return reply
          .code(result.code)
          .send({ error: result.error, ...(result.message ? { message: result.message } : {}) });
      }
      req.log.info({ sourceDocumentId: req.params.id, plan: result.plan }, 'reparse requested');
      return { ok: true as const, plan: result.plan };
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
        .where(
          and(
            eq(sourceDocuments.id, req.params.id),
            // Служебная запись пакета — держатель вложений на время разбора и
            // промежуточный документ сборки логических УПД. Снаружи её не
            // существует, поэтому мутация по прямому id отвечает 404.
            eq(sourceDocuments.isTechnical, false),
          ),
        )
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
    // «Разобрано вручную» — кнопка на документе, тип которого распознать не
    // удалось (unrecognized_type). Автоматически такой документ из
    // needs_resolution не выйдет: расхождений в нём нет, пересчитывать нечего,
    // а без явного завершения он остался бы «живым» навсегда и портал
    // опрашивал бы его каждые 4 секунды.
    resolveManually: z.boolean().optional(),
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
        .where(
          and(
            eq(sourceDocuments.id, req.params.id),
            // Служебная запись пакета — держатель вложений на время разбора и
            // промежуточный документ сборки логических УПД. Снаружи её не
            // существует, поэтому мутация по прямому id отвечает 404.
            eq(sourceDocuments.isTechnical, false),
          ),
        )
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

      // Пометка «получателя задал человек» — только когда пара получателя
      // ДЕЙСТВИТЕЛЬНО изменилась. Форма карточки кладёт contractorId в тело при
      // каждом сохранении, даже если правили одну дату (см. onSave в
      // SourceDocumentDetailModal), поэтому проверка на `!== undefined` снимала
      // бы метку auto_buyer с любого документа при первом же открытии карточки.
      //
      // Только inbound: у outbound получатель — recipient_id, а contractor_id
      // там наш отправитель, и на «Черновик» он не влияет.
      if (sd.direction === 'inbound') {
        const nextContractorId =
          upd.contractorId !== undefined ? upd.contractorId : sd.contractorId;
        const nextMolId =
          upd.recipientMolId !== undefined ? upd.recipientMolId : sd.recipientMolId;
        const recipientChanged =
          (nextContractorId ?? null) !== (sd.contractorId ?? null) ||
          (nextMolId ?? null) !== (sd.recipientMolId ?? null);
        if (recipientChanged) upd.recipientSource = 'manual';
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
        // Распознанный ИНН больше не описывает эту сторону: поставщика назвал
        // человек. Обнуляем, а не пишем сюда введённое значение — колонка
        // отвечает на вопрос «что стояло в документе», и подмена сделала бы её
        // непригодной для сверки. DTO после этого возьмёт ИНН из справочной
        // записи, то есть ровно тот, который человек и выбрал.
        upd.supplierInnRaw = null;
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

      // Завершение ручного разбора заглушки. Только по явному флагу: правка
      // полей сама по себе не значит, что человек закончил.
      const resolvingManually =
        req.body.resolveManually === true && isActionableStub({ status: sd.status, parseErrorCode: sd.parseErrorCode });
      if (resolvingManually) {
        // Куда переводить — решают сами данные, и выбора тут по сути нет:
        // ограничение source_upd_required запрещает УПД в статусе `parsed` без
        // номера, даты и суммы. Менеджер ввёл реквизиты (файл действительно был
        // документом) — `parsed`; закрыл как есть (сертификат, дубль, мусор) —
        // `archived`: документ уходит из работы, но остаётся видимым вместе с
        // файлом, а это и есть вся суть правки.
        const nextDocNumber = upd.docNumber !== undefined ? upd.docNumber : sd.docNumber;
        const nextDocDate = upd.docDate !== undefined ? upd.docDate : sd.docDate;
        const nextTotalSum = upd.totalSum !== undefined ? upd.totalSum : sd.totalSum;
        // Комплект реквизитов зависит от вида: CHECK source_upd_required
        // требует сумму только с УПД. В накладной суммы может не быть вовсе
        // (перемещение ОС, отпуск материалов), и требовать её значило бы
        // навсегда запереть такой документ в архиве.
        const needsTotalSum = sd.kind === 'upd';
        const complete =
          nextDocNumber != null &&
          nextDocDate != null &&
          (!needsTotalSum || nextTotalSum != null);
        upd.status = complete ? 'parsed' : 'archived';
        if (complete) {
          // Стал полноценным документом — прошлая ошибка распознавания больше
          // ни на что не влияет.
          upd.parseErrorCode = null;
          upd.parseErrorDetails = null;
        }
        // В архиве код СОХРАНЯЕТСЯ намеренно, и это не «забыли почистить»: по
        // нему такие записи не уезжают в /sync на планшет КПП (там документы
        // отбираются по объекту и дате, без оглядки на статус) и не попадают в
        // «Ожидаемые». Плюс он объясняет менеджеру, почему документ в архиве.
      }

      const [updated] = await app.db
        .update(sourceDocuments)
        .set(upd)
        .where(eq(sourceDocuments.id, sd.id))
        .returning();
      if (!updated) throw new Error('Failed to update source_document');

      // Отметка в реестре входных файлов: кто и когда закрыл вопрос по файлу.
      // Без неё повторная проверка инварианта считала бы файл незакрытым, а в
      // сверке (скрипт по бою) не было бы видно ручных разборов.
      if (resolvingManually && sd.bundleId) {
        await app.db
          .update(bundleImportItems)
          .set({
            resolvedAt: new Date(),
            resolvedByUserId: req.user?.id ?? null,
            manualDocumentId: sd.id,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(bundleImportItems.bundleId, sd.bundleId),
              drSql`${bundleImportItems.createdDocumentIds} @> ${JSON.stringify([sd.id])}::jsonb`,
            ),
          );
      }

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
        .where(
          and(
            eq(sourceDocuments.id, req.params.id),
            // Служебная запись пакета — держатель вложений на время разбора и
            // промежуточный документ сборки логических УПД. Снаружи её не
            // существует, поэтому мутация по прямому id отвечает 404.
            eq(sourceDocuments.isTechnical, false),
          ),
        )
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
        .where(
          and(
            eq(sourceDocuments.id, req.params.id),
            // Служебная запись пакета — держатель вложений на время разбора и
            // промежуточный документ сборки логических УПД. Снаружи её не
            // существует, поэтому мутация по прямому id отвечает 404.
            eq(sourceDocuments.isTechnical, false),
          ),
        )
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
          .where(
            and(
              eq(sourceDocuments.id, id),
              // Служебная запись пакета — держатель вложений на время разбора и
              // промежуточный документ сборки логических УПД. Снаружи её не
              // существует, поэтому мутация по прямому id отвечает 404.
              eq(sourceDocuments.isTechnical, false),
            ),
          )
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
