import type { FastifyInstance } from 'fastify';
import {
  and,
  desc,
  eq,
  gte,
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
  BulkDeleteRequestSchema,
  BulkDeleteResponseSchema,
  ErrorResponseSchema,
  ShipmentConflictResponseSchema,
  ShipmentKindSchema,
  ShipmentListResponseSchema,
  ShipmentMarkDeletionSchema,
  ShipmentSchema,
  ShipmentStatusCodeSchema,
  ShipmentUpsertSchema,
  ReviewRequestSchema,
  SHIPMENT_HARD_DELETE_STATUSES,
  SHIPMENT_SOFT_DELETE_STATUSES,
  type PrimarySourceDocument,
  type OperationSourceDocument,
} from '@matcheck/contracts';
import { computeItemsTotal, computeItemsVatSum } from '../lib/operation-sums.js';
import {
  counterparties,
  entityDeletions,
  s3CleanupOutbox,
  shipments,
  shipmentItems,
  shipmentPhotos,
  shipmentSources,
  sites,
  sourceDocumentItems,
  sourceDocuments,
  statuses,
  suppliers,
  users,
} from '../db/schema.js';
import {
  getStatusCodeById,
  resolveStatusId as resolveStatusIdShared,
} from '../domain/statuses/lookup.js';
import { touchSourceDocuments } from '../domain/sourceDocuments/touch.js';
import { isShipmentDowngrade } from '../domain/operations/status-guard.js';
import { resolveConfirmedAt } from '../domain/operations/confirmed-at.js';
import { FOREIGN_SITE_RESPONSE, ForeignSiteError } from '../domain/operations/foreign-site.js';
import { resolveItemOrigins } from '../domain/operations/item-origin.js';
import {
  buildOperationSourceDocuments,
  SOURCE_DOCUMENT_SUMMARY_COLUMNS,
  type SourceDocumentSummaryRow,
} from '../domain/operations/source-document-summary.js';
import { loadEnv } from '../lib/env.js';
import {
  documentsNeedingRowIds,
  loadProblemRowItemIds,
} from '../domain/operations/source-document-validation.js';
import { canSeeReviewInMatrix } from '../lib/review.js';
import { assertPermission } from '../lib/permissions/assert.js';
import { syncPairedTransferDelivery } from '../domain/transfers/pair.js';
import {
  expandCustomerCounterpartyToOpIds,
  resolveContractorOpIds,
  expandSupplierToOpIds,
} from '../lib/contractor-scope.js';
import { publishEvent } from './events.js';
import { dateRangeConditions } from '../lib/date-range.js';
import { parseUuidCsv } from '../lib/uuid-csv.js';
import { escapeLike } from '../lib/like.js';
import { MONEY_FMT, QTY_FMT, fmtDateTimeRu, numOrNull } from '../lib/xlsx-format.js';

const ListQuerySchema = z.object({
  status: ShipmentStatusCodeSchema.optional(),
  kind: ShipmentKindSchema.optional(),
  siteId: z.string().uuid().optional(),
  inspectorId: z.string().uuid().optional(),
  changedSince: z.string().datetime().optional(),
  // По умолчанию (false/unset) скрывает помеченные на удаление; trash=true показывает корзину.
  trash: z.coerce.boolean().optional(),
  // Фильтр по наличию привязанной УПД: true — только без документа,
  // false — только с документом, undefined — без фильтра.
  noDocument: z.coerce.boolean().optional(),
  // ─── server-side фильтры из /operations?type=shipment&tab=accepted ──
  // CSV id из заказчиковских справочников. Логика парсинга и ИНН-маппинга
  // симметрична deliveries.ts (см. там подробный комментарий).
  contractorIds: z.string().optional(),
  supplierIds: z.string().optional(),
  siteIds: z.string().optional(),
  // Поиск по номеру привязанного документа.
  q: z.string().optional(),
  // Точный поиск по короткому id отгрузки — симметрично deliveries.ts
  // (см. там подробный комментарий). Нумерация у отгрузок своя.
  displayId: z.coerce.number().int().positive().safe().optional(),
  // Поиск по госномеру.
  plate: z.string().optional(),
  // Признаки отгрузки, AND: transit, assets, upd, waybill.
  features: z.string().optional(),
  // Типы отгрузки, OR между выбранными. Передаются как csv. Значения —
  // русские строки из PURPOSE_VALUES (Вывоз материала / Перемещение / ...).
  purposes: z.string().optional(),
  // Диапазон даты отправки (shipped_at).
  shippedFrom: z.string().datetime().optional(),
  shippedTo: z.string().datetime().optional(),
  // ?nophoto=1 — deep-link «Без фото».
  nophoto: z.coerce.boolean().optional(),
  // Порог «давно без фото» в часах — его задаёт плашка «Требует внимания»,
  // чтобы список показывал ровно то, что она посчитала.
  nophotoOlderHours: z.coerce.number().int().positive().max(720).optional(),
  // Фильтр по отметке проверки (менеджмент): approved|issues|none. См. deliveries.ts.
  reviewState: z.enum(['approved', 'issues', 'none']).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

// Параметры фильтрации без пагинации: их принимают и список, и экспорт.
type ShipmentFilterQuery = Omit<z.infer<typeof ListQuerySchema>, 'limit' | 'offset'>;

// ─── Helpers для server-side фильтров (симметрично deliveries.ts) ──────

function parseCsv(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

const KNOWN_FEATURES = new Set(['transit', 'assets', 'upd', 'waybill', 'doc_attention']);
const KNOWN_PURPOSES = new Set([
  'Вывоз материала',
  'Перемещение на объект',
  'Вывоз мусора',
  'Другое',
]);

// expandCustomerCounterpartyToOpIds вынесена в lib/contractor-scope.ts (3-й
// потребитель — скоупинг роли contractor). См. импорт выше.

// Наборы статусов удаления (hard без пометки / soft через mark → admin hard)
// живут в @matcheck/contracts — общий источник с фронтом, см. statuses.ts.

type StatusRow = typeof statuses.$inferSelect;

class SourceAlreadyLinkedError extends Error {
  constructor(public readonly sourceDocumentIds: string[]) {
    super('source_document_already_linked');
  }
}

// См. одноимённую функцию в deliveries.ts. После миграции 0063 одна УПД
// может быть привязана к N отгрузкам — функция no-op, оставлена ради
// совместимости с колл-сайтами. PRIMARY KEY (shipment_id, source_document_id)
// гарантирует уникальность ПАРЫ (повторный INSERT той же пары упадёт на PK).
async function assertSourcesAvailableForShipment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  sourceDocumentIds: string[],
  _excludeShipmentId: string | null,
  /** Объект операции: документ чужого объекта в неё попасть не может. */
  operationSiteId: string | null,
) {
  if (sourceDocumentIds.length === 0) return;
  // FOR UPDATE и сверка объекта — симметрично приёмкам
  // (см. assertSourcesAvailableForDelivery): блокировка строк документов и есть
  // то, что разводит привязку с переносом объекта машины.
  const rows = await app.db
    .select({
      id: sourceDocuments.id,
      siteId: sourceDocuments.siteId,
      isTechnical: sourceDocuments.isTechnical,
    })
    .from(sourceDocuments)
    .where(inArray(sourceDocuments.id, sourceDocumentIds))
    .for('update');
  if (rows.some((r: { isTechnical: boolean }) => r.isTechnical)) {
    throw new TechnicalSourceDocumentError();
  }
  if (operationSiteId) {
    const foreign = rows
      .filter((r: { siteId: string | null }) => (r.siteId ?? null) !== operationSiteId)
      .map((r: { id: string }) => r.id);
    if (foreign.length > 0) throw new ForeignSiteSourceDocumentError(foreign);
  }
}

/** Попытка привязать служебную запись пакета — отвечаем 404, её «нет». */
class TechnicalSourceDocumentError extends Error {
  constructor() {
    super('technical_source_document');
  }
}

/** Документ принадлежит другому объекту — см. одноимённый класс в deliveries.ts. */
class ForeignSiteSourceDocumentError extends Error {
  constructor(readonly sourceDocumentIds: string[]) {
    super('source_document_foreign_site');
  }
}

function isSourceDocumentUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; constraint?: string; constraint_name?: string };
  if (e.code !== '23505') return false;
  const name = e.constraint ?? e.constraint_name ?? '';
  return name.endsWith('_source_document_id_unique');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolveStatusId = (app: any, code: string) => resolveStatusIdShared(app, 'shipment', code);

// Заголовочный select отгрузки (шапка + плоские join-поля). Один и тот же набор
// колонок/join'ов для одиночного (buildShipmentDto) и батч-пути
// (buildShipmentDtosBatch) — чтобы форма DTO гарантированно совпадала. WHERE
// (по id или inArray) навешивает вызывающий. Имена объекта/поставщика/получателя
// — в DTO, чтобы роль contractor не ходила в закрытые справочники.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function selectShipmentHeaders(app: any) {
  const pendingUser = alias(users, 'pending_user');
  const reviewUser = alias(users, 'review_user');
  const shipmentSite = alias(sites, 'shipment_site');
  const supplierCp = alias(counterparties, 'supplier_cp');
  const receiverCp = alias(counterparties, 'receiver_cp');
  return app.db
    .select({
      s: shipments,
      st: statuses,
      molEmail: users.email,
      pendingEmail: pendingUser.email,
      reviewEmail: reviewUser.email,
      siteName: shipmentSite.name,
      supplierName: supplierCp.name,
      receiverName: receiverCp.name,
    })
    .from(shipments)
    .innerJoin(statuses, eq(shipments.statusId, statuses.id))
    .leftJoin(users, eq(shipments.confirmedByMolUserId, users.id))
    .leftJoin(pendingUser, eq(shipments.pendingDeletionByUserId, pendingUser.id))
    .leftJoin(reviewUser, eq(shipments.reviewedByUserId, reviewUser.id))
    .leftJoin(shipmentSite, eq(shipments.siteId, shipmentSite.id))
    .leftJoin(supplierCp, eq(shipments.supplierId, supplierCp.id))
    .leftJoin(receiverCp, eq(shipments.receiverCounterpartyId, receiverCp.id));
}

type ShipmentHeaderRow = {
  s: typeof shipments.$inferSelect;
  st: StatusRow;
  molEmail: string | null;
  pendingEmail: string | null;
  reviewEmail: string | null;
  siteName: string | null;
  supplierName: string | null;
  receiverName: string | null;
};

// Чистая сборка DTO из уже полученных данных — ЕДИНСТВЕННЫЙ источник формы
// ответа (общий для одиночного и батч-пути). Форму DTO менять только здесь.
function assembleShipmentDto(
  r: ShipmentHeaderRow,
  items: (typeof shipmentItems.$inferSelect)[],
  photos: (typeof shipmentPhotos.$inferSelect)[],
  sources: { sourceDocumentId: string }[],
  showReview: boolean,
  primaryDoc: PrimarySourceDocument | null = null,
  // Все документы операции — связанные и оставшиеся в происхождении позиций
  // (зеркало приёмки, см. routes/deliveries.ts).
  sourceDocumentSummaries: OperationSourceDocument[] = [],
) {
  const s = r.s;
  const st = r.st;
  const mappedItems = items.map((i) => ({
    id: i.id,
    sourceDocumentId: i.sourceDocumentId,
    sourceDocumentItemId: i.sourceDocumentItemId,
    itemKind: i.itemKind,
    materialId: i.materialId,
    assetId: i.assetId,
    inventoryNumber: i.inventoryNumber,
    serialNumber: i.serialNumber,
    nameRaw: i.nameRaw,
    qtyPlanned: i.qtyPlanned,
    qtyActual: i.qtyActual,
    unit: i.unit,
    comment: i.comment,
    lineNo: i.lineNo,
    volumeM3: i.volumeM3,
    massKg: i.massKg,
    price: i.price,
    vatRate: i.vatRate,
    vatSum: i.vatSum,
    volumeConfidence: i.volumeConfidence as 'low' | 'medium' | 'high' | null,
    groupName: i.groupName,
  }));
  const mappedPhotos = photos.map((p) => ({
    id: p.id,
    kind: p.kind,
    stage: p.stage,
    s3Key: p.s3Key,
    thumbS3Key: p.thumbS3Key,
    contentHash: p.contentHash,
    takenAt: p.takenAt.toISOString(),
    uploadedAt: p.uploadedAt?.toISOString() ?? null,
  }));
  return {
    id: s.id,
    displayId: s.displayId,
    status: {
      id: st.id,
      entityType: st.entityType,
      code: st.code,
      label: st.label,
      color: st.color,
      sortOrder: st.sortOrder,
    },
    kind: s.kind,
    purpose: s.purpose,
    inTransit: s.inTransit,
    isAssets: s.isAssets,
    siteId: s.siteId,
    receiverCounterpartyId: s.receiverCounterpartyId,
    receiverMolId: s.receiverMolId,
    destSiteId: s.destSiteId,
    supplierId: s.supplierId,
    siteName: r.siteName,
    supplierName: r.supplierName,
    receiverName: r.receiverName,
    vehiclePlate: s.vehiclePlate,
    driverName: s.driverName,
    shippedAt: s.shippedAt?.toISOString() ?? null,
    inspectorId: s.inspectorId,
    comment: s.comment,
    confirmedByMolUserId: s.confirmedByMolUserId,
    confirmedByMolUserEmail: r.molEmail,
    confirmedByMolAt: s.confirmedByMolAt?.toISOString() ?? null,
    // review_* — только для менеджмента (см. canSeeReview); иначе null.
    reviewState: showReview ? (s.reviewState as 'approved' | 'issues' | null) : null,
    reviewNote: showReview ? s.reviewNote : null,
    reviewedByUserId: showReview ? s.reviewedByUserId : null,
    reviewedByUserEmail: showReview ? r.reviewEmail : null,
    reviewedAt: showReview ? (s.reviewedAt?.toISOString() ?? null) : null,
    pendingDeletionAt: s.pendingDeletionAt?.toISOString() ?? null,
    pendingDeletionByUserId: s.pendingDeletionByUserId,
    pendingDeletionByUserEmail: r.pendingEmail,
    pendingDeletionReason: s.pendingDeletionReason,
    version: s.version,
    sourceDocumentIds: sources.map((x) => x.sourceDocumentId),
    items: mappedItems,
    photos: mappedPhotos,
    // Волна 1B — предподсчёты для списка «Операции» (см. ShipmentSchema).
    itemCount: mappedItems.length,
    photoCount: mappedPhotos.length,
    itemsTotal: computeItemsTotal(mappedItems),
    itemsVatSum: computeItemsVatSum(mappedItems),
    primarySourceDocument: primaryDoc,
    sourceDocuments: sourceDocumentSummaries,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

// Одиночный DTO отгрузки (GET /:id, ответы мутаций, share). Внешнее поведение
// не изменилось — та же форма через общий assembleShipmentDto.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildShipmentDto(app: any, id: string, viewerRole?: string | null) {
  const showReview = await canSeeReviewInMatrix(app, viewerRole, 'operations.shipments');
  const rows = await selectShipmentHeaders(app).where(eq(shipments.id, id)).limit(1);
  const r = rows[0] as ShipmentHeaderRow | undefined;
  if (!r) return null;
  // Сортировки явные и совпадают с батч-путём: lineNo дублируется, а
  // sources/photos не сортировались вовсе — «форма одиночного DTO равна форме
  // батча» держалось только на комментарии.
  const items: (typeof shipmentItems.$inferSelect)[] = await app.db
    .select()
    .from(shipmentItems)
    .where(eq(shipmentItems.shipmentId, id))
    .orderBy(shipmentItems.lineNo, shipmentItems.id);
  const photos: (typeof shipmentPhotos.$inferSelect)[] = await app.db
    .select()
    .from(shipmentPhotos)
    .where(eq(shipmentPhotos.shipmentId, id))
    .orderBy(shipmentPhotos.id);
  const sources: { sourceDocumentId: string }[] = await app.db
    .select({ sourceDocumentId: shipmentSources.sourceDocumentId })
    .from(shipmentSources)
    .where(eq(shipmentSources.shipmentId, id))
    .orderBy(shipmentSources.sourceDocumentId);

  const linkedIds = sources.map((x) => x.sourceDocumentId);
  const mentionedIds = [
    ...new Set([
      ...linkedIds,
      ...items.map((i) => i.sourceDocumentId).filter((sid): sid is string => sid !== null),
    ]),
  ];
  const summaryRows: SourceDocumentSummaryRow[] = mentionedIds.length
    ? await app.db
        .select(SOURCE_DOCUMENT_SUMMARY_COLUMNS)
        .from(sourceDocuments)
        .where(inArray(sourceDocuments.id, mentionedIds))
    : [];
  // Идентичность строк нужна только там, где есть построчные проблемы: у
  // здорового документа запрос не выполняется вовсе.
  const rowItemIds = await loadProblemRowItemIds(app.db, documentsNeedingRowIds(summaryRows));

  return assembleShipmentDto(
    r,
    items,
    photos,
    sources,
    showReview,
    null,
    buildOperationSourceDocuments({ rows: summaryRows, linkedIds, mentionedIds, rowItemIds }),
  );
}

// Батч-построение DTO для списка: ~5 запросов на страницу вместо 4×N (устранение
// N+1). Форма каждого элемента идентична buildShipmentDto (общий assembleShipmentDto).
// Порядок страницы — по входному ids; ORDER BY items/sources повторяет одиночный
// PK-скан (lineNo и sourceDocumentId) — sourceDocumentIds[0] не меняется.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildShipmentDtosBatch(app: any, ids: string[], viewerRole?: string | null) {
  if (ids.length === 0) return [];
  const showReview = await canSeeReviewInMatrix(app, viewerRole, 'operations.shipments');
  const headerRows = (await selectShipmentHeaders(app).where(
    inArray(shipments.id, ids),
  )) as ShipmentHeaderRow[];
  const itemRows: (typeof shipmentItems.$inferSelect)[] = await app.db
    .select()
    .from(shipmentItems)
    .where(inArray(shipmentItems.shipmentId, ids))
    .orderBy(shipmentItems.shipmentId, shipmentItems.lineNo, shipmentItems.id);
  const photoRows: (typeof shipmentPhotos.$inferSelect)[] = await app.db
    .select()
    .from(shipmentPhotos)
    .where(inArray(shipmentPhotos.shipmentId, ids))
    .orderBy(shipmentPhotos.shipmentId, shipmentPhotos.id);
  const sourceRows: { shipmentId: string; sourceDocumentId: string }[] = await app.db
    .select({
      shipmentId: shipmentSources.shipmentId,
      sourceDocumentId: shipmentSources.sourceDocumentId,
    })
    .from(shipmentSources)
    .where(inArray(shipmentSources.shipmentId, ids))
    .orderBy(shipmentSources.shipmentId, shipmentSources.sourceDocumentId);

  const headerById = new Map<string, ShipmentHeaderRow>();
  for (const r of headerRows) headerById.set(r.s.id, r);
  const itemsById = new Map<string, (typeof shipmentItems.$inferSelect)[]>();
  for (const it of itemRows) {
    const arr = itemsById.get(it.shipmentId);
    if (arr) arr.push(it);
    else itemsById.set(it.shipmentId, [it]);
  }
  const photosById = new Map<string, (typeof shipmentPhotos.$inferSelect)[]>();
  for (const p of photoRows) {
    const arr = photosById.get(p.shipmentId);
    if (arr) arr.push(p);
    else photosById.set(p.shipmentId, [p]);
  }
  const sourcesById = new Map<string, { sourceDocumentId: string }[]>();
  for (const sc of sourceRows) {
    const arr = sourcesById.get(sc.shipmentId);
    if (arr) arr.push(sc);
    else sourcesById.set(sc.shipmentId, [sc]);
  }

  // Волна 1B — primarySourceDocument (зеркало buildDeliveryDtosBatch). Первый
  // из sourceDocumentIds; имена — тем же COALESCE, что GET /source-documents.
  // +1 запрос на страницу (набор уникальных первых документов) — константа.
  const primaryIdByShipment = new Map<string, string>();
  for (const id of ids) {
    const first = sourcesById.get(id)?.[0]?.sourceDocumentId;
    if (first) primaryIdByShipment.set(id, first);
  }
  // Документы всех отгрузок страницы: связанные плюс те, что остались только в
  // происхождении позиций. Оба набора уже в памяти — реквизиты приезжают тем же
  // запросом, что и primarySourceDocument.
  const mentionedByShipment = new Map<string, string[]>();
  for (const id of ids) {
    const linked = (sourcesById.get(id) ?? []).map((x) => x.sourceDocumentId);
    const fromItems = (itemsById.get(id) ?? [])
      .map((i) => i.sourceDocumentId)
      .filter((sid): sid is string => sid !== null);
    mentionedByShipment.set(id, [...new Set([...linked, ...fromItems])]);
  }
  const allDocIds = [...new Set([...mentionedByShipment.values()].flat())];

  const primaryDocById = new Map<string, PrimarySourceDocument>();
  const summaryRowById = new Map<string, SourceDocumentSummaryRow>();
  if (allDocIds.length) {
    const sdSupplier = alias(counterparties, 'sd_supplier');
    const sdSupplierDir = alias(suppliers, 'sd_supplier_dir');
    const sdContractor = alias(counterparties, 'sd_contractor');
    const sdBuyer = alias(counterparties, 'sd_buyer');
    const sdConsignee = alias(counterparties, 'sd_consignee');
    const sdRows = (await app.db
      .select({
        id: sourceDocuments.id,
        kind: sourceDocuments.kind,
        docNumber: sourceDocuments.docNumber,
        totalSum: sourceDocuments.totalSum,
        contractorId: sourceDocuments.contractorId,
        // Реквизиты для сводки sourceDocuments — тем же запросом (см.
        // SOURCE_DOCUMENT_SUMMARY_COLUMNS).
        status: sourceDocuments.status,
        docDate: sourceDocuments.docDate,
        expectedDate: sourceDocuments.expectedDate,
        vatSum: sourceDocuments.vatSum,
        supplierName: drSql<string | null>`COALESCE(${sdSupplierDir.name}, ${sdSupplier.name})`,
        contractorName: sdContractor.name,
        // Стороны из шапки УПД — тем же COALESCE, что в основном DTO
        // (sdRow в routes/source-documents.ts). Именно COALESCE, а не голый
        // JOIN: графу 4 печатают без ИНН, связать её не с чем, и грузополучатель
        // жил бы только в *_name_raw — в историях операций он бы исчез.
        buyerName: drSql<string | null>`COALESCE(${sourceDocuments.buyerNameRaw}, ${sdBuyer.name})`,
        consigneeName: drSql<
          string | null
        >`COALESCE(${sourceDocuments.consigneeNameRaw}, ${sdConsignee.name})`,
        // ИНН сторон — те же выражения, что в приёмках (deliveries.ts). COALESCE
        // здесь полный, с raw впереди: sdRow, расставляющий приоритет в основном
        // DTO, до снимка операции не доходит. NULLIF(BTRIM(…)) — потому что
        // suppliers.inn объявлен NOT NULL DEFAULT '', и пустая строка иначе
        // заблокировала бы следующий источник.
        supplierInn: drSql<
          string | null
        >`COALESCE(NULLIF(BTRIM(${sourceDocuments.supplierInnRaw}), ''), NULLIF(BTRIM(${sdSupplierDir.inn}), ''), NULLIF(BTRIM(${sdSupplier.inn}), ''))`,
        buyerInn: drSql<
          string | null
        >`COALESCE(NULLIF(BTRIM(${sourceDocuments.buyerInnRaw}), ''), NULLIF(BTRIM(${sdBuyer.inn}), ''))`,
        consigneeInn: drSql<
          string | null
        >`COALESCE(NULLIF(BTRIM(${sourceDocuments.consigneeInnRaw}), ''), NULLIF(BTRIM(${sdConsignee.inn}), ''))`,
        // Снимок сверки — тот же источник, что у одиночного пути через
        // SOURCE_DOCUMENT_SUMMARY_COLUMNS. Здесь колонки перечислены руками, и
        // забыть эту строку значило бы: в карточке плашка есть, в списке её
        // молча нет. Ровно это и стерегут parity-тесты.
        validation: sourceDocuments.validation,
      })
      .from(sourceDocuments)
      .leftJoin(sdSupplier, eq(sourceDocuments.supplierId, sdSupplier.id))
      .leftJoin(sdSupplierDir, eq(sourceDocuments.supplierDirectoryId, sdSupplierDir.id))
      .leftJoin(sdContractor, eq(sourceDocuments.contractorId, sdContractor.id))
      .leftJoin(sdBuyer, eq(sourceDocuments.buyerId, sdBuyer.id))
      .leftJoin(sdConsignee, eq(sourceDocuments.consigneeId, sdConsignee.id))
      .where(inArray(sourceDocuments.id, allDocIds))) as (PrimarySourceDocument &
      SourceDocumentSummaryRow)[];
    for (const sd of sdRows) {
      // primarySourceDocument собираем явным набором полей: сводочные колонки в
      // его схеме не описаны и попадать туда не должны.
      primaryDocById.set(sd.id, {
        id: sd.id,
        kind: sd.kind,
        docNumber: sd.docNumber,
        totalSum: sd.totalSum,
        contractorId: sd.contractorId,
        supplierName: sd.supplierName,
        contractorName: sd.contractorName,
        buyerName: sd.buyerName,
        consigneeName: sd.consigneeName,
        supplierInn: sd.supplierInn,
        buyerInn: sd.buyerInn,
        consigneeInn: sd.consigneeInn,
      });
      summaryRowById.set(sd.id, {
        id: sd.id,
        kind: sd.kind,
        status: sd.status,
        docNumber: sd.docNumber,
        docDate: sd.docDate,
        expectedDate: sd.expectedDate,
        totalSum: sd.totalSum,
        vatSum: sd.vatSum,
        validation: sd.validation,
      });
    }
  }

  // Одна загрузка идентичности строк на всю страницу, а не на операцию: иначе
  // список из 50 приёмок дал бы 50 запросов. Документы без построчных проблем
  // сюда не попадают вовсе.
  const rowItemIds = await loadProblemRowItemIds(
    app.db,
    documentsNeedingRowIds([...summaryRowById.values()]),
  );

  const result: ReturnType<typeof assembleShipmentDto>[] = [];
  for (const id of ids) {
    const r = headerById.get(id);
    if (!r) continue;
    const primaryId = primaryIdByShipment.get(id);
    result.push(
      assembleShipmentDto(
        r,
        itemsById.get(id) ?? [],
        photosById.get(id) ?? [],
        sourcesById.get(id) ?? [],
        showReview,
        (primaryId ? primaryDocById.get(primaryId) : null) ?? null,
        buildOperationSourceDocuments({
          rows: (mentionedByShipment.get(id) ?? [])
            .map((docId) => summaryRowById.get(docId))
            .filter((row): row is SourceDocumentSummaryRow => row !== undefined),
          linkedIds: (sourcesById.get(id) ?? []).map((x) => x.sourceDocumentId),
          mentionedIds: mentionedByShipment.get(id) ?? [],
          rowItemIds,
        }),
      ),
    );
  }
  return result;
}

export async function shipmentRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);
  /**
   * Условия выборки отгрузок — общий источник правды для списка и экспорта.
   * Зеркало buildDeliveryFilters в deliveries.ts: у отгрузок появился свой
   * export.xlsx, и второй копии правил здесь заводить нельзя.
   */
  async function buildShipmentFilters(
    user: Parameters<typeof resolveContractorOpIds>[1],
    query: ShipmentFilterQuery,
  ): Promise<Array<ReturnType<typeof eq>>> {
    const {
      status,
      kind,
      siteId,
      inspectorId,
      changedSince,
      trash,
      noDocument,
      contractorIds: contractorIdsCsv,
      supplierIds: supplierIdsCsv,
      siteIds: siteIdsCsv,
      q,
      displayId,
      plate,
      features: featuresCsv,
      purposes: purposesCsv,
      shippedFrom,
      shippedTo,
      nophoto,
      nophotoOlderHours,
      reviewState,
    } = query;

    const contractorDirIds = parseUuidCsv(contractorIdsCsv);
    const supplierDirIds = parseUuidCsv(supplierIdsCsv);
    const siteIdsArr = parseUuidCsv(siteIdsCsv);
    const featureCodes = parseCsv(featuresCsv).filter((f) => KNOWN_FEATURES.has(f));
    const purposesArr = parseCsv(purposesCsv).filter((p) => KNOWN_PURPOSES.has(p));

    const filters = [];
    filters.push(
      trash ? isNotNull(shipments.pendingDeletionAt) : isNull(shipments.pendingDeletionAt),
    );
    if (status) {
      const statusId = await resolveStatusId(app, status);
      filters.push(eq(shipments.statusId, statusId));
    }
    if (noDocument !== undefined) {
      filters.push(
        noDocument
          ? drSql`not exists (select 1 from shipment_sources ss where ss.shipment_id = ${shipments.id})`
          : drSql`exists (select 1 from shipment_sources ss where ss.shipment_id = ${shipments.id})`,
      );
    }
    if (kind) filters.push(eq(shipments.kind, kind));
    // Фильтр по отметке проверки. none — не проверено (NULL).
    // Фильтр по отметке проверки — только тем, кому отметка вообще видна.
    // Селект скрыт правом матрицы, но ?review= из чужой ссылки исполнялся и без
    // права: человек получал урезанный список без единого признака фильтра.
    if (reviewState && (await canSeeReviewInMatrix(app, user?.role, 'operations.shipments'))) {
      filters.push(
        reviewState === 'none'
          ? isNull(shipments.reviewState)
          : eq(shipments.reviewState, reviewState),
      );
    }
    // inspector_kpp видит отгрузки своего объекта-источника (включая чужие).
    // Без назначенного объекта — пустой результат. Для admin/manager
    // siteId из query — обычный опциональный фильтр.
    if (user?.role === 'inspector_kpp') {
      if (!user.siteId) {
        filters.push(drSql`false`);
      } else {
        filters.push(eq(shipments.siteId, user.siteId));
      }
    } else if (user?.role === 'contractor') {
      // contractor видит отгрузки, где он — получатель (receiver_counterparty_id),
      // по всем объектам, независимо от kind. Наследования от УПД нет (как и у
      // UI-фильтра). Без назначенного подрядчика / без совпадений — пусто.
      const opIds = await resolveContractorOpIds(app, user);
      if (!opIds || opIds.length === 0) {
        filters.push(drSql`false`);
      } else {
        filters.push(inArray(shipments.receiverCounterpartyId, opIds));
      }
    } else {
      if (siteId) filters.push(eq(shipments.siteId, siteId));
      if (inspectorId) filters.push(eq(shipments.inspectorId, inspectorId));
    }
    if (!status && user?.role !== 'inspector_kpp' && user) {
      const draftId = await resolveStatusId(app, 'draft');
      filters.push(or(ne(shipments.statusId, draftId), eq(shipments.inspectorId, user.id))!);
    }
    if (changedSince) filters.push(gte(shipments.updatedAt, new Date(changedSince)));

    // ─── server-side фильтры из /operations?type=shipment&tab=accepted ─
    // Логика 1-в-1 с клиентом ShipmentsHistory.tsx → filteredItems. См.
    // там же комментарии. ВАЖНО: в shipments FK подрядчика — это
    // receiver_counterparty_id (а не contractor_id как в deliveries),
    // здесь inheritance из source_document НЕ применяется (на клиенте
    // тоже без inheritance).

    // siteIds (multi-select)
    if (siteIdsArr.length > 0) {
      filters.push(inArray(shipments.siteId, siteIdsArr));
    }

    // contractorIds: directory ID → operational ID через ИНН-маппинг.
    // Подрядчик в shipments — это получатель (receiver_counterparty_id).
    if (contractorDirIds.length > 0) {
      const opIds = await expandCustomerCounterpartyToOpIds(app, contractorDirIds);
      if (opIds.length === 0) {
        filters.push(drSql`false`);
      } else {
        filters.push(inArray(shipments.receiverCounterpartyId, opIds));
      }
    }

    // supplierIds: directory ID → operational ID через справочник suppliers.
    if (supplierDirIds.length > 0) {
      const opIds = await expandSupplierToOpIds(app, supplierDirIds);
      if (opIds.length === 0) {
        filters.push(drSql`false`);
      } else {
        filters.push(inArray(shipments.supplierId, opIds));
      }
    }

    // q: поиск по номеру привязанного source_document.
    if (q?.trim()) {
      // escapeLike: «100%» ищется как «100%», а не как «100<что угодно>».
      const needle = `%${escapeLike(q.trim())}%`;
      filters.push(drSql`EXISTS (
      SELECT 1 FROM shipment_sources ss_q
      JOIN source_documents sd_q ON sd_q.id = ss_q.source_document_id
      WHERE ss_q.shipment_id = ${shipments.id}
        AND sd_q.doc_number ILIKE ${needle}
    )`);
    }

    // displayId: точное совпадение по короткому id (уникальный индекс
    // shipments_display_id_uidx) — симметрично deliveries.ts.
    if (displayId !== undefined) {
      filters.push(eq(shipments.displayId, displayId));
    }

    // plate: ILIKE на госномер.
    if (plate?.trim()) {
      filters.push(ilike(shipments.vehiclePlate, `%${escapeLike(plate.trim())}%`));
    }

    // purposes: OR между выбранными (легаси отгрузки без purpose не
    // попадают ни в один выбранный тип — это совпадает с клиентским
    // поведением «purpose=null → не отображается под фильтром»).
    if (purposesArr.length > 0) {
      filters.push(inArray(shipments.purpose, purposesArr));
    }

    // features (AND):
    //   transit → in_transit = true
    //   assets  → is_assets = true OR EXISTS shipment_items.item_kind='asset'
    //   upd     → EXISTS source_document.kind='upd'
    //   waybill → EXISTS source_document.kind IN ('transport_waybill','os2_transfer')
    for (const f of featureCodes) {
      if (f === 'transit') {
        filters.push(eq(shipments.inTransit, true));
      } else if (f === 'assets') {
        filters.push(drSql`(
        ${shipments.isAssets} = true
        OR EXISTS (
          SELECT 1 FROM shipment_items si_a
          WHERE si_a.shipment_id = ${shipments.id} AND si_a.item_kind = 'asset'
        )
      )`);
      } else if (f === 'upd') {
        filters.push(drSql`EXISTS (
        SELECT 1 FROM shipment_sources ss_u
        JOIN source_documents sd_u ON sd_u.id = ss_u.source_document_id
        WHERE ss_u.shipment_id = ${shipments.id} AND sd_u.kind = 'upd'
      )`);
      } else if (f === 'doc_attention') {
        // Очередь ручной проверки: документ, у которого разбор нашёл
        // расхождение ИЛИ подозрение.
        //
        // Именно ИЛИ, а не один `hasMismatch`: предупреждения намеренно не
        // входят в него (upd-validation.ts), а мониторинг на бою цитирует
        // ровно их — замечания по приёмкам 13318 и 13322 дословно повторяют
        // текст «в количестве стоит код единицы измерения из бланка».
        //
        // Вторая ветка (по происхождению позиций) нужна, чтобы фильтр совпадал
        // с плашкой: карточка показывает сводку и по отвязанным документам,
        // строки которых остались в операции.
        //
        // OPERATION_DOC_VALIDATION гасит фильтр вместе со сводкой: иначе
        // выключённый рубильник оставил бы пункт меню, который ничего не находит.
        if (loadEnv().OPERATION_DOC_VALIDATION) {
          filters.push(drSql`(
        EXISTS (
          SELECT 1 FROM shipment_sources ds_a
          JOIN source_documents sd_a ON sd_a.id = ds_a.source_document_id
          WHERE ds_a.shipment_id = ${shipments.id}
            AND (
              jsonb_path_exists(sd_a.validation, '$.checks[*] ? (@.ok == false && !exists(@.skipReason))')
              OR jsonb_array_length(COALESCE(sd_a.validation->'warnings', '[]'::jsonb)) > 0
            )
        )
        OR EXISTS (
          SELECT 1 FROM shipment_items di_a2
          JOIN source_documents sd_a2 ON sd_a2.id = di_a2.source_document_id
          WHERE di_a2.shipment_id = ${shipments.id}
            AND (
              jsonb_path_exists(sd_a2.validation, '$.checks[*] ? (@.ok == false && !exists(@.skipReason))')
              OR jsonb_array_length(COALESCE(sd_a2.validation->'warnings', '[]'::jsonb)) > 0
            )
        )
        OR EXISTS (
          -- Третий источник — сверка фото документа, снятого на планшете.
          -- Он не покрывается двумя предыдущими: у 73 приёмок за месяц сигнал
          -- есть ТОЛЬКО здесь, документа к ним не привязано. Мониторинг этой
          -- сводкой уже пользуется — замечания 13318 и 13322 дословно повторяют
          -- её текст, хотя привязанный документ в них чист.
          SELECT 1 FROM shipment_photos p_a
          JOIN photo_recognized_items r_a ON r_a.shipment_photo_id = p_a.id
          WHERE p_a.shipment_id = ${shipments.id}
            AND (
              jsonb_path_exists(r_a.validation, '$.checks[*] ? (@.ok == false && !exists(@.skipReason))')
              OR jsonb_array_length(COALESCE(r_a.validation->'warnings', '[]'::jsonb)) > 0
            )
        )
      )`);
        }
      } else if (f === 'waybill') {
        filters.push(drSql`EXISTS (
        SELECT 1 FROM shipment_sources ss_w
        JOIN source_documents sd_w ON sd_w.id = ss_w.source_document_id
        WHERE ss_w.shipment_id = ${shipments.id}
          AND sd_w.kind IN ('transport_waybill', 'os2_transfer')
      )`);
      }
    }

    // shippedFrom / shippedTo — диапазон даты отправки.
    // Верхняя граница строгая: клиент шлёт начало следующего дня.
    filters.push(
      ...dateRangeConditions(shipments.shippedAt, shippedFrom, shippedTo, {
        fromField: 'shippedFrom',
        toField: 'shippedTo',
      }),
    );

    // nophoto: ни одного ЗАГРУЖЕННОГО фото — см. тот же фильтр в deliveries.ts.
    if (nophoto) {
      filters.push(drSql`NOT EXISTS (
      SELECT 1 FROM shipment_photos sp
       WHERE sp.shipment_id = ${shipments.id} AND sp.uploaded_at IS NOT NULL
    )`);
      if (nophotoOlderHours) {
        filters.push(
          drSql`${shipments.createdAt} < now() - make_interval(hours => ${nophotoOlderHours})`,
        );
      }
    }

    return filters;
  }

  app.get(
    '/api/v1/shipments',
    {
      preHandler: [app.authenticate],
      schema: { querystring: ListQuerySchema, response: { 200: ShipmentListResponseSchema } },
    },
    async (req) => {
      const { limit, offset } = req.query;
      const filters = await buildShipmentFilters(req.user, req.query);
      const where = filters.length ? and(...filters) : undefined;

      const rows = await app.db
        .select({ id: shipments.id })
        .from(shipments)
        .where(where)
        // displayId DESC (не updatedAt) — чтобы отгрузка не «прыгала»
        // наверх списка при редактировании. Симметрично с deliveries.
        .orderBy(desc(shipments.displayId))
        .limit(limit)
        .offset(offset);
      const [{ count } = { count: 0 }] = await app.db
        .select({ count: drSql<number>`count(*)::int` })
        .from(shipments)
        .where(where);

      // Батч вместо Promise.all(buildShipmentDto×N): ~5 запросов на страницу
      // вместо ~4×N (устранение N+1). Порядок страницы — по rows (displayId DESC).
      const items = await buildShipmentDtosBatch(
        app,
        rows.map((r: { id: string }) => r.id),
        req.user?.role,
      );
      return { items, total: count };
    },
  );

  // Подписи видов отгрузки — те же слова, что на портале (KIND_LABELS в
  // ShipmentViewModal.tsx). В выгрузке коды 'contractor'/'writeoff' читались бы
  // хуже, чем «Подрядчику» и «Списание».
  const SHIPMENT_KIND_LABELS: Record<string, string> = {
    contractor: 'Подрядчику',
    return: 'Возврат',
    transfer: 'Перемещение',
    writeoff: 'Списание',
  };

  // Экспорт отгрузок в xlsx — тем же набором фильтров, что и список.
  //
  // Своего экспорта у отгрузок не было вовсе: страница Операций выгружала
  // вместо них ИСХОДЯЩИЕ документы (/source-documents/export.xlsx с
  // direction=outbound), а таких в базе один за всё время — пользователь
  // получал пустой лист с одной шапкой.
  //
  // Строки собираются тем же buildShipmentDtosBatch, что и список: получатель,
  // суммы и позиции резолвятся одним кодом, поэтому Excel не может разойтись
  // с экраном. Пагинации нет — выгружается вся выборка по фильтрам.
  {
    const ExportShipmentsQuerySchema = ListQuerySchema.omit({ limit: true, offset: true });

    app.get(
      '/api/v1/shipments/export.xlsx',
      {
        preHandler: [app.authenticate],
        schema: { querystring: ExportShipmentsQuerySchema },
      },
      async (req, reply) => {
        const filters = await buildShipmentFilters(req.user, req.query);
        const where = filters.length ? and(...filters) : undefined;
        const rows = await app.db
          .select({ id: shipments.id })
          .from(shipments)
          .where(where)
          .orderBy(desc(shipments.displayId));
        const dtos = await buildShipmentDtosBatch(
          app,
          rows.map((r: { id: string }) => r.id),
          req.user?.role,
        );

        const ExcelJS = (await import('exceljs')).default;
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Отгрузки', {
          views: [{ state: 'frozen', ySplit: 1 }],
          properties: { defaultRowHeight: 16 },
        });
        ws.columns = [
          { header: '№', key: 'idx', width: 6 },
          { header: 'id', key: 'displayId', width: 9 },
          { header: 'Статус', key: 'status', width: 16 },
          { header: 'Тип', key: 'kind', width: 14 },
          { header: 'Назначение', key: 'purpose', width: 18 },
          { header: 'Авто', key: 'vehiclePlate', width: 12 },
          { header: 'Отгрузка', key: 'shippedAt', width: 18 },
          { header: 'Получатель', key: 'receiverName', width: 28 },
          { header: 'Объект', key: 'siteName', width: 24 },
          { header: 'Фото', key: 'photos', width: 8 },
          { header: 'Наименование', key: 'nameRaw', width: 40 },
          { header: 'План', key: 'qtyPlanned', width: 9 },
          { header: 'Факт', key: 'qtyActual', width: 9 },
          { header: 'Ед.', key: 'unit', width: 7 },
          { header: 'Цена', key: 'price', width: 12 },
          { header: 'Сумма НДС', key: 'vatSum', width: 14 },
          { header: 'Сумма', key: 'sum', width: 16 },
        ];
        const headerRow = ws.getRow(1);
        headerRow.font = { bold: true };
        headerRow.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
        headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEDED' } };

        let idx = 0;
        for (const dto of dtos) {
          idx++;
          const docRow = ws.addRow({
            idx,
            displayId: dto.displayId,
            status: dto.status?.label ?? '',
            kind: SHIPMENT_KIND_LABELS[dto.kind] ?? dto.kind,
            purpose: dto.purpose ?? '',
            vehiclePlate: dto.vehiclePlate ?? '',
            shippedAt: fmtDateTimeRu(dto.shippedAt),
            receiverName: dto.receiverName ?? '',
            siteName: dto.siteName ?? '',
            photos: dto.photos.length,
            nameRaw: '',
            qtyPlanned: null,
            qtyActual: null,
            unit: '',
            price: null,
            // Итоги считает тот же код, что отдаёт их списку, — расхождения
            // между строкой Excel и карточкой на портале быть не может.
            vatSum: dto.itemsVatSum ?? null,
            sum: dto.itemsTotal ?? null,
          });
          docRow.font = { bold: true };
          docRow.getCell('vatSum').numFmt = MONEY_FMT;
          docRow.getCell('sum').numFmt = MONEY_FMT;
          docRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F7F7' } };

          for (const it of dto.items) {
            const qtyP = numOrNull(it.qtyPlanned);
            const qtyA = numOrNull(it.qtyActual);
            const price = numOrNull(it.price);
            const qtyForRowTotal = qtyA ?? qtyP;
            const rowSum = qtyForRowTotal != null && price != null ? qtyForRowTotal * price : null;
            const itemRow = ws.addRow({
              idx: it.lineNo,
              displayId: null,
              status: '',
              kind: '',
              purpose: '',
              vehiclePlate: '',
              shippedAt: '',
              receiverName: '',
              siteName: '',
              photos: null,
              nameRaw: it.nameRaw,
              qtyPlanned: qtyP,
              qtyActual: qtyA,
              unit: it.unit,
              price,
              vatSum: numOrNull(it.vatSum),
              sum: rowSum,
            });
            itemRow.outlineLevel = 1;
            itemRow.getCell('qtyPlanned').numFmt = QTY_FMT;
            itemRow.getCell('qtyActual').numFmt = QTY_FMT;
            itemRow.getCell('price').numFmt = MONEY_FMT;
            itemRow.getCell('vatSum').numFmt = MONEY_FMT;
            itemRow.getCell('sum').numFmt = MONEY_FMT;
          }
        }
        ws.properties.outlineLevelRow = 1;

        const buf = await wb.xlsx.writeBuffer();
        const today = new Date().toISOString().slice(0, 10);
        const filename = `shipments-${today}.xlsx`;
        return reply
          .header(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          )
          .header('Content-Disposition', `attachment; filename="${filename}"`)
          .send(Buffer.from(buf));
      },
    );
  }

  app.get(
    '/api/v1/shipments/:id',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: ShipmentSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const dto = await buildShipmentDto(app, req.params.id, req.user?.role);
      if (!dto) return reply.code(404).send({ error: 'not_found' });
      // inspector_kpp видит только отгрузки своего объекта-источника.
      if (
        req.user?.role === 'inspector_kpp' &&
        (!req.user.siteId || dto.siteId !== req.user.siteId)
      ) {
        return reply.code(404).send({ error: 'not_found' });
      }
      // contractor видит только отгрузки, где он получатель. DTO уже содержит
      // receiverCounterpartyId, поэтому проверяем без доп. запроса.
      if (req.user?.role === 'contractor') {
        const opIds = await resolveContractorOpIds(app, req.user);
        if (!opIds || !dto.receiverCounterpartyId || !opIds.includes(dto.receiverCounterpartyId)) {
          return reply.code(404).send({ error: 'not_found' });
        }
      }
      return dto;
    },
  );

  // Отметка проверки качества (роль «Мониторинг») — зеркало /deliveries/:id/review.
  // Меняет ТОЛЬКО review_*, не трогая items/photos/status/version/updated_at (не
  // задевает guard, OCC и мобильный sync). Ставить/менять могут admin/manager/monitor.
  app.patch(
    '/api/v1/shipments/:id/review',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager', 'monitor')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: ReviewRequestSchema,
        response: {
          200: ShipmentSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          422: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [s] = await app.db
        .select({
          id: shipments.id,
          statusId: shipments.statusId,
          pendingDeletionAt: shipments.pendingDeletionAt,
          // Объект нужен SSE-событию ниже: /events отдаёт инспектору только
          // события его объекта (см. shouldDeliverSseEvent).
          siteId: shipments.siteId,
        })
        .from(shipments)
        .where(eq(shipments.id, req.params.id))
        .limit(1);
      if (!s) return reply.code(404).send({ error: 'not_found' });
      if (s.pendingDeletionAt !== null) {
        return reply.code(409).send({
          error: 'pending_deletion',
          message: 'Документ помечен на удаление — проверка недоступна',
        });
      }
      // Гейт зрелости: проверять можно только оформленные отгрузки
      // (shipped / confirmed_mol).
      const code = await getStatusCodeById(app, s.statusId);
      if (code !== 'shipped' && code !== 'confirmed_mol') {
        return reply.code(422).send({
          error: 'not_reviewable',
          message: 'Отгрузка ещё не оформлена — проверка недоступна',
        });
      }
      const note =
        req.body.note != null && req.body.note.trim().length > 0 ? req.body.note.trim() : null;
      await app.db
        .update(shipments)
        .set({
          reviewState: req.body.state,
          reviewNote: note,
          reviewedByUserId: req.user?.id ?? null,
          reviewedAt: new Date(),
        })
        .where(eq(shipments.id, s.id));
      publishEvent(app, {
        type: 'shipment_updated',
        entityId: s.id,
        siteId: s.siteId,
        ts: new Date().toISOString(),
      });
      const dto = await buildShipmentDto(app, s.id, req.user?.role);
      if (!dto) return reply.code(404).send({ error: 'not_found' });
      return dto;
    },
  );

  app.post(
    '/api/v1/shipments',
    {
      // contractor/monitor — read-only роли: upsert им недоступен. Раньше здесь
      // был только authenticate, и запись формально проходила по любой роли.
      preHandler: [app.authenticate, app.authorize('admin', 'manager', 'inspector_kpp')],
      schema: {
        body: ShipmentUpsertSchema,
        response: {
          200: ShipmentSchema,
          400: ErrorResponseSchema,
          // 403 — foreign_site: инспектор пытается изменить отгрузку чужого
          // объекта (см. domain/operations/foreign-site.ts).
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          // 409 — либо OCC-конфликт (Conflict), либо pending_deletion (Error).
          409: z.union([ShipmentConflictResponseSchema, ErrorResponseSchema]),
          // 422 — receiver_required (документ не дозаполнен), отдельно от
          // 400, чтобы mobile-MutationProcessor мог различать «дозаполните
          // данные» от «клиент послал мусор» (без ретраев).
          422: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const input = req.body;
      const inspectorId = req.user?.role === 'inspector_kpp' ? req.user.id : (req.user?.id ?? null);

      // inspector_kpp работает строго в рамках своего объекта-источника.
      // Раньше здесь была тихая подмена input.siteId — см. комментарий в
      // deliveries.ts: офлайн-отгрузка объекта A после перевода инспектора на B
      // молча создавалась на B. Теперь несовпадение — 403, а не переклейка.
      // Проверка стоит ДО validateKindLinks: тот читает siteId и без сверки
      // валидировал бы transfer по «чужому» объекту.
      if (req.user?.role === 'inspector_kpp') {
        if (!req.user.siteId) {
          return reply.code(400).send({
            error: 'no_site_assigned',
            message: 'Объект не назначен — обратитесь к администратору',
          });
        }
        if (input.siteId !== req.user.siteId) {
          return reply.code(403).send(FOREIGN_SITE_RESPONSE);
        }
      }

      // Статус процесса и наличие УПД — независимые измерения.
      // См. комментарий в /api/v1/deliveries.
      const statusId = await resolveStatusId(app, input.statusCode);

      // Дополнительная валидация согласованности kind ↔ receiver/destSite,
      // BD-CHECK даст более грубое сообщение — отдадим клиенту что-то понятное.
      // receiver_required → 422 (документ не дозаполнен, mobile показывает
      // понятный текст и НЕ ретраит). invalid_kind_links → 400 (клиент послал
      // несовместимые поля). Разделение нужно mobile-MutationProcessor'у.
      const linksError = validateKindLinks(input);
      if (linksError) {
        const statusCode = linksError.code === 'receiver_required' ? 422 : 400;
        return reply.code(statusCode).send({ error: linksError.code, message: linksError.message });
      }

      try {
        if (input.id) {
          const [existing] = await app.db
            .select()
            .from(shipments)
            .where(eq(shipments.id, input.id))
            .limit(1);
          if (!existing) {
            // Ветка СОЗДАНИЯ, хотя клиент прислал id: офлайн-запись с планшета
            // приходит с уже сгенерированным UUID, поэтому create/edit решает
            // наличие строки в БД, а не наличие input.id.
            await assertPermission(req, 'operations.shipments', 'create');
            await createShipment(app, input, statusId, inspectorId, req.user?.sessionId ?? null);
          } else {
            await assertPermission(req, 'operations.shipments', 'edit');
            // Инспектор редактирует только записи СВОЕГО объекта. Раньше проверки
            // не было, и upsert чужой отгрузки молча переносил её на объект
            // отправителя (см. domain/operations/foreign-site.ts).
            if (req.user?.role === 'inspector_kpp') {
              if (existing.siteId !== req.user.siteId) {
                return reply.code(403).send(FOREIGN_SITE_RESPONSE);
              }
              // Объект-источник существующей отгрузки для инспектора фиксирован.
              input.siteId = existing.siteId;
            }
            // Помеченные документы — read-only до восстановления или окончательного удаления.
            if (existing.pendingDeletionAt !== null) {
              return reply.code(409).send({
                error: 'pending_deletion',
                message: 'Документ помечен на удаление — сначала снимите пометку',
              });
            }
            if (input.baseVersion !== undefined && input.baseVersion !== existing.version) {
              const server = await buildShipmentDto(app, existing.id, req.user?.role);
              return reply.code(409).send({
                error: 'conflict' as const,
                serverVersion: existing.version,
                server: server!,
              });
            }
            await updateShipment(
              app,
              existing,
              input,
              statusId,
              req.user?.id ?? null,
              // Для инспектора апдейт идёт с условием по объекту — чтобы между
              // чтением existing и UPDATE менеджер не успел перенести запись.
              req.user?.role === 'inspector_kpp' ? existing.siteId : null,
            );
          }
          if (input.kind === 'transfer') {
            await syncPairedTransferDelivery(app, input.id);
          }
          const dto = await buildShipmentDto(app, input.id, req.user?.role);
          if (!dto) return reply.code(404).send({ error: 'not_found' });
          publishEvent(app, {
            type: 'shipment_updated',
            entityId: dto.id,
            siteId: dto.siteId,
            ts: new Date().toISOString(),
          });
          return dto;
        }

        await assertPermission(req, 'operations.shipments', 'create');
        const created = await createShipment(
          app,
          input,
          statusId,
          inspectorId,
          req.user?.sessionId ?? null,
        );
        if (input.kind === 'transfer') {
          await syncPairedTransferDelivery(app, created.id);
        }
        const dto = await buildShipmentDto(app, created.id, req.user?.role);
        if (!dto) throw new Error('Shipment missing after create');
        publishEvent(app, {
          type: 'shipment_updated',
          entityId: dto.id,
          siteId: dto.siteId,
          ts: new Date().toISOString(),
        });
        return dto;
      } catch (err) {
        if (err instanceof SourceAlreadyLinkedError) {
          return reply.code(400).send({
            error: 'source_document_already_linked',
            message: 'УПД уже привязана к другой отгрузке',
            details: { sourceDocumentIds: err.sourceDocumentIds },
          });
        }
        if (err instanceof TechnicalSourceDocumentError) {
          return reply.code(404).send({
            error: 'source_document_not_found',
            message: 'УПД не найдена',
          });
        }
        if (err instanceof ForeignSiteSourceDocumentError) {
          return reply.code(409).send({
            error: 'source_document_foreign_site',
            message: 'УПД относится к другому объекту — обновите список документов',
            details: { sourceDocumentIds: err.sourceDocumentIds },
          });
        }
        // Объект записи сменился между проверкой и UPDATE — транзакция откатана.
        if (err instanceof ForeignSiteError) {
          return reply.code(403).send(FOREIGN_SITE_RESPONSE);
        }
        throw err;
      }
    },
  );

  app.delete(
    '/api/v1/shipments/:id',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: z.object({ ok: z.literal(true) }),
          404: ErrorResponseSchema,
          403: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [existing] = await app.db
        .select()
        .from(shipments)
        .where(eq(shipments.id, req.params.id))
        .limit(1);
      if (!existing) return reply.code(404).send({ error: 'not_found' });

      const role = req.user?.role;
      const isPending = existing.pendingDeletionAt !== null;

      if (isPending) {
        // Окончательное удаление помеченного документа — только админ.
        if (role !== 'admin') {
          return reply.code(403).send({ error: 'forbidden' });
        }
      } else {
        const code = (await getStatusCodeById(app, existing.statusId)) ?? '';
        if (!SHIPMENT_HARD_DELETE_STATUSES.has(code)) {
          return reply.code(409).send({
            error: 'must_mark_first',
            message: 'Сначала пометьте документ на удаление',
          });
        }
        // См. зеркальный комментарий в deliveries.ts: имя роли здесь больше не
        // решает, ограничение инспектора по объекту — бизнес-скоуп.
        if (role === 'inspector_kpp') {
          if (!req.user?.siteId || existing.siteId !== req.user.siteId) {
            return reply.code(403).send({ error: 'forbidden' });
          }
        }
        await assertPermission(req, 'operations.shipments', 'delete');
      }

      if (isPending) {
        req.log.info(
          {
            event: 'shipment_hard_deleted',
            shipmentId: existing.id,
            deletedByUserId: req.user?.id ?? null,
            originallyMarkedBy: existing.pendingDeletionByUserId,
            markedAt: existing.pendingDeletionAt?.toISOString() ?? null,
          },
          'shipment hard delete after soft-delete mark',
        );
      }

      // Удаление одной транзакцией + гарантированная дочистка S3 через outbox
      // (симметрично deliveries — см. подробный комментарий там). FOR UPDATE на
      // строке отгрузки блокирует конкурентную загрузку фото → между чтением
      // ключей и cascade-delete новое фото не проскользнёт; S3-ключи в outbox
      // чистит воркер; touch — в той же транзакции.
      await app.db.transaction(async (tx) => {
        const locked = await tx
          .select({ id: shipments.id })
          .from(shipments)
          .where(eq(shipments.id, req.params.id))
          .for('update')
          .limit(1);
        if (locked.length === 0) return; // удалена конкурентно — no-op

        const photos = await tx
          .select({ s3Key: shipmentPhotos.s3Key, thumbS3Key: shipmentPhotos.thumbS3Key })
          .from(shipmentPhotos)
          .where(eq(shipmentPhotos.shipmentId, req.params.id));
        const keySet = new Set<string>();
        for (const p of photos) {
          if (p.s3Key) keySet.add(p.s3Key);
          if (p.thumbS3Key) keySet.add(p.thumbS3Key);
        }

        const attachedSdIds = (
          await tx
            .select({ sourceDocumentId: shipmentSources.sourceDocumentId })
            .from(shipmentSources)
            .where(eq(shipmentSources.shipmentId, req.params.id))
        ).map((r: { sourceDocumentId: string }) => r.sourceDocumentId);

        await tx.insert(entityDeletions).values({
          entityType: 'shipment',
          entityId: existing.id,
          siteId: existing.siteId,
          deletedByUserId: req.user?.id ?? null,
        });
        if (keySet.size > 0) {
          await tx.insert(s3CleanupOutbox).values(
            Array.from(keySet, (s3Key) => ({
              s3Key,
              entityType: 'shipment',
              entityId: existing.id,
            })),
          );
        }
        await touchSourceDocuments({ db: tx }, attachedSdIds);
        await tx.delete(shipments).where(eq(shipments.id, req.params.id));
      });
      publishEvent(app, {
        type: 'shipment_deleted',
        entityId: req.params.id,
        siteId: existing.siteId,
        ts: new Date().toISOString(),
      });
      return { ok: true as const };
    },
  );

  // Soft-delete: пометить отгрузку на удаление.
  app.post(
    '/api/v1/shipments/:id/mark-deletion',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: ShipmentMarkDeletionSchema,
        response: {
          200: ShipmentSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [existing] = await app.db
        .select()
        .from(shipments)
        .where(eq(shipments.id, req.params.id))
        .limit(1);
      if (!existing) return reply.code(404).send({ error: 'not_found' });

      const role = req.user?.role;
      // Видимость — до прав и через 404: код ответа не должен выдавать
      // существование чужой записи.
      if (role === 'inspector_kpp') {
        if (!req.user?.siteId || existing.siteId !== req.user.siteId) {
          return reply.code(404).send({ error: 'not_found' });
        }
      }
      await assertPermission(req, 'operations.shipments', 'delete');

      if (existing.pendingDeletionAt !== null) {
        return reply.code(409).send({
          error: 'already_pending',
          message: 'Документ уже помечен на удаление',
        });
      }

      const code = (await getStatusCodeById(app, existing.statusId)) ?? '';
      if (!SHIPMENT_SOFT_DELETE_STATUSES.has(code)) {
        return reply.code(400).send({
          error: 'cannot_mark_status',
          message:
            'Пометка на удаление возможна только для статусов «Оформлена» и «Подтверждено МОЛ»',
        });
      }

      await app.db
        .update(shipments)
        .set({
          pendingDeletionAt: new Date(),
          pendingDeletionByUserId: req.user?.id ?? null,
          pendingDeletionReason: req.body.reason ?? null,
          version: drSql`${shipments.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(shipments.id, existing.id));
      const dto = await buildShipmentDto(app, existing.id, req.user?.role);
      if (!dto) return reply.code(404).send({ error: 'not_found' });
      publishEvent(app, {
        type: 'shipment_updated',
        entityId: dto.id,
        siteId: dto.siteId,
        ts: new Date().toISOString(),
      });
      return dto;
    },
  );

  // Soft-delete: снять пометку об удалении (восстановить).
  app.post(
    '/api/v1/shipments/:id/unmark-deletion',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: ShipmentSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [existing] = await app.db
        .select()
        .from(shipments)
        .where(eq(shipments.id, req.params.id))
        .limit(1);
      if (!existing) return reply.code(404).send({ error: 'not_found' });

      const role = req.user?.role;
      const isAuthor =
        existing.pendingDeletionByUserId !== null &&
        existing.pendingDeletionByUserId === req.user?.id;
      if (!isAuthor && role !== 'admin') {
        return reply.code(403).send({ error: 'forbidden' });
      }
      if (role === 'inspector_kpp') {
        if (!req.user?.siteId || existing.siteId !== req.user.siteId) {
          return reply.code(404).send({ error: 'not_found' });
        }
      }
      // «Автор или админ» выше — про то, чью пометку можно снять; матрица —
      // про право удаления как таковое. Снятая галочка останавливает и автора.
      await assertPermission(req, 'operations.shipments', 'delete');

      if (existing.pendingDeletionAt === null) {
        return reply.code(409).send({
          error: 'not_pending',
          message: 'Документ не помечен на удаление',
        });
      }

      await app.db
        .update(shipments)
        .set({
          pendingDeletionAt: null,
          pendingDeletionByUserId: null,
          pendingDeletionReason: null,
          version: drSql`${shipments.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(shipments.id, existing.id));
      const dto = await buildShipmentDto(app, existing.id, req.user?.role);
      if (!dto) return reply.code(404).send({ error: 'not_found' });
      publishEvent(app, {
        type: 'shipment_updated',
        entityId: dto.id,
        siteId: dto.siteId,
        ts: new Date().toISOString(),
      });
      return dto;
    },
  );

  // ──────────── Bulk: пометить N отгрузок на удаление ────────────
  // Симметрично deliveries.bulk-mark-deletion: те же правила (видимость
  // inspector_kpp, проверка статуса, already_pending), best-effort.
  app.post(
    '/api/v1/shipments/bulk-mark-deletion',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        body: BulkDeleteRequestSchema,
        response: { 200: BulkDeleteResponseSchema },
      },
    },
    async (req) => {
      const ids = req.body.ids;
      const deleted: string[] = [];
      const skipped: Array<{
        id: string;
        reason: 'not_found' | 'already_pending' | 'wrong_status' | 'forbidden' | 'internal_error';
      }> = [];

      for (const id of ids) {
        try {
          const [existing] = await app.db
            .select()
            .from(shipments)
            .where(eq(shipments.id, id))
            .limit(1);
          if (!existing) {
            skipped.push({ id, reason: 'not_found' });
            continue;
          }
          if (req.user?.role === 'inspector_kpp') {
            if (!req.user.siteId || existing.siteId !== req.user.siteId) {
              skipped.push({ id, reason: 'not_found' });
              continue;
            }
          }
          if (existing.pendingDeletionAt !== null) {
            skipped.push({ id, reason: 'already_pending' });
            continue;
          }
          const code = (await getStatusCodeById(app, existing.statusId)) ?? '';
          if (!SHIPMENT_SOFT_DELETE_STATUSES.has(code)) {
            skipped.push({ id, reason: 'wrong_status' });
            continue;
          }
          await app.db
            .update(shipments)
            .set({
              pendingDeletionAt: new Date(),
              pendingDeletionByUserId: req.user?.id ?? null,
              pendingDeletionReason: null,
              version: drSql`${shipments.version} + 1`,
              updatedAt: new Date(),
            })
            .where(eq(shipments.id, id));
          publishEvent(app, {
            type: 'shipment_updated',
            entityId: id,
            siteId: existing.siteId,
            ts: new Date().toISOString(),
          });
          deleted.push(id);
        } catch (err) {
          req.log.error({ err, id }, 'bulk-mark-deletion: failed (shipment)');
          skipped.push({ id, reason: 'internal_error' });
        }
      }
      return { deleted, skipped };
    },
  );

  // ──────────── Bulk: восстановить N отгрузок ────────────
  app.post(
    '/api/v1/shipments/bulk-unmark-deletion',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        body: BulkDeleteRequestSchema,
        response: { 200: BulkDeleteResponseSchema },
      },
    },
    async (req) => {
      const ids = req.body.ids;
      const deleted: string[] = [];
      const skipped: Array<{
        id: string;
        reason: 'not_found' | 'not_pending' | 'forbidden' | 'internal_error';
      }> = [];

      for (const id of ids) {
        try {
          const [existing] = await app.db
            .select()
            .from(shipments)
            .where(eq(shipments.id, id))
            .limit(1);
          if (!existing) {
            skipped.push({ id, reason: 'not_found' });
            continue;
          }
          const isAuthor =
            existing.pendingDeletionByUserId !== null &&
            existing.pendingDeletionByUserId === req.user?.id;
          if (!isAuthor && req.user?.role !== 'admin') {
            skipped.push({ id, reason: 'forbidden' });
            continue;
          }
          if (req.user?.role === 'inspector_kpp') {
            if (!req.user.siteId || existing.siteId !== req.user.siteId) {
              skipped.push({ id, reason: 'not_found' });
              continue;
            }
          }
          if (existing.pendingDeletionAt === null) {
            skipped.push({ id, reason: 'not_pending' });
            continue;
          }
          await app.db
            .update(shipments)
            .set({
              pendingDeletionAt: null,
              pendingDeletionByUserId: null,
              pendingDeletionReason: null,
              version: drSql`${shipments.version} + 1`,
              updatedAt: new Date(),
            })
            .where(eq(shipments.id, id));
          publishEvent(app, {
            type: 'shipment_updated',
            entityId: id,
            siteId: existing.siteId,
            ts: new Date().toISOString(),
          });
          deleted.push(id);
        } catch (err) {
          req.log.error({ err, id }, 'bulk-unmark-deletion: failed (shipment)');
          skipped.push({ id, reason: 'internal_error' });
        }
      }
      return { deleted, skipped };
    },
  );

  // ──────────── Bulk: удалить N отгрузок навсегда (admin) ────────────
  app.post(
    '/api/v1/shipments/bulk-hard-delete',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        body: BulkDeleteRequestSchema,
        response: { 200: BulkDeleteResponseSchema },
      },
    },
    async (req) => {
      const ids = req.body.ids;
      const deleted: string[] = [];
      const skipped: Array<{
        id: string;
        reason: 'not_found' | 'must_mark_first' | 'forbidden' | 'internal_error';
      }> = [];

      for (const id of ids) {
        try {
          const [existing] = await app.db
            .select()
            .from(shipments)
            .where(eq(shipments.id, id))
            .limit(1);
          if (!existing) {
            skipped.push({ id, reason: 'not_found' });
            continue;
          }
          const isPending = existing.pendingDeletionAt !== null;
          if (!isPending) {
            const code = (await getStatusCodeById(app, existing.statusId)) ?? '';
            if (!SHIPMENT_HARD_DELETE_STATUSES.has(code)) {
              skipped.push({ id, reason: 'must_mark_first' });
              continue;
            }
          }
          // Удаление одной транзакцией + дочистка S3 через outbox (Волна 1D):
          // FOR UPDATE блокирует конкурентную загрузку фото, S3-ключи собираются
          // под блокировкой и пишутся в s3_cleanup_outbox, touch — в той же
          // транзакции. Синхронного S3 нет.
          const done = await app.db.transaction(async (tx) => {
            const locked = await tx
              .select({ id: shipments.id })
              .from(shipments)
              .where(eq(shipments.id, id))
              .for('update')
              .limit(1);
            if (locked.length === 0) return false; // удалена конкурентно

            const photos = await tx
              .select({ s3Key: shipmentPhotos.s3Key, thumbS3Key: shipmentPhotos.thumbS3Key })
              .from(shipmentPhotos)
              .where(eq(shipmentPhotos.shipmentId, id));
            const keySet = new Set<string>();
            for (const p of photos) {
              if (p.s3Key) keySet.add(p.s3Key);
              if (p.thumbS3Key) keySet.add(p.thumbS3Key);
            }
            const attachedSdIds = (
              await tx
                .select({ sourceDocumentId: shipmentSources.sourceDocumentId })
                .from(shipmentSources)
                .where(eq(shipmentSources.shipmentId, id))
            ).map((r: { sourceDocumentId: string }) => r.sourceDocumentId);

            await tx.insert(entityDeletions).values({
              entityType: 'shipment',
              entityId: id,
              siteId: existing.siteId,
              deletedByUserId: req.user?.id ?? null,
            });
            if (keySet.size > 0) {
              await tx
                .insert(s3CleanupOutbox)
                .values(
                  Array.from(keySet, (s3Key) => ({ s3Key, entityType: 'shipment', entityId: id })),
                );
            }
            await touchSourceDocuments({ db: tx }, attachedSdIds);
            await tx.delete(shipments).where(eq(shipments.id, id));
            return true;
          });
          if (!done) {
            skipped.push({ id, reason: 'not_found' });
            continue;
          }
          publishEvent(app, {
            type: 'shipment_deleted',
            entityId: id,
            siteId: existing.siteId,
            ts: new Date().toISOString(),
          });
          deleted.push(id);
        } catch (err) {
          req.log.error({ err, id }, 'bulk-hard-delete: failed (shipment)');
          skipped.push({ id, reason: 'internal_error' });
        }
      }
      return { deleted, skipped };
    },
  );

  // Симметрично deliveries: ручной выбор поставщика отгрузки из
  // Справочника → Поставщики (suppliers). При привязанной УПД ручка
  // отказывает — имя поставщика идёт из УПД. Бэк upsert-ом ищет/создаёт
  // counterparty по ИНН и пишет в shipments.supplier_id.
  app.patch(
    '/api/v1/shipments/:id/supplier-from-directory',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          supplierDirectoryId: z.string().uuid().nullable(),
        }),
        response: {
          200: ShipmentSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [s] = await app.db
        .select({
          id: shipments.id,
          pendingDeletionAt: shipments.pendingDeletionAt,
          // Объект — для скоупа SSE (см. shouldDeliverSseEvent).
          siteId: shipments.siteId,
        })
        .from(shipments)
        .where(eq(shipments.id, req.params.id))
        .limit(1);
      if (!s) return reply.code(404).send({ error: 'not_found' });
      if (s.pendingDeletionAt !== null) {
        return reply.code(409).send({
          error: 'pending_deletion',
          message: 'Документ помечен на удаление — мутации запрещены',
        });
      }

      const linked = await app.db
        .select({ sd: shipmentSources.sourceDocumentId })
        .from(shipmentSources)
        .where(eq(shipmentSources.shipmentId, s.id))
        .limit(1);
      if (linked.length > 0) {
        return reply.code(409).send({
          error: 'upd_takes_priority',
          message: 'У отгрузки привязана УПД — поставщик берётся из неё',
        });
      }

      if (req.body.supplierDirectoryId === null) {
        await app.db
          .update(shipments)
          .set({ supplierId: null, updatedAt: new Date() })
          .where(eq(shipments.id, s.id));
        publishEvent(app, {
          type: 'shipment_updated',
          entityId: s.id,
          siteId: s.siteId,
          ts: new Date().toISOString(),
        });
        const dto = await buildShipmentDto(app, s.id, req.user?.role);
        if (!dto) return reply.code(404).send({ error: 'not_found' });
        return dto;
      }

      const [src] = await app.db
        .select({ inn: suppliers.inn, name: suppliers.name })
        .from(suppliers)
        .where(eq(suppliers.id, req.body.supplierDirectoryId))
        .limit(1);
      if (!src) {
        return reply.code(404).send({
          error: 'supplier_not_found',
          message: 'Поставщик из справочника не найден',
        });
      }
      const innDigits = (src.inn ?? '').replace(/\D+/g, '');
      const nameTrim = src.name.trim();

      let counterpartyId: string | null = null;
      if (innDigits.length > 0) {
        const [existing] = await app.db
          .select({ id: counterparties.id })
          .from(counterparties)
          .where(eq(counterparties.inn, innDigits))
          .limit(1);
        if (existing) counterpartyId = existing.id;
      }
      if (!counterpartyId) {
        const [created] = await app.db
          .insert(counterparties)
          .values({
            inn: innDigits || '0',
            kpp: null,
            name: nameTrim,
            isSupplier: true,
            isCustomer: false,
          })
          .returning({ id: counterparties.id });
        if (!created) {
          return reply.code(404).send({
            error: 'counterparty_create_failed',
            message: 'Не удалось создать запись о поставщике',
          });
        }
        counterpartyId = created.id;
      }

      await app.db
        .update(shipments)
        .set({ supplierId: counterpartyId, updatedAt: new Date() })
        .where(eq(shipments.id, s.id));

      publishEvent(app, {
        type: 'shipment_updated',
        entityId: s.id,
        siteId: s.siteId,
        ts: new Date().toISOString(),
      });

      const dto = await buildShipmentDto(app, s.id, req.user?.role);
      if (!dto) return reply.code(404).send({ error: 'not_found' });
      return dto;
    },
  );

  // PATCH флагов отгрузки (inTransit/isAssets). Симметрично deliveries
  // /flags: менеджер на портале правит чекбоксы, ошибочно проставленные
  // или забытые инспектором на 1 этапе мобилы. Меняет ТОЛЬКО эти два
  // поля и updated_at — items/photos/status/purpose нетронуты.
  app.patch(
    '/api/v1/shipments/:id/flags',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z
          .object({
            inTransit: z.boolean().optional(),
            isAssets: z.boolean().optional(),
          })
          .refine((b) => b.inTransit !== undefined || b.isAssets !== undefined, {
            message: 'Минимум одно из полей (inTransit, isAssets) должно быть задано',
          }),
        response: {
          200: ShipmentSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [s] = await app.db
        .select({
          id: shipments.id,
          pendingDeletionAt: shipments.pendingDeletionAt,
          // Объект — для скоупа SSE (см. shouldDeliverSseEvent).
          siteId: shipments.siteId,
        })
        .from(shipments)
        .where(eq(shipments.id, req.params.id))
        .limit(1);
      if (!s) return reply.code(404).send({ error: 'not_found' });
      if (s.pendingDeletionAt !== null) {
        return reply.code(409).send({
          error: 'pending_deletion',
          message: 'Документ помечен на удаление — мутации запрещены',
        });
      }

      const patch: { inTransit?: boolean; isAssets?: boolean; updatedAt: Date } = {
        updatedAt: new Date(),
      };
      if (req.body.inTransit !== undefined) patch.inTransit = req.body.inTransit;
      if (req.body.isAssets !== undefined) patch.isAssets = req.body.isAssets;

      await app.db.update(shipments).set(patch).where(eq(shipments.id, s.id));

      publishEvent(app, {
        type: 'shipment_updated',
        entityId: s.id,
        siteId: s.siteId,
        ts: new Date().toISOString(),
      });

      const dto = await buildShipmentDto(app, s.id, req.user?.role);
      if (!dto) return reply.code(404).send({ error: 'not_found' });
      return dto;
    },
  );

  // Симметрично POST /api/v1/deliveries/:id/link-source — привязка УПД к
  // существующей отгрузке без destructive replace shipmentItems. Ручные
  // материалы из мобилы остаются, строки из УПД добавляются с дедупом
  // по (nameRaw,unit,qty). Не меняем статус/supplier_id/destSite/прочее.
  // См. подробные комментарии в routes/deliveries.ts /link-source.
  app.post(
    '/api/v1/shipments/:id/link-source',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ sourceDocumentId: z.string().uuid() }),
        response: {
          200: ShipmentSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [s] = await app.db
        .select({
          id: shipments.id,
          siteId: shipments.siteId,
          pendingDeletionAt: shipments.pendingDeletionAt,
        })
        .from(shipments)
        .where(eq(shipments.id, req.params.id))
        .limit(1);
      if (!s) return reply.code(404).send({ error: 'not_found' });
      if (s.pendingDeletionAt !== null) {
        return reply.code(409).send({
          error: 'pending_deletion',
          message: 'Документ помечен на удаление — мутации запрещены',
        });
      }
      const [src] = await app.db
        .select({ id: sourceDocuments.id })
        .from(sourceDocuments)
        .where(
          and(
            eq(sourceDocuments.id, req.body.sourceDocumentId),
            // Служебная запись пакета снаружи не существует — см. deliveries.ts.
            eq(sourceDocuments.isTechnical, false),
          ),
        )
        .limit(1);
      if (!src) {
        return reply.code(404).send({
          error: 'source_document_not_found',
          message: 'УПД не найдена',
        });
      }

      class AlreadyLinkedError extends Error {}

      try {
        await app.db.transaction(
          async (
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            tx: any,
          ) => {
            const [already] = await tx
              .select({ shipmentId: shipmentSources.shipmentId })
              .from(shipmentSources)
              .where(
                and(
                  eq(shipmentSources.shipmentId, s.id),
                  eq(shipmentSources.sourceDocumentId, src.id),
                ),
              )
              .limit(1);
            if (already) throw new AlreadyLinkedError();
            // Симметрично приёмке: блокировка документа и сверка объекта до
            // вставки связи (см. /deliveries/:id/link-source).
            await assertSourcesAvailableForShipment({ db: tx }, [src.id], s.id, s.siteId);
            await tx.insert(shipmentSources).values({ shipmentId: s.id, sourceDocumentId: src.id });

            const existingItems: {
              nameRaw: string;
              unit: string;
              qtyPlanned: string | null;
              lineNo: number;
              sourceDocumentId: string | null;
              sourceDocumentItemId: string | null;
            }[] = await tx
              .select({
                nameRaw: shipmentItems.nameRaw,
                unit: shipmentItems.unit,
                qtyPlanned: shipmentItems.qtyPlanned,
                lineNo: shipmentItems.lineNo,
                sourceDocumentId: shipmentItems.sourceDocumentId,
                sourceDocumentItemId: shipmentItems.sourceDocumentItemId,
              })
              .from(shipmentItems)
              .where(eq(shipmentItems.shipmentId, s.id));

            // Дедупликация — ВНУТРИ документа, как в приёмке (см. одноимённый
            // маршрут в deliveries.ts). Раньше ключ (name, unit, qty) сравнивался
            // со всеми позициями отгрузки сразу, и одинаковая строка из второй
            // УПД молча пропадала: отгрузка занижалась ровно на неё. Основной
            // признак повторной привязки — сохранённое происхождение строки,
            // ключ остаётся запасным (для строк, чей sourceDocumentItemId
            // обнулился переразбором документа).
            const buildKey = (name: string, unit: string, qty: string | null): string =>
              `${name.trim().toLowerCase()}|${unit.trim().toLowerCase()}|${
                qty == null ? '' : Number(qty).toString()
              }`;
            const itemsFromThisDoc = existingItems.filter((i) => i.sourceDocumentId === src.id);
            const existingSourceItemIds = new Set(
              itemsFromThisDoc
                .map((i) => i.sourceDocumentItemId)
                .filter((v): v is string => v !== null),
            );
            const existingKeys = new Set(
              itemsFromThisDoc.map((i) => buildKey(i.nameRaw, i.unit, i.qtyPlanned)),
            );
            const startLineNo =
              existingItems.length === 0 ? 1 : Math.max(...existingItems.map((i) => i.lineNo)) + 1;

            const updRows: (typeof sourceDocumentItems.$inferSelect)[] = await tx
              .select()
              .from(sourceDocumentItems)
              .where(eq(sourceDocumentItems.sourceDocumentId, src.id))
              .orderBy(sourceDocumentItems.lineNo);

            const newRows: (typeof shipmentItems.$inferInsert)[] = [];
            let lineNo = startLineNo;
            for (const r of updRows) {
              if (existingSourceItemIds.has(r.id)) continue;
              if (existingKeys.has(buildKey(r.nameRaw, r.unit, r.qty))) {
                continue;
              }
              newRows.push({
                shipmentId: s.id,
                // Происхождение строки: по нему карточка раскладывает материалы
                // на блоки «Материалы · УПД № …», а upsert переносит атрибуцию
                // через resolveItemOrigins. Приёмка писала его с миграции 0096,
                // отгрузка — нет, и её позиции оставались «без привязки».
                sourceDocumentId: src.id,
                sourceDocumentItemId: r.id,
                itemKind: 'material' as const,
                materialId: r.materialId,
                assetId: null,
                inventoryNumber: null,
                serialNumber: null,
                nameRaw: r.nameRaw,
                qtyPlanned: r.qty,
                qtyActual: null,
                unit: r.unit,
                comment: null,
                lineNo: lineNo++,
                volumeM3: r.volumeM3,
                massKg: r.massKg,
                price: r.price,
                vatRate: r.vatRate,
                vatSum: r.vatSum,
                volumeConfidence: r.volumeConfidence,
                groupName: r.groupName,
              });
            }
            if (newRows.length > 0) {
              await tx.insert(shipmentItems).values(newRows);
            }

            await tx
              .update(shipments)
              .set({
                version: drSql`${shipments.version} + 1`,
                updatedAt: new Date(),
              })
              .where(eq(shipments.id, s.id));
          },
        );
      } catch (err) {
        if (err instanceof ForeignSiteSourceDocumentError) {
          return reply.code(409).send({
            error: 'source_document_foreign_site',
            message: 'УПД относится к другому объекту — обновите список документов',
            details: { sourceDocumentIds: err.sourceDocumentIds },
          });
        }
        if (err instanceof TechnicalSourceDocumentError) {
          return reply.code(404).send({
            error: 'source_document_not_found',
            message: 'УПД не найдена',
          });
        }
        if (err instanceof AlreadyLinkedError) {
          return reply.code(409).send({
            error: 'already_linked',
            message: 'УПД уже привязана к этой отгрузке',
          });
        }
        throw err;
      }

      await touchSourceDocuments(app, [src.id]);
      publishEvent(app, {
        type: 'shipment_updated',
        entityId: s.id,
        siteId: s.siteId,
        ts: new Date().toISOString(),
      });

      const dto = await buildShipmentDto(app, s.id, req.user?.role);
      if (!dto) return reply.code(404).send({ error: 'not_found' });
      return dto;
    },
  );

  // Отвязка документа от отгрузки — парное действие к link-source и зеркало
  // приёмочного маршрута.
  //
  // Понадобилась вместе с правилом «upsert не меняет привязки»: без явной
  // отвязки ошибочную привязку стало бы нечем откатить.
  //
  // Позиции НЕ удаляются и происхождение НЕ обнуляется: строка могла быть уже
  // проверена и исправлена, а знание «откуда она взялась» — данные, а не
  // следствие связи. В карточке такая группа показывается блоком «Материалы ·
  // отвязан УПД № …», а повторная привязка находит свои строки по сохранённому
  // sourceDocumentItemId и не задваивает их.
  app.post(
    '/api/v1/shipments/:id/unlink-source',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ sourceDocumentId: z.string().uuid() }),
        response: {
          200: ShipmentSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [s] = await app.db
        // siteId — для скоупа SSE (см. shouldDeliverSseEvent).
        .select({
          id: shipments.id,
          pendingDeletionAt: shipments.pendingDeletionAt,
          siteId: shipments.siteId,
        })
        .from(shipments)
        .where(eq(shipments.id, req.params.id))
        .limit(1);
      if (!s) return reply.code(404).send({ error: 'not_found' });
      if (s.pendingDeletionAt !== null) {
        return reply.code(409).send({
          error: 'pending_deletion',
          message: 'Документ помечен на удаление — мутации запрещены',
        });
      }

      const removed = await app.db.transaction(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async (tx: any) => {
          const deleted = await tx
            .delete(shipmentSources)
            .where(
              and(
                eq(shipmentSources.shipmentId, s.id),
                eq(shipmentSources.sourceDocumentId, req.body.sourceDocumentId),
              ),
            )
            .returning({ sourceDocumentId: shipmentSources.sourceDocumentId });
          if (deleted.length === 0) return false;

          await tx
            .update(shipments)
            .set({ version: drSql`${shipments.version} + 1`, updatedAt: new Date() })
            .where(eq(shipments.id, s.id));
          return true;
        },
      );

      if (!removed) {
        return reply.code(404).send({
          error: 'not_linked',
          message: 'Этот документ не привязан к отгрузке',
        });
      }

      // Документ снова свободен — мобильный Inbox должен его увидеть.
      await touchSourceDocuments(app, [req.body.sourceDocumentId]);
      publishEvent(app, {
        type: 'shipment_updated',
        entityId: s.id,
        siteId: s.siteId,
        ts: new Date().toISOString(),
      });

      const dto = await buildShipmentDto(app, s.id, req.user?.role);
      if (!dto) return reply.code(404).send({ error: 'not_found' });
      return dto;
    },
  );
}

/**
 * Результат проверки согласованности kind ↔ receiver/destSite.
 * `code='receiver_required'` нужен mobile, чтобы отличить «документ
 * не дозаполнен — попросить менеджера» от «клиент послал мусор».
 * Остальные ошибки — обычные `invalid_kind_links` (400).
 */
type KindLinksError = {
  code: 'receiver_required' | 'invalid_kind_links';
  message: string;
};
function validateKindLinks(input: z.infer<typeof ShipmentUpsertSchema>): KindLinksError | null {
  const { kind, receiverCounterpartyId, receiverMolId, destSiteId, siteId, sourceDocumentIds } =
    input;
  // Получатель указан XOR через counterparty или МОЛ (двух одновременно — нельзя).
  const hasContractorReceiver = Boolean(receiverCounterpartyId);
  const hasMolReceiver = Boolean(receiverMolId);
  const hasAnyReceiver = hasContractorReceiver || hasMolReceiver;
  const hasBothReceivers = hasContractorReceiver && hasMolReceiver;
  const bad = (message: string): KindLinksError => ({ code: 'invalid_kind_links', message });
  const noReceiver = (message: string): KindLinksError => ({
    code: 'receiver_required',
    message,
  });
  // Empty-draft = отгрузка без привязанной УПД (создана инспектором через
  // «Создать отгрузку» на мобиле). У таких отгрузок получатель может быть
  // не указан — менеджер дозaпoлнит на портале. Конфликт с DB-CHECK
  // shipments_kind_links_chk решается тем, что для contractor допускается
  // запись без receiver (CHECK не запрещает оба NULL).
  const isEmptyDraft = !sourceDocumentIds || sourceDocumentIds.length === 0;

  if (kind === 'contractor') {
    if (hasBothReceivers) return bad('Укажите получателя одним способом: подрядчик или МОЛ');
    if (!hasAnyReceiver && !isEmptyDraft) {
      return noReceiver('Для отгрузки нужен получатель (подрядчик или МОЛ)');
    }
    if (destSiteId) return bad('destSiteId допустим только для перемещения');
    return null;
  }
  if (kind === 'return') {
    if (hasMolReceiver) return bad('Возврат поставщику оформляется только на контрагента');
    if (!hasContractorReceiver) return noReceiver('Для возврата нужен получатель-поставщик');
    if (destSiteId) return bad('destSiteId допустим только для перемещения');
    return null;
  }
  if (kind === 'transfer') {
    if (!destSiteId) return bad('Для перемещения нужен объект-получатель');
    if (destSiteId === siteId) return bad('Объект-получатель не может совпадать с источником');
    if (hasBothReceivers) return bad('Укажите получателя одним способом: подрядчик или МОЛ');
    if (!hasAnyReceiver)
      return noReceiver('Для перемещения нужен получатель на новом объекте (подрядчик или МОЛ)');
    return null;
  }
  // writeoff
  if (hasAnyReceiver || destSiteId) return bad('Для списания получатель не указывается');
  return null;
}

async function createShipment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  input: z.infer<typeof ShipmentUpsertSchema>,
  statusId: string,
  inspectorId: string | null,
  /** Устройство, заведшее запись — см. одноимённый параметр createDelivery. */
  createdBySessionId: string | null = null,
) {
  // «Ручной вынос» на мобиле — зеркало «Ручного внеса» для приёмок: инспектор
  // создаёт отгрузку сразу со статусом confirmed_mol (без выбора УПД, минуя
  // 1-2 этап). В этом случае инспектор = подтверждающий МОЛ, заполняем
  // confirmedByMol* при INSERT, чтобы веб-портал показал «Подтверждено МОЛ
  // (<инспектор>)» сразу. Существующий flow (create 'shipped' → update
  // 'confirmed_mol') не затронут — там isFirstConfirm в updateShipment уже
  // выставляет эти поля.
  const isDirectConfirm = input.statusCode === 'confirmed_mol';
  const now = new Date();
  // Время подтверждения — с планшета (момент нажатия «Завершить»), а не время
  // приёма мутации: при офлайне они расходятся на часы. Старые сборки поля не
  // шлют — для них resolveConfirmedAt вернёт `now`, как было раньше.
  const confirmedAtCandidate = isDirectConfirm
    ? resolveConfirmedAt({
        raw: input.confirmedByMolAt,
        lowerBound: input.shippedAt,
        now,
        log: app.log,
        entity: 'shipment',
        id: input.id,
      })
    : null;
  // Атомарность: шапка + позиции + источники + touch УПД — одна транзакция
  // (симметрично createDelivery). Либо всё, либо ничего; контракт не меняется.
  return await app.db.transaction(async (tx: typeof app.db) => {
    const [created] = await tx
      .insert(shipments)
      .values({
        id: input.id,
        statusId,
        kind: input.kind,
        purpose: input.purpose ?? null,
        inTransit: input.inTransit ?? false,
        siteId: input.siteId,
        receiverCounterpartyId: input.receiverCounterpartyId ?? null,
        receiverMolId: input.receiverMolId ?? null,
        destSiteId: input.destSiteId ?? null,
        supplierId: input.supplierId ?? null,
        vehiclePlate: input.vehiclePlate ?? null,
        driverName: input.driverName ?? null,
        shippedAt: input.shippedAt ? new Date(input.shippedAt) : null,
        inspectorId,
        comment: input.comment ?? null,
        isAssets: input.isAssets ?? false,
        ...(isDirectConfirm && {
          confirmedByMolUserId: inspectorId,
          confirmedByMolAt: confirmedAtCandidate,
        }),
        createdBySessionId,
        version: 1,
      })
      .returning();
    if (!created) throw new Error('Failed to insert shipment');
    if (input.items.length) {
      // При СОЗДАНИИ отгрузки происхождение берётся из запроса: строк в БД ещё
      // нет, переносить нечего. Ограничение то же, что и дальше по жизни
      // отгрузки, — документ должен быть в её наборе связей (симметрично
      // createDelivery).
      const linkedOnCreate = new Set(input.sourceDocumentIds);
      await tx.insert(shipmentItems).values(
        input.items.map((i) => ({
          shipmentId: created.id,
          sourceDocumentId:
            i.sourceDocumentId && linkedOnCreate.has(i.sourceDocumentId)
              ? i.sourceDocumentId
              : null,
          sourceDocumentItemId:
            i.sourceDocumentId && linkedOnCreate.has(i.sourceDocumentId)
              ? (i.sourceDocumentItemId ?? null)
              : null,
          itemKind: i.itemKind,
          materialId: i.itemKind === 'asset' ? null : (i.materialId ?? null),
          assetId: i.itemKind === 'asset' ? (i.assetId ?? null) : null,
          inventoryNumber: i.inventoryNumber ?? null,
          serialNumber: i.serialNumber ?? null,
          nameRaw: i.nameRaw,
          qtyPlanned: i.qtyPlanned ?? null,
          qtyActual: i.qtyActual ?? null,
          unit: i.unit,
          comment: i.comment ?? null,
          lineNo: i.lineNo,
          volumeM3: i.volumeM3 ?? null,
          massKg: i.massKg ?? null,
          price: i.price ?? null,
          vatRate: i.vatRate ?? null,
          vatSum: i.vatSum ?? null,
          volumeConfidence: i.volumeConfidence ?? null,
          groupName: i.groupName ?? null,
        })),
      );
    }
    if (input.sourceDocumentIds.length) {
      await assertSourcesAvailableForShipment(
        { db: tx },
        input.sourceDocumentIds,
        created.id,
        input.siteId,
      );
      try {
        await tx.insert(shipmentSources).values(
          input.sourceDocumentIds.map((sid) => ({
            shipmentId: created.id,
            sourceDocumentId: sid,
          })),
        );
      } catch (err) {
        if (isSourceDocumentUniqueViolation(err)) {
          throw new SourceAlreadyLinkedError(input.sourceDocumentIds);
        }
        throw err;
      }
      // Бамп updated_at для привязанных УПД, чтобы они попали в дельту
      // /sync. См. domain/sourceDocuments/touch.ts.
      await touchSourceDocuments({ db: tx }, input.sourceDocumentIds);
    }
    return created;
  });
}

async function updateShipment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  existing: typeof shipments.$inferSelect,
  input: z.infer<typeof ShipmentUpsertSchema>,
  statusId: string,
  userId: string | null,
  /**
   * Объект-источник, которому отгрузка обязана принадлежать в момент UPDATE.
   * Не null только для inspector_kpp — см. updateDelivery в deliveries.ts.
   * Ноль задетых строк → [ForeignSiteError] и откат транзакции.
   */
  expectedSiteId: string | null = null,
) {
  const id = existing.id;
  // Защита от downgrade жизненного статуса. См. status-guard.ts:
  //   confirmed_mol — защищён от ВСЕГО ниже (исторический guard).
  //   shipped       — защищён от not_filled (новый guard: симметрично
  //                   delivery, иначе после правок на портале отгрузка
  //                   пропадает из мобильного Stage 2 у инспектора).
  // Апгрейды (not_filled → shipped → confirmed_mol) разрешены.
  const existingCode = await getStatusCodeById(app, existing.statusId);
  const effectiveStatusId = isShipmentDowngrade(existingCode ?? '', input.statusCode)
    ? existing.statusId
    : statusId;
  // Наблюдаемость: status-guard молча оставил прежний статус. Контракт ответа
  // не меняем (старый клиент не ждёт ошибки), логируем факт. См. status-guard.ts.
  if (effectiveStatusId !== statusId) {
    app.log?.warn?.(
      {
        entity: 'shipment',
        id,
        existingStatus: existingCode,
        requestedStatus: input.statusCode,
        effectiveStatus: existingCode,
      },
      'status-guard: prevented shipment status downgrade',
    );
  }
  // Идемпотентность через COALESCE в самом UPDATE, а не по прочитанному до
  // транзакции `existing` (симметрично updateDelivery): два параллельных
  // запроса оба сочли бы себя первыми. Время — с планшета, см. confirmed-at.ts.
  const wantsConfirm = input.statusCode === 'confirmed_mol';
  const confirmedAtCandidate = wantsConfirm
    ? resolveConfirmedAt({
        raw: input.confirmedByMolAt,
        lowerBound: input.shippedAt ?? existing.shippedAt,
        log: app.log,
        entity: 'shipment',
        id,
      })
    : null;
  // ISO-строка с явным приведением: postgres.js не биндит Date внутри sql``.
  const confirmedAtIso = confirmedAtCandidate?.toISOString() ?? null;

  // Ручная привязка УПД к отгрузке без документа на портале: клиент шлёт
  // непустой sourceDocumentIds и пустой items — сервер подтягивает позиции
  // из УПД. См. updateDelivery (симметрично).
  const [existingSourcesCount] = await app.db
    .select({ c: drSql<number>`count(*)::int` })
    .from(shipmentSources)
    .where(eq(shipmentSources.shipmentId, id));
  const existingHadNoDocs = (existingSourcesCount?.c ?? 0) === 0;
  const itemsForInsert =
    existingHadNoDocs && input.sourceDocumentIds.length > 0 && input.items.length === 0
      ? await buildShipmentItemsFromSources(app, input.sourceDocumentIds)
      : input.items.map((i) => ({
          // clientId переживает только сборку origins и отбрасывается перед
          // вставкой — в shipment_items такой колонки нет.
          clientId: i.id ?? null,
          sourceDocumentId: i.sourceDocumentId ?? null,
          sourceDocumentItemId: i.sourceDocumentItemId ?? null,
          itemKind: i.itemKind,
          materialId: i.itemKind === 'asset' ? null : (i.materialId ?? null),
          assetId: i.itemKind === 'asset' ? (i.assetId ?? null) : null,
          inventoryNumber: i.inventoryNumber ?? null,
          serialNumber: i.serialNumber ?? null,
          nameRaw: i.nameRaw,
          qtyPlanned: i.qtyPlanned ?? null,
          qtyActual: i.qtyActual ?? null,
          unit: i.unit,
          comment: i.comment ?? null,
          lineNo: i.lineNo,
          volumeM3: i.volumeM3 ?? null,
          massKg: i.massKg ?? null,
          price: i.price ?? null,
          vatRate: i.vatRate ?? null,
          vatSum: i.vatSum ?? null,
          volumeConfidence: i.volumeConfidence ?? null,
          groupName: i.groupName ?? null,
        }));

  // Атомарность update: статус/шапка + позиции + источники + touch УПД —
  // одна транзакция (симметрично updateDelivery).
  return await app.db.transaction(async (tx: typeof app.db) => {
    const updatedRows = await tx
      .update(shipments)
      .set({
        statusId: effectiveStatusId,
        kind: input.kind,
        purpose: input.purpose ?? null,
        inTransit: input.inTransit ?? false,
        isAssets: input.isAssets ?? false,
        siteId: input.siteId,
        receiverCounterpartyId: input.receiverCounterpartyId ?? null,
        receiverMolId: input.receiverMolId ?? null,
        destSiteId: input.destSiteId ?? null,
        supplierId: input.supplierId ?? null,
        vehiclePlate: input.vehiclePlate ?? null,
        driverName: input.driverName ?? null,
        shippedAt: input.shippedAt ? new Date(input.shippedAt) : null,
        comment: input.comment ?? null,
        // COALESCE, а не условная запись: первое подтверждение побеждает даже при
        // повторной или параллельной мутации.
        ...(wantsConfirm && {
          confirmedByMolUserId: drSql`COALESCE(${shipments.confirmedByMolUserId}, ${userId}::uuid)`,
          confirmedByMolAt: drSql`COALESCE(${shipments.confirmedByMolAt}, ${confirmedAtIso}::timestamptz)`,
        }),
        version: drSql`${shipments.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        expectedSiteId
          ? and(eq(shipments.id, id), eq(shipments.siteId, expectedSiteId))
          : eq(shipments.id, id),
      )
      .returning({ id: shipments.id });
    // Объект отгрузки изменился после чтения existing — прерываем транзакцию,
    // маршрут отдаст 403 foreign_site (см. domain/operations/foreign-site.ts).
    if (updatedRows.length === 0) throw new ForeignSiteError();

    // Происхождение позиций переносится ЯВНО — как в updateDelivery. Строки
    // удаляются и вставляются заново, а source_document_id это данные, которых
    // в запросе может не быть (старый планшет о поле не знает) и которым в
    // запросе нельзя доверять (клиент не должен переписывать происхождение
    // существующей строки). Поэтому снимок делается ДО delete.
    const previousItems = await tx
      .select({
        id: shipmentItems.id,
        nameRaw: shipmentItems.nameRaw,
        unit: shipmentItems.unit,
        lineNo: shipmentItems.lineNo,
        sourceDocumentId: shipmentItems.sourceDocumentId,
        sourceDocumentItemId: shipmentItems.sourceDocumentItemId,
      })
      .from(shipmentItems)
      .where(eq(shipmentItems.shipmentId, id));

    // Авторитетный список связей — сохранённый в БД, а не присланный: upsert
    // связи больше не переписывает (см. ниже). Если бы источником остался
    // input.sourceDocumentIds, происхождение новых строк отбрасывалось бы у
    // любого клиента с устаревшим снимком.
    const linkedSources: { sourceDocumentId: string }[] = await tx
      .select({ sourceDocumentId: shipmentSources.sourceDocumentId })
      .from(shipmentSources)
      .where(eq(shipmentSources.shipmentId, id));
    const linkedDocumentIds = linkedSources.map((x) => x.sourceDocumentId);

    const origins = resolveItemOrigins({
      existing: previousItems,
      incoming: itemsForInsert.map((i) => ({
        id: i.clientId ?? null,
        nameRaw: i.nameRaw,
        unit: i.unit,
        lineNo: i.lineNo,
        sourceDocumentId: i.sourceDocumentId ?? null,
        sourceDocumentItemId: i.sourceDocumentItemId ?? null,
      })),
      linkedDocumentIds,
    });

    await tx.delete(shipmentItems).where(eq(shipmentItems.shipmentId, id));
    if (itemsForInsert.length) {
      await tx.insert(shipmentItems).values(
        itemsForInsert.map(({ clientId: _clientId, ...i }, idx) => ({
          ...i,
          shipmentId: id,
          sourceDocumentId: origins[idx]?.sourceDocumentId ?? null,
          sourceDocumentItemId: origins[idx]?.sourceDocumentItemId ?? null,
        })),
      );
    }
    // Привязки существующей отгрузки upsert НЕ меняет — то же правило, что уже
    // действует у приёмки (см. updateDelivery).
    //
    // Раньше здесь стоял DELETE всех связей + INSERT присланного списка. Пока
    // документ был один, это работало; с несколькими — клиент, знающий про одну
    // УПД, стирал остальные, привязанные менеджером, а устаревший снимок мог
    // воскресить явно отвязанный документ. Опереться на baseVersion нельзя: в
    // контракте он необязателен.
    //
    // Набор связей меняют только явные действия: POST /:id/link-source и
    // POST /:id/unlink-source. При СОЗДАНИИ отгрузки связи по-прежнему берутся
    // из запроса — см. createShipment.
    //
    // Бамп updated_at всё равно нужен: реквизиты отгрузки могли поменяться, а
    // мобильный Inbox фильтрует документы по привязкам и ждёт дельту.
    await touchSourceDocuments({ db: tx }, linkedDocumentIds);
  });
}

// Подтягивает позиции из привязываемых УПД в формате shipment_items.
// Симметрично buildDeliveryItemsFromSources в routes/deliveries.ts.
async function buildShipmentItemsFromSources(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  sourceDocumentIds: string[],
): Promise<
  Array<{
    clientId: null;
    sourceDocumentId: string;
    sourceDocumentItemId: string;
    itemKind: 'material';
    materialId: string | null;
    assetId: null;
    inventoryNumber: null;
    serialNumber: null;
    nameRaw: string;
    qtyPlanned: string | null;
    qtyActual: null;
    unit: string;
    comment: null;
    lineNo: number;
    volumeM3: string | null;
    massKg: string | null;
    price: string | null;
    vatRate: string | null;
    vatSum: string | null;
    volumeConfidence: 'low' | 'medium' | 'high' | null;
    groupName: string | null;
  }>
> {
  if (!sourceDocumentIds.length) return [];
  const rows: (typeof sourceDocumentItems.$inferSelect)[] = await app.db
    .select()
    .from(sourceDocumentItems)
    .where(inArray(sourceDocumentItems.sourceDocumentId, sourceDocumentIds))
    .orderBy(sourceDocumentItems.lineNo);
  return rows.map((r, idx) => ({
    // Позиция построена ИЗ документа — происхождение известно точно, без
    // сопоставления по названию. Ровно ради этого случая колонки и заводились.
    clientId: null,
    sourceDocumentId: r.sourceDocumentId,
    sourceDocumentItemId: r.id,
    itemKind: 'material' as const,
    materialId: r.materialId,
    assetId: null,
    inventoryNumber: null,
    serialNumber: null,
    nameRaw: r.nameRaw,
    qtyPlanned: r.qty,
    qtyActual: null,
    unit: r.unit,
    comment: null,
    lineNo: idx + 1,
    volumeM3: r.volumeM3,
    massKg: r.massKg,
    price: r.price,
    vatRate: r.vatRate,
    vatSum: r.vatSum,
    volumeConfidence: r.volumeConfidence as 'low' | 'medium' | 'high' | null,
    groupName: r.groupName,
  }));
}
