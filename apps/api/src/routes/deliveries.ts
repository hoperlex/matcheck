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
  ConflictResponseSchema,
  DeliveryListResponseSchema,
  DeliveryMarkDeletionSchema,
  DeliverySchema,
  DeliveryStatusCodeSchema,
  DeliveryUpsertSchema,
  ErrorResponseSchema,
  ReviewRequestSchema,
  DELIVERY_HARD_DELETE_STATUSES,
  DELIVERY_SOFT_DELETE_STATUSES,
  type PrimarySourceDocument,
} from '@matcheck/contracts';
import { computeItemsTotal, computeItemsVatSum } from '../lib/operation-sums.js';
import {
  counterparties,
  deliveries,
  deliveryItems,
  deliveryPhotos,
  deliverySources,
  entityDeletions,
  s3CleanupOutbox,
  shipments,
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
import { FOREIGN_SITE_RESPONSE, ForeignSiteError } from '../domain/operations/foreign-site.js';
import { touchSourceDocuments } from '../domain/sourceDocuments/touch.js';
import { isDeliveryDowngrade } from '../domain/operations/status-guard.js';
import { resolveConfirmedAt } from '../domain/operations/confirmed-at.js';
import { resolveItemOrigins } from '../domain/operations/item-origin.js';
import { canSeeReviewInMatrix } from '../lib/review.js';
import { assertPermission } from '../lib/permissions/assert.js';
import {
  expandCustomerCounterpartyToOpIds,
  resolveContractorOpIds,
  deliveryContractorPredicate,
  deliveryVisibleToContractor,
} from '../lib/contractor-scope.js';
import { publishEvent } from './events.js';
import { dateRangeConditions } from '../lib/date-range.js';
import { MONEY_FMT, QTY_FMT, fmtDateTimeRu } from '../lib/xlsx-format.js';

const ListQuerySchema = z.object({
  status: DeliveryStatusCodeSchema.optional(),
  inspectorId: z.string().uuid().optional(),
  changedSince: z.string().datetime().optional(),
  // По умолчанию (false/unset) скрывает помеченные на удаление; trash=true показывает корзину.
  trash: z.coerce.boolean().optional(),
  // Фильтр по наличию привязанной УПД: true — только без документа,
  // false — только с документом, undefined — без фильтра.
  noDocument: z.coerce.boolean().optional(),
  // ─── server-side фильтры из /operations?tab=accepted ─────────────────
  // CSV id из заказчиковских справочников (customer_counterparties и
  // suppliers). Сервер сам разворачивает их в operational counterparty.id
  // через ИНН-маппинг — повторяя клиентскую логику directoryFilterMap.ts.
  // Принимаем как csv (а не повторяющиеся ?contractorIds=) для одного
  // короткого query-параметра; URL и Network-логи короче.
  contractorIds: z.string().optional(),
  supplierIds: z.string().optional(),
  siteIds: z.string().optional(),
  // Поиск по номеру привязанного документа (УПД/ТН) — ILIKE.
  q: z.string().optional(),
  // Точный поиск по короткому id приёмки (колонка «id» в Принятых).
  // Отдельный параметр, а не часть q: у трети документов doc_number
  // совпадает с чьим-то display_id, и объединение через OR тащило бы в
  // выдачу посторонние записи. .safe() — display_id это bigint, без него
  // ?displayId=1e20 прошло бы int().positive() и упало переполнением в PG.
  displayId: z.coerce.number().int().positive().safe().optional(),
  // Поиск по госномеру — ILIKE.
  plate: z.string().optional(),
  // Признаки приёмки, AND между выбранными:
  //   transit, assets, upd, waybill.
  features: z.string().optional(),
  // Диапазон даты прибытия (ISO). Используется для архивных запросов
  // «приёмки за прошлый месяц», когда нужное >limit/offset назад.
  arrivedFrom: z.string().datetime().optional(),
  arrivedTo: z.string().datetime().optional(),
  // ?nophoto=1 — deep-link «Без фото» из дашборда «Статистика».
  nophoto: z.coerce.boolean().optional(),
  // Фильтр по отметке проверки (роль «Мониторинг» / менеджмент): approved —
  // «Проверено», issues — «С замечаниями», none — «Не проверено». На фронте
  // показывается только менеджменту; на бэке — просто предикат по review_state.
  reviewState: z.enum(['approved', 'issues', 'none']).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

// Те же параметры, что у списка, минус пагинация: экспорт обязан выгружать
// ровно то, что пользователь видит на экране, поэтому фильтры у них общие.
// См. buildDeliveryFilters — один источник правды для обоих маршрутов.
type DeliveryFilterQuery = Omit<z.infer<typeof ListQuerySchema>, 'limit' | 'offset'>;

// UUID-regex для безопасного парсинга csv-параметров из URL. Невалидные
// значения отбрасываем — иначе Postgres падает на `id IN ('not-uuid')`.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Парсит "a,b,c" в массив UUID, отбрасывая пустые и невалидные значения.
function parseUuidCsv(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .split(',')
    .map((v) => v.trim())
    .filter((v) => UUID_RE.test(v));
}

// Парсит "a,b,c" в массив строк, отбрасывая пустые. Без UUID-валидации —
// используется для feature-кодов ('transit', 'assets', ...).
function parseCsv(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

const KNOWN_FEATURES = new Set(['transit', 'assets', 'upd', 'waybill']);

// Маппинг directory-id (customer_counterparties / suppliers) в operational
// counterparty.id через совпадение нормализованного ИНН. Повторяет логику
// клиентского directoryFilterMap.ts: ИНН = digits-only, пустой/нулевой
// (placeholder) ИНН исключается. Возвращает массив operational id;
// пустой массив = «ни один directory-id не имеет соответствий по ИНН»
// (что корректно интерпретируется как «фильтр не нашёл ничего», аналогично
// клиентскому поведению при пустом expandDirectoryIdsToOperational).
//
// Делается отдельным SELECT'ом перед основным запросом — drizzle ORM
// (inArray + drSql) безопасно параметризует UUID, никаких SQL injection.
// regexp_replace в JOIN-условии при 1000+ counterparties × 1000 справочника
// — это полный matching, ~ms. На больших объёмах можно добавить
// функциональный индекс по нормализованному ИНН (отдельная задача).
// expandCustomerCounterpartyToOpIds вынесена в lib/contractor-scope.ts —
// её переиспользует скоупинг роли contractor (тот же ИНН-разворот).

async function expandSupplierToOpIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  directoryIds: string[],
): Promise<string[]> {
  if (directoryIds.length === 0) return [];
  const rows = await app.db
    .select({ id: counterparties.id })
    .from(counterparties)
    .innerJoin(
      suppliers,
      drSql`regexp_replace(coalesce(${counterparties.inn}, ''), '[^0-9]', '', 'g')
          = regexp_replace(coalesce(${suppliers.inn}, ''), '[^0-9]', '', 'g')`,
    )
    .where(
      and(
        inArray(suppliers.id, directoryIds),
        drSql`regexp_replace(coalesce(${counterparties.inn}, ''), '[^0-9]', '', 'g') != ''`,
        drSql`regexp_replace(coalesce(${counterparties.inn}, ''), '[^0-9]', '', 'g') !~ '^0+$'`,
      ),
    );
  return rows.map((r: { id: string }) => r.id);
}

// Наборы статусов удаления (hard без пометки / soft через mark → admin hard)
// живут в @matcheck/contracts — общий источник с фронтом, см. statuses.ts.

type StatusRow = typeof statuses.$inferSelect;

class SourceAlreadyLinkedError extends Error {
  constructor(public readonly sourceDocumentIds: string[]) {
    super('source_document_already_linked');
  }
}

// Раньше: «УПД должна быть привязана не более чем к одной приёмке». После
// миграции 0063 UNIQUE-индекс снят — одна УПД может висеть у N приёмок
// (сценарий «несколько поставок»). Функция оставлена как no-op, чтобы
// не править все колл-сайты: PRIMARY KEY (delivery_id, source_document_id)
// по-прежнему гарантирует уникальность ПАРЫ — INSERT той же пары вторично
// упадёт на PK с понятным violation. Параметры сохранены для совместимости.
async function assertSourcesAvailableForDelivery(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  sourceDocumentIds: string[],
  _excludeDeliveryId: string | null,
) {
  if (sourceDocumentIds.length === 0) return;
  // Служебные записи пакетов к приёмке не привязываются. Это держатели
  // вложений на время разбора и промежуточные документы сборки логических
  // УПД: снаружи их не существует, а до публикации такой документ — половина
  // поставки, позиции которой ещё меняются.
  const technical = await app.db
    .select({ id: sourceDocuments.id })
    .from(sourceDocuments)
    .where(
      and(inArray(sourceDocuments.id, sourceDocumentIds), eq(sourceDocuments.isTechnical, true)),
    )
    .limit(1);
  if (technical.length > 0) {
    throw new TechnicalSourceDocumentError();
  }
}

/** Попытка привязать служебную запись пакета — отвечаем 404, её «нет». */
class TechnicalSourceDocumentError extends Error {
  constructor() {
    super('technical_source_document');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolveStatusId = (app: any, code: string) => resolveStatusIdShared(app, 'delivery', code);

// Заголовочный select приёмки (шапка + плоские join-поля). Один и тот же набор
// колонок/join'ов для одиночного (buildDeliveryDto) и батч-пути
// (buildDeliveryDtosBatch) — чтобы форма DTO гарантированно совпадала. WHERE
// (по id или inArray) навешивает вызывающий.
// Два независимых join на users: МОЛ и автор soft-delete пометки. Для парных
// приёмок (transfer) плоско тянем дату отгрузки и объект-источник из shipment+sites.
// deliverySite — отдельный alias, т.к. sites уже join'ится на объект-источник.
// Имена объекта/поставщика/подрядчика — прямо в DTO (для всех ролей), чтобы
// contractor не ходил в закрытые справочники.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function selectDeliveryHeaders(app: any) {
  const pendingUser = alias(users, 'pending_user');
  const reviewUser = alias(users, 'review_user');
  const deliverySite = alias(sites, 'delivery_site');
  const supplierCp = alias(counterparties, 'supplier_cp');
  const contractorCp = alias(counterparties, 'contractor_cp');
  return app.db
    .select({
      d: deliveries,
      s: statuses,
      molEmail: users.email,
      pendingEmail: pendingUser.email,
      reviewEmail: reviewUser.email,
      srcShippedAt: shipments.shippedAt,
      srcSiteId: shipments.siteId,
      srcSiteCode: sites.code,
      siteName: deliverySite.name,
      supplierName: supplierCp.name,
      contractorName: contractorCp.name,
    })
    .from(deliveries)
    .innerJoin(statuses, eq(deliveries.statusId, statuses.id))
    .leftJoin(users, eq(deliveries.confirmedByMolUserId, users.id))
    .leftJoin(pendingUser, eq(deliveries.pendingDeletionByUserId, pendingUser.id))
    .leftJoin(reviewUser, eq(deliveries.reviewedByUserId, reviewUser.id))
    .leftJoin(shipments, eq(deliveries.sourceShipmentId, shipments.id))
    .leftJoin(sites, eq(shipments.siteId, sites.id))
    .leftJoin(deliverySite, eq(deliveries.siteId, deliverySite.id))
    .leftJoin(supplierCp, eq(deliveries.supplierId, supplierCp.id))
    .leftJoin(contractorCp, eq(deliveries.contractorId, contractorCp.id));
}

type DeliveryHeaderRow = {
  d: typeof deliveries.$inferSelect;
  s: StatusRow;
  molEmail: string | null;
  pendingEmail: string | null;
  reviewEmail: string | null;
  srcShippedAt: Date | null;
  srcSiteId: string | null;
  srcSiteCode: string | null;
  siteName: string | null;
  supplierName: string | null;
  contractorName: string | null;
};

// Чистая сборка DTO из уже полученных данных — ЕДИНСТВЕННЫЙ источник формы
// ответа (общий для одиночного и батч-пути). Форму DTO менять только здесь.
function assembleDeliveryDto(
  r: DeliveryHeaderRow,
  items: (typeof deliveryItems.$inferSelect)[],
  photos: (typeof deliveryPhotos.$inferSelect)[],
  sources: { sourceDocumentId: string }[],
  showReview: boolean,
  primaryDoc: PrimarySourceDocument | null = null,
) {
  const d = r.d;
  const s = r.s;
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
    id: d.id,
    displayId: d.displayId,
    status: {
      id: s.id,
      entityType: s.entityType,
      code: s.code,
      label: s.label,
      color: s.color,
      sortOrder: s.sortOrder,
    },
    siteId: d.siteId,
    supplierId: d.supplierId,
    contractorId: d.contractorId,
    recipientMolId: d.recipientMolId,
    siteName: r.siteName,
    supplierName: r.supplierName,
    contractorName: r.contractorName,
    vehiclePlate: d.vehiclePlate,
    driverName: d.driverName,
    arrivedAt: d.arrivedAt?.toISOString() ?? null,
    inspectorId: d.inspectorId,
    comment: d.comment,
    inTransit: d.inTransit,
    isAssets: d.isAssets,
    confirmedByMolUserId: d.confirmedByMolUserId,
    confirmedByMolUserEmail: r.molEmail,
    confirmedByMolAt: d.confirmedByMolAt?.toISOString() ?? null,
    // review_* — только для менеджмента (см. canSeeReview); иначе null.
    reviewState: showReview ? (d.reviewState as 'approved' | 'issues' | null) : null,
    reviewNote: showReview ? d.reviewNote : null,
    reviewedByUserId: showReview ? d.reviewedByUserId : null,
    reviewedByUserEmail: showReview ? r.reviewEmail : null,
    reviewedAt: showReview ? (d.reviewedAt?.toISOString() ?? null) : null,
    pendingDeletionAt: d.pendingDeletionAt?.toISOString() ?? null,
    pendingDeletionByUserId: d.pendingDeletionByUserId,
    pendingDeletionByUserEmail: r.pendingEmail,
    pendingDeletionReason: d.pendingDeletionReason,
    version: d.version,
    sourceDocumentIds: sources.map((x) => x.sourceDocumentId),
    sourceShipmentId: d.sourceShipmentId,
    sourceShipmentShippedAt: r.srcShippedAt?.toISOString() ?? null,
    sourceShipmentSiteId: r.srcSiteId,
    sourceShipmentSiteCode: r.srcSiteCode,
    items: mappedItems,
    photos: mappedPhotos,
    // Волна 1B — предподсчёты для списка «Операции» (см. DeliverySchema).
    itemCount: mappedItems.length,
    photoCount: mappedPhotos.length,
    itemsTotal: computeItemsTotal(mappedItems),
    itemsVatSum: computeItemsVatSum(mappedItems),
    primarySourceDocument: primaryDoc,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

// Одиночный DTO приёмки (GET /:id, ответы мутаций, share). Внешнее поведение
// не изменилось — та же форма через общий assembleDeliveryDto.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildDeliveryDto(app: any, id: string, viewerRole?: string | null) {
  const showReview = await canSeeReviewInMatrix(app, viewerRole, 'operations.deliveries');
  const rows = await selectDeliveryHeaders(app).where(eq(deliveries.id, id)).limit(1);
  const r = rows[0] as DeliveryHeaderRow | undefined;
  if (!r) return null;
  const items: (typeof deliveryItems.$inferSelect)[] = await app.db
    .select()
    .from(deliveryItems)
    .where(eq(deliveryItems.deliveryId, id))
    .orderBy(deliveryItems.lineNo);
  const photos: (typeof deliveryPhotos.$inferSelect)[] = await app.db
    .select()
    .from(deliveryPhotos)
    .where(eq(deliveryPhotos.deliveryId, id));
  const sources: { sourceDocumentId: string }[] = await app.db
    .select({ sourceDocumentId: deliverySources.sourceDocumentId })
    .from(deliverySources)
    .where(eq(deliverySources.deliveryId, id));
  return assembleDeliveryDto(r, items, photos, sources, showReview);
}

// Батч-построение DTO для списка: ~5 запросов на страницу вместо 4×N (устранение
// N+1). Форма каждого элемента идентична buildDeliveryDto (общий assembleDeliveryDto).
// Порядок страницы сохраняется по входному массиву ids (IN не гарантирует порядок).
// ORDER BY items/sources повторяет порядок одиночного PK-скана (lineNo и
// sourceDocumentId) — sourceDocumentIds[0] у мультидок-приёмок не меняется.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildDeliveryDtosBatch(app: any, ids: string[], viewerRole?: string | null) {
  if (ids.length === 0) return [];
  const showReview = await canSeeReviewInMatrix(app, viewerRole, 'operations.deliveries');
  const headerRows = (await selectDeliveryHeaders(app).where(
    inArray(deliveries.id, ids),
  )) as DeliveryHeaderRow[];
  const itemRows: (typeof deliveryItems.$inferSelect)[] = await app.db
    .select()
    .from(deliveryItems)
    .where(inArray(deliveryItems.deliveryId, ids))
    .orderBy(deliveryItems.deliveryId, deliveryItems.lineNo);
  const photoRows: (typeof deliveryPhotos.$inferSelect)[] = await app.db
    .select()
    .from(deliveryPhotos)
    .where(inArray(deliveryPhotos.deliveryId, ids))
    .orderBy(deliveryPhotos.deliveryId, deliveryPhotos.id);
  const sourceRows: { deliveryId: string; sourceDocumentId: string }[] = await app.db
    .select({
      deliveryId: deliverySources.deliveryId,
      sourceDocumentId: deliverySources.sourceDocumentId,
    })
    .from(deliverySources)
    .where(inArray(deliverySources.deliveryId, ids))
    .orderBy(deliverySources.deliveryId, deliverySources.sourceDocumentId);

  const headerById = new Map<string, DeliveryHeaderRow>();
  for (const r of headerRows) headerById.set(r.d.id, r);
  const itemsById = new Map<string, (typeof deliveryItems.$inferSelect)[]>();
  for (const it of itemRows) {
    const arr = itemsById.get(it.deliveryId);
    if (arr) arr.push(it);
    else itemsById.set(it.deliveryId, [it]);
  }
  const photosById = new Map<string, (typeof deliveryPhotos.$inferSelect)[]>();
  for (const p of photoRows) {
    const arr = photosById.get(p.deliveryId);
    if (arr) arr.push(p);
    else photosById.set(p.deliveryId, [p]);
  }
  const sourcesById = new Map<string, { sourceDocumentId: string }[]>();
  for (const sc of sourceRows) {
    const arr = sourcesById.get(sc.deliveryId);
    if (arr) arr.push(sc);
    else sourcesById.set(sc.deliveryId, [sc]);
  }

  // Волна 1B — primarySourceDocument: «основной» документ = первый из
  // sourceDocumentIds (sourcesById[*] уже отсортирован по sourceDocumentId,
  // как sourceDocumentIds[0] на клиенте). Имена резолвим тем же COALESCE, что
  // GET /source-documents: supplierName = COALESCE(suppliers.name,
  // counterparties.name); contractorName = counterparties.name по contractor_id.
  // +1 запрос на страницу (набор уникальных первых документов) — константа.
  const primaryIdByDelivery = new Map<string, string>();
  for (const id of ids) {
    const first = sourcesById.get(id)?.[0]?.sourceDocumentId;
    if (first) primaryIdByDelivery.set(id, first);
  }
  const primaryDocById = new Map<string, PrimarySourceDocument>();
  const uniquePrimaryIds = [...new Set(primaryIdByDelivery.values())];
  if (uniquePrimaryIds.length) {
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
        // ИНН сторон — вторая строка ячейки в истории. Здесь COALESCE полный
        // (raw впереди справочника): sdRow, который расставляет этот приоритет
        // в основном DTO, до снимка операции не доходит.
        //
        // NULLIF(BTRIM(…)) на каждом источнике: и распознавание, и справочник
        // отдают ИНН строкой, а suppliers.inn объявлен NOT NULL DEFAULT '' —
        // пустая строка иначе заблокировала бы следующий источник.
        supplierInn: drSql<
          string | null
        >`COALESCE(NULLIF(BTRIM(${sourceDocuments.supplierInnRaw}), ''), NULLIF(BTRIM(${sdSupplierDir.inn}), ''), NULLIF(BTRIM(${sdSupplier.inn}), ''))`,
        buyerInn: drSql<
          string | null
        >`COALESCE(NULLIF(BTRIM(${sourceDocuments.buyerInnRaw}), ''), NULLIF(BTRIM(${sdBuyer.inn}), ''))`,
        consigneeInn: drSql<
          string | null
        >`COALESCE(NULLIF(BTRIM(${sourceDocuments.consigneeInnRaw}), ''), NULLIF(BTRIM(${sdConsignee.inn}), ''))`,
      })
      .from(sourceDocuments)
      .leftJoin(sdSupplier, eq(sourceDocuments.supplierId, sdSupplier.id))
      .leftJoin(sdSupplierDir, eq(sourceDocuments.supplierDirectoryId, sdSupplierDir.id))
      .leftJoin(sdContractor, eq(sourceDocuments.contractorId, sdContractor.id))
      .leftJoin(sdBuyer, eq(sourceDocuments.buyerId, sdBuyer.id))
      .leftJoin(sdConsignee, eq(sourceDocuments.consigneeId, sdConsignee.id))
      .where(inArray(sourceDocuments.id, uniquePrimaryIds))) as PrimarySourceDocument[];
    for (const sd of sdRows) primaryDocById.set(sd.id, sd);
  }

  const result: ReturnType<typeof assembleDeliveryDto>[] = [];
  for (const id of ids) {
    const r = headerById.get(id);
    if (!r) continue;
    const primaryId = primaryIdByDelivery.get(id);
    result.push(
      assembleDeliveryDto(
        r,
        itemsById.get(id) ?? [],
        photosById.get(id) ?? [],
        sourcesById.get(id) ?? [],
        showReview,
        (primaryId ? primaryDocById.get(primaryId) : null) ?? null,
      ),
    );
  }
  return result;
}

export async function deliveryRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);
  /**
   * Условия выборки приёмок — ОДИН источник правды для списка и для экспорта.
   *
   * Раньше экспорт строил свой WHERE, и он разошёлся со списком: поставщик
   * фильтровался по directory-id без ИНН-маппинга (то есть не находил ничего),
   * а displayId, features, reviewState, nophoto и диапазон дат экспорт не знал
   * вовсе — выгрузка «за период» отдавала все приёмки от начала времён.
   * Держать вторую копию правил нельзя: следующая правка фильтра снова
   * разъедется, и заметит это не разработчик, а бухгалтер в Excel.
   */
  async function buildDeliveryFilters(
    user: Parameters<typeof resolveContractorOpIds>[1],
    query: DeliveryFilterQuery,
  ): Promise<Array<ReturnType<typeof eq>>> {
    const {
      status,
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
      arrivedFrom,
      arrivedTo,
      nophoto,
      reviewState,
    } = query;

    // CSV → массивы. Для UUID-полей фильтруем регексом — невалидное
    // отбрасываем, иначе Postgres падает на 'not-uuid' в `= ANY(...)`.
    const contractorDirIds = parseUuidCsv(contractorIdsCsv);
    const supplierDirIds = parseUuidCsv(supplierIdsCsv);
    const siteIdsArr = parseUuidCsv(siteIdsCsv);
    const featureCodes = parseCsv(featuresCsv).filter((f) => KNOWN_FEATURES.has(f));

    const filters = [];
    // По умолчанию показываем только активные документы; trash=true даёт корзину.
    filters.push(
      trash ? isNotNull(deliveries.pendingDeletionAt) : isNull(deliveries.pendingDeletionAt),
    );
    if (status) {
      const statusId = await resolveStatusId(app, status);
      filters.push(eq(deliveries.statusId, statusId));
    }
    if (noDocument !== undefined) {
      filters.push(
        noDocument
          ? drSql`not exists (select 1 from delivery_sources ds where ds.delivery_id = ${deliveries.id})`
          : drSql`exists (select 1 from delivery_sources ds where ds.delivery_id = ${deliveries.id})`,
      );
    }
    // Фильтр по отметке проверки. none — не проверено (NULL).
    if (reviewState) {
      filters.push(
        reviewState === 'none'
          ? isNull(deliveries.reviewState)
          : eq(deliveries.reviewState, reviewState),
      );
    }
    // inspector_kpp видит приёмки своего объекта (включая созданные другими).
    // Без назначенного объекта — пустой результат.
    if (user?.role === 'inspector_kpp') {
      if (!user.siteId) {
        filters.push(drSql`false`);
      } else {
        filters.push(eq(deliveries.siteId, user.siteId));
      }
    } else if (user?.role === 'contractor') {
      // contractor видит только свои приёмки по всем объектам: contractor_id
      // приёмки ∈ его operational id ИЛИ унаследован от привязанного УПД.
      // Без назначенного подрядчика / без совпадений по ИНН — пусто.
      const opIds = await resolveContractorOpIds(app, user);
      if (!opIds || opIds.length === 0) {
        filters.push(drSql`false`);
      } else {
        filters.push(deliveryContractorPredicate(opIds));
      }
    } else if (inspectorId) {
      filters.push(eq(deliveries.inspectorId, inspectorId));
    }
    // Чужие черновики (draft) скрыты, если status не указан явно
    if (!status && user?.role !== 'inspector_kpp' && user) {
      const draftId = await resolveStatusId(app, 'draft');
      filters.push(or(ne(deliveries.statusId, draftId), eq(deliveries.inspectorId, user.id))!);
    }
    if (changedSince) filters.push(gte(deliveries.updatedAt, new Date(changedSince)));

    // ─── server-side фильтры из /operations?tab=accepted ─────────
    // Раньше эти фильтры применялись клиентом поверх первых 50 записей,
    // и пользователь видел «фильтр работает только в видимом окне».
    // Теперь фильтрация — на сервере, total и pagination считаются по
    // отфильтрованным данным. Логика 1-в-1 повторяет клиентскую
    // (см. apps/web/src/pages/kpp/DeliveriesHistory.tsx → filteredItems).

    // siteIds — простой multi-select.
    if (siteIdsArr.length > 0) {
      filters.push(inArray(deliveries.siteId, siteIdsArr));
    }

    // contractorIds: directory ID → operational ID через ИНН-маппинг.
    // + inheritance: если у приёмки contractor_id NULL, fallback на
    // contractor_id первого привязанного source_document. Это
    // воспроизводит resolveContractor() с клиента DeliveriesHistory.tsx.
    if (contractorDirIds.length > 0) {
      const opIds = await expandCustomerCounterpartyToOpIds(app, contractorDirIds);
      if (opIds.length === 0) {
        // Ни один directory-id не имеет соответствия в counterparties по
        // ИНН — фильтр должен вернуть пустой результат (как клиент).
        filters.push(drSql`false`);
      } else {
        // Тот же предикат, что у RBAC, но в режиме фильтра: менеджер ищет
        // ВСЕ приёмки подрядчика, включая автоподставленные. Раньше здесь
        // лежала копия SQL, и она разошлась бы с боевым правилом при первой
        // же правке (а заодно повторяла бы ошибку с ANY(${'$'}{array})).
        filters.push(deliveryContractorPredicate(opIds, { purpose: 'ui-filter' }));
      }
    }

    // supplierIds: directory ID → operational ID через ИНН-маппинг по
    // справочнику suppliers. Без inheritance (на клиенте тоже без него).
    if (supplierDirIds.length > 0) {
      const opIds = await expandSupplierToOpIds(app, supplierDirIds);
      if (opIds.length === 0) {
        filters.push(drSql`false`);
      } else {
        filters.push(inArray(deliveries.supplierId, opIds));
      }
    }

    // q: поиск по номеру привязанного source_document (УПД/ТН).
    if (q?.trim()) {
      const needle = `%${q.trim()}%`;
      filters.push(drSql`EXISTS (
      SELECT 1 FROM delivery_sources ds_q
      JOIN source_documents sd_q ON sd_q.id = ds_q.source_document_id
      WHERE ds_q.delivery_id = ${deliveries.id}
        AND sd_q.doc_number ILIKE ${needle}
    )`);
    }

    // displayId: точное совпадение по короткому id (уникальный индекс
    // deliveries_display_id_uidx). Отдельный AND-фильтр, НЕ часть q —
    // см. комментарий в схеме. Проверка на undefined, а не truthy:
    // .positive() сейчас делает их равнозначными, но при смене схемы
    // truthy-проверка молча потеряла бы фильтр.
    if (displayId !== undefined) {
      filters.push(eq(deliveries.displayId, displayId));
    }

    // plate: ILIKE на госномер.
    if (plate?.trim()) {
      filters.push(ilike(deliveries.vehiclePlate, `%${plate.trim()}%`));
    }

    // features (AND между выбранными):
    //   transit → in_transit = true
    //   assets  → is_assets = true OR EXISTS item_kind='asset'
    //   upd     → EXISTS source_document.kind='upd'
    //   waybill → EXISTS source_document.kind IN ('transport_waybill','os2_transfer')
    for (const f of featureCodes) {
      if (f === 'transit') {
        filters.push(eq(deliveries.inTransit, true));
      } else if (f === 'assets') {
        filters.push(drSql`(
        ${deliveries.isAssets} = true
        OR EXISTS (
          SELECT 1 FROM delivery_items di_a
          WHERE di_a.delivery_id = ${deliveries.id} AND di_a.item_kind = 'asset'
        )
      )`);
      } else if (f === 'upd') {
        filters.push(drSql`EXISTS (
        SELECT 1 FROM delivery_sources ds_u
        JOIN source_documents sd_u ON sd_u.id = ds_u.source_document_id
        WHERE ds_u.delivery_id = ${deliveries.id} AND sd_u.kind = 'upd'
      )`);
      } else if (f === 'waybill') {
        filters.push(drSql`EXISTS (
        SELECT 1 FROM delivery_sources ds_w
        JOIN source_documents sd_w ON sd_w.id = ds_w.source_document_id
        WHERE ds_w.delivery_id = ${deliveries.id}
          AND sd_w.kind IN ('transport_waybill', 'os2_transfer')
      )`);
      }
    }

    // arrivedFrom / arrivedTo — диапазон даты прибытия (archive lookup).
    // Верхняя граница строгая: клиент шлёт начало следующего дня.
    filters.push(
      ...dateRangeConditions(deliveries.arrivedAt, arrivedFrom, arrivedTo, {
        fromField: 'arrivedFrom',
        toField: 'arrivedTo',
      }),
    );

    // nophoto: нет связанных фото (deep-link из дашборда «Статистика»).
    if (nophoto) {
      filters.push(drSql`NOT EXISTS (
      SELECT 1 FROM delivery_photos dp WHERE dp.delivery_id = ${deliveries.id}
    )`);
    }

    return filters;
  }

  app.get(
    '/api/v1/deliveries',
    {
      preHandler: [app.authenticate],
      schema: { querystring: ListQuerySchema, response: { 200: DeliveryListResponseSchema } },
    },
    async (req) => {
      const { limit, offset } = req.query;
      const filters = await buildDeliveryFilters(req.user, req.query);
      const where = filters.length ? and(...filters) : undefined;

      const rows = await app.db
        .select({ id: deliveries.id })
        .from(deliveries)
        .where(where)
        // Сортировка по displayId DESC (а не updatedAt) — чтобы при
        // редактировании уже принятой приёмки она не «прыгала» наверх
        // списка. displayId назначается БД-sequence монотонно (миграция
        // 0059), поэтому новые сверху, а save существующей запись на
        // её место. Симметрично с shipments.
        .orderBy(desc(deliveries.displayId))
        .limit(limit)
        .offset(offset);
      const [{ count } = { count: 0 }] = await app.db
        .select({ count: drSql<number>`count(*)::int` })
        .from(deliveries)
        .where(where);

      // Батч вместо Promise.all(buildDeliveryDto×N): ~5 запросов на страницу
      // вместо ~4×N (устранение N+1). Порядок страницы — по rows (displayId DESC).
      const items = await buildDeliveryDtosBatch(
        app,
        rows.map((r: { id: string }) => r.id),
        req.user?.role,
      );
      return { items, total: count };
    },
  );

  app.get(
    '/api/v1/deliveries/:id',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: DeliverySchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const dto = await buildDeliveryDto(app, req.params.id, req.user?.role);
      if (!dto) return reply.code(404).send({ error: 'not_found' });
      // inspector_kpp видит только приёмки своего объекта.
      if (
        req.user?.role === 'inspector_kpp' &&
        (!req.user.siteId || dto.siteId !== req.user.siteId)
      ) {
        return reply.code(404).send({ error: 'not_found' });
      }
      // contractor видит только свои приёмки (с наследованием от УПД). DTO не
      // отдаёт унаследованного подрядчика, поэтому проверяем отдельным запросом.
      if (req.user?.role === 'contractor') {
        const opIds = await resolveContractorOpIds(app, req.user);
        if (!opIds || !(await deliveryVisibleToContractor(app, req.params.id, opIds))) {
          return reply.code(404).send({ error: 'not_found' });
        }
      }
      return dto;
    },
  );

  // Отметка проверки качества (роль «Мониторинг»). Ортогональна статусу: меняет
  // ТОЛЬКО review_*, не трогая items/photos/status/version/updated_at — поэтому не
  // задевает guard переходов, OCC и мобильный sync (review-поля в sync не входят, а
  // updated_at не двигаем, чтобы не гонять лишние re-pull на планшеты). Ставить/
  // менять могут admin/manager/monitor; отметка перезаписывается последним
  // проверившим, история не хранится.
  app.patch(
    '/api/v1/deliveries/:id/review',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager', 'monitor')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: ReviewRequestSchema,
        response: {
          200: DeliverySchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          422: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [d] = await app.db
        .select({
          id: deliveries.id,
          statusId: deliveries.statusId,
          pendingDeletionAt: deliveries.pendingDeletionAt,
        })
        .from(deliveries)
        .where(eq(deliveries.id, req.params.id))
        .limit(1);
      if (!d) return reply.code(404).send({ error: 'not_found' });
      if (d.pendingDeletionAt !== null) {
        return reply.code(409).send({
          error: 'pending_deletion',
          message: 'Документ помечен на удаление — проверка недоступна',
        });
      }
      // Гейт зрелости: проверять можно только оформленные приёмки
      // (filled / confirmed_mol). На черновике/не оформленной проверять нечего.
      const code = await getStatusCodeById(app, d.statusId);
      if (code !== 'filled' && code !== 'confirmed_mol') {
        return reply.code(422).send({
          error: 'not_reviewable',
          message: 'Приёмка ещё не оформлена — проверка недоступна',
        });
      }
      const note =
        req.body.note != null && req.body.note.trim().length > 0 ? req.body.note.trim() : null;
      await app.db
        .update(deliveries)
        .set({
          reviewState: req.body.state,
          reviewNote: note,
          reviewedByUserId: req.user?.id ?? null,
          reviewedAt: new Date(),
        })
        .where(eq(deliveries.id, d.id));
      publishEvent(app, {
        type: 'delivery_updated',
        entityId: d.id,
        ts: new Date().toISOString(),
      });
      const dto = await buildDeliveryDto(app, d.id, req.user?.role);
      if (!dto) return reply.code(404).send({ error: 'not_found' });
      return dto;
    },
  );

  app.post(
    '/api/v1/deliveries',
    {
      // contractor/monitor — read-only роли: upsert им недоступен. Раньше здесь
      // был только authenticate, и запись формально проходила по любой роли.
      preHandler: [app.authenticate, app.authorize('admin', 'manager', 'inspector_kpp')],
      schema: {
        body: DeliveryUpsertSchema,
        response: {
          200: DeliverySchema,
          // 403 — foreign_site: инспектор пытается изменить приёмку чужого
          // объекта (см. domain/operations/foreign-site.ts).
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          // 409 — либо OCC-конфликт (Conflict), либо pending_deletion (Error).
          409: z.union([ConflictResponseSchema, ErrorResponseSchema]),
          400: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const input = req.body;
      const inspectorId = req.user?.role === 'inspector_kpp' ? req.user.id : (req.user?.id ?? null);

      // inspector_kpp работает строго в рамках своего объекта. Раньше здесь
      // была ТИХАЯ подмена input.siteId, и приёмка, созданная офлайн на объекте
      // A и отправленная после перевода инспектора на B, молча создавалась на B
      // (клиент отправляет очередь до того, как узнает новый siteId с /me).
      // Теперь несовпадение — явная ошибка, а не переклейка объекта.
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

      // Статус процесса и наличие УПД — независимые измерения: инспектор
      // может оформить приёмку (filled) и без оригинала (например, мобилка
      // «Завершить 1 этап» по фото и госномеру, документ подгрузят позже).
      // Признак «нет документа» отображается отдельным тегом на основании
      // sourceDocumentIds и не занимает слот статуса.
      const statusId = await resolveStatusId(app, input.statusCode);

      try {
        // OCC update
        if (input.id) {
          const [existing] = await app.db
            .select()
            .from(deliveries)
            .where(eq(deliveries.id, input.id))
            .limit(1);
          if (!existing) {
            // Create as upsert with explicit id (для офлайн-черновиков с локально сгенерированным id)
            //
            // Матрица прав: это ветка СОЗДАНИЯ, хотя клиент прислал id.
            // Различать create и edit по наличию input.id нельзя — офлайн-
            // запись с планшета всегда приходит с уже сгенерированным UUID,
            // поэтому решает наличие строки в БД.
            await assertPermission(req, 'operations.deliveries', 'create');
            await createDelivery(app, input, statusId, inspectorId, req.user?.sessionId ?? null);
          } else {
            await assertPermission(req, 'operations.deliveries', 'edit');
            // Инспектор редактирует только записи СВОЕГО объекта. Раньше проверки
            // не было, и upsert чужой приёмки молча переносил её на объект
            // отправителя (см. domain/operations/foreign-site.ts).
            if (req.user?.role === 'inspector_kpp') {
              if (existing.siteId !== req.user.siteId) {
                return reply.code(403).send(FOREIGN_SITE_RESPONSE);
              }
              // Объект существующей записи не меняем: для инспектора он
              // фиксирован, что бы ни прислал клиент.
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
              const server = await buildDeliveryDto(app, existing.id, req.user?.role);
              return reply.code(409).send({
                error: 'conflict' as const,
                serverVersion: existing.version,
                server: server!,
              });
            }
            await updateDelivery(
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
          const dto = await buildDeliveryDto(app, input.id, req.user?.role);
          if (!dto) return reply.code(404).send({ error: 'not_found' });
          publishEvent(app, {
            type: 'delivery_updated',
            entityId: dto.id,
            ts: new Date().toISOString(),
          });
          return dto;
        }

        await assertPermission(req, 'operations.deliveries', 'create');
        const created = await createDelivery(
          app,
          input,
          statusId,
          inspectorId,
          req.user?.sessionId ?? null,
        );
        const dto = await buildDeliveryDto(app, created.id, req.user?.role);
        if (!dto) throw new Error('Delivery missing after create');
        publishEvent(app, {
          type: 'delivery_updated',
          entityId: dto.id,
          ts: new Date().toISOString(),
        });
        return dto;
      } catch (err) {
        if (err instanceof SourceAlreadyLinkedError) {
          return reply.code(400).send({
            error: 'source_document_already_linked',
            message: 'УПД уже привязана к другой приёмке',
            details: { sourceDocumentIds: err.sourceDocumentIds },
          });
        }
        if (err instanceof TechnicalSourceDocumentError) {
          return reply.code(404).send({
            error: 'source_document_not_found',
            message: 'УПД не найдена',
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
    '/api/v1/deliveries/:id',
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
        .from(deliveries)
        .where(eq(deliveries.id, req.params.id))
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
        // Hard-delete без пометки разрешён только для draft/not_filled
        // (черновики и не оформленные приёмки удаляются как раньше).
        const code = (await getStatusCodeById(app, existing.statusId)) ?? '';
        if (!DELIVERY_HARD_DELETE_STATUSES.has(code)) {
          return reply.code(409).send({
            error: 'must_mark_first',
            message: 'Сначала пометьте документ на удаление',
          });
        }
        // Для draft/not_filled — по матрице. Имя роли здесь больше не решает:
        // иначе выданное «Удалять» упиралось бы в этот if и оставалось мёртвым.
        // Ограничение инспектора по объекту — бизнес-скоуп, а не авторизация,
        // поэтому остаётся рядом и проверяется первым.
        if (role === 'inspector_kpp') {
          if (!req.user?.siteId || existing.siteId !== req.user.siteId) {
            return reply.code(403).send({ error: 'forbidden' });
          }
        }
        await assertPermission(req, 'operations.deliveries', 'delete');
      }

      // Аудит для трассировки: pending_deletion_* теряются вместе с записью.
      if (isPending) {
        req.log.info(
          {
            event: 'delivery_hard_deleted',
            deliveryId: existing.id,
            deletedByUserId: req.user?.id ?? null,
            originallyMarkedBy: existing.pendingDeletionByUserId,
            markedAt: existing.pendingDeletionAt?.toISOString() ?? null,
          },
          'delivery hard delete after soft-delete mark',
        );
      }

      // Удаление одной транзакцией + гарантированная дочистка S3 через outbox.
      // Порядок критичен для сохранности фото:
      //  1) SELECT ... FOR UPDATE блокирует строку приёмки. Конкурентная загрузка
      //     фото (INSERT в delivery_photos) берёт на родителе FK-лок FOR KEY SHARE,
      //     конфликтующий с FOR UPDATE → ждёт нас и падает после DELETE. Значит
      //     между чтением ключей и cascade-delete новое фото не проскользнёт.
      //  2) S3-ключи собираем ВНУТРИ транзакции (под блокировкой) и пишем в
      //     s3_cleanup_outbox — воркер дочистит их позже. Недоступность Redis/S3
      //     в этот момент задание не теряет (в отличие от прежнего sync-удаления).
      //  3) touchSourceDocuments — в ТОЙ ЖЕ транзакции (touch.ts требует tx):
      //     /sync вернёт привязанные УПД в Inbox инспектора.
      await app.db.transaction(async (tx) => {
        const locked = await tx
          .select({ id: deliveries.id })
          .from(deliveries)
          .where(eq(deliveries.id, req.params.id))
          .for('update')
          .limit(1);
        if (locked.length === 0) return; // удалена конкурентно — no-op

        const photos = await tx
          .select({ s3Key: deliveryPhotos.s3Key, thumbS3Key: deliveryPhotos.thumbS3Key })
          .from(deliveryPhotos)
          .where(eq(deliveryPhotos.deliveryId, req.params.id));
        const keySet = new Set<string>();
        for (const p of photos) {
          if (p.s3Key) keySet.add(p.s3Key);
          if (p.thumbS3Key) keySet.add(p.thumbS3Key);
        }

        const attachedSdIds = (
          await tx
            .select({ sourceDocumentId: deliverySources.sourceDocumentId })
            .from(deliverySources)
            .where(eq(deliverySources.deliveryId, req.params.id))
        ).map((r: { sourceDocumentId: string }) => r.sourceDocumentId);

        await tx.insert(entityDeletions).values({
          entityType: 'delivery',
          entityId: existing.id,
          siteId: existing.siteId,
          deletedByUserId: req.user?.id ?? null,
        });
        if (keySet.size > 0) {
          await tx
            .insert(s3CleanupOutbox)
            .values(
              Array.from(keySet, (s3Key) => ({
                s3Key,
                entityType: 'delivery',
                entityId: existing.id,
              })),
            );
        }
        await touchSourceDocuments({ db: tx }, attachedSdIds);
        await tx.delete(deliveries).where(eq(deliveries.id, req.params.id));
      });
      publishEvent(app, {
        type: 'delivery_deleted',
        entityId: req.params.id,
        ts: new Date().toISOString(),
      });
      return { ok: true as const };
    },
  );

  // Soft-delete: пометить документ на удаление.
  app.post(
    '/api/v1/deliveries/:id/mark-deletion',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: DeliveryMarkDeletionSchema,
        response: {
          200: DeliverySchema,
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
        .from(deliveries)
        .where(eq(deliveries.id, req.params.id))
        .limit(1);
      if (!existing) return reply.code(404).send({ error: 'not_found' });

      const role = req.user?.role;
      // Видимость как при обычном чтении: inspector_kpp — только свой site.
      // Проверяется ДО прав и отвечает 404, а не 403: иначе по коду ответа
      // читалось бы существование чужой записи.
      if (role === 'inspector_kpp') {
        if (!req.user?.siteId || existing.siteId !== req.user.siteId) {
          return reply.code(404).send({ error: 'not_found' });
        }
      }
      await assertPermission(req, 'operations.deliveries', 'delete');

      if (existing.pendingDeletionAt !== null) {
        return reply.code(409).send({
          error: 'already_pending',
          message: 'Документ уже помечен на удаление',
        });
      }

      const code = (await getStatusCodeById(app, existing.statusId)) ?? '';
      if (!DELIVERY_SOFT_DELETE_STATUSES.has(code)) {
        return reply.code(400).send({
          error: 'cannot_mark_status',
          message:
            'Пометка на удаление возможна только для статусов «Оформлена» и «Подтверждено МОЛ»',
        });
      }

      await app.db
        .update(deliveries)
        .set({
          pendingDeletionAt: new Date(),
          pendingDeletionByUserId: req.user?.id ?? null,
          pendingDeletionReason: req.body.reason ?? null,
          version: drSql`${deliveries.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(deliveries.id, existing.id));
      const dto = await buildDeliveryDto(app, existing.id, req.user?.role);
      if (!dto) return reply.code(404).send({ error: 'not_found' });
      publishEvent(app, {
        type: 'delivery_updated',
        entityId: dto.id,
        ts: new Date().toISOString(),
      });
      return dto;
    },
  );

  // Soft-delete: снять пометку об удалении (восстановить).
  app.post(
    '/api/v1/deliveries/:id/unmark-deletion',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: DeliverySchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [existing] = await app.db
        .select()
        .from(deliveries)
        .where(eq(deliveries.id, req.params.id))
        .limit(1);
      if (!existing) return reply.code(404).send({ error: 'not_found' });

      const role = req.user?.role;
      // Восстановить может админ или тот, кто пометил (с учётом видимости для inspector_kpp).
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
      // Бизнес-правило «автор или админ» выше — про то, ЧЬЮ пометку можно
      // снять; матрица отвечает на другой вопрос — есть ли у роли право
      // удаления вообще. Снятая галочка обязана останавливать и автора.
      await assertPermission(req, 'operations.deliveries', 'delete');

      if (existing.pendingDeletionAt === null) {
        return reply.code(409).send({
          error: 'not_pending',
          message: 'Документ не помечен на удаление',
        });
      }

      await app.db
        .update(deliveries)
        .set({
          pendingDeletionAt: null,
          pendingDeletionByUserId: null,
          pendingDeletionReason: null,
          version: drSql`${deliveries.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(deliveries.id, existing.id));
      const dto = await buildDeliveryDto(app, existing.id, req.user?.role);
      if (!dto) return reply.code(404).send({ error: 'not_found' });
      publishEvent(app, {
        type: 'delivery_updated',
        entityId: dto.id,
        ts: new Date().toISOString(),
      });
      return dto;
    },
  );

  // ──────────── Bulk: пометить N приёмок на удаление ────────────
  // Каждая запись обрабатывается отдельной транзакцией. Идёт по той же
  // логике, что и single /mark-deletion (видимость, статус, already_pending).
  // Безопасно: ошибка на одной записи не откатывает остальные.
  app.post(
    '/api/v1/deliveries/bulk-mark-deletion',
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
            .from(deliveries)
            .where(eq(deliveries.id, id))
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
          if (!DELIVERY_SOFT_DELETE_STATUSES.has(code)) {
            skipped.push({ id, reason: 'wrong_status' });
            continue;
          }
          await app.db
            .update(deliveries)
            .set({
              pendingDeletionAt: new Date(),
              pendingDeletionByUserId: req.user?.id ?? null,
              pendingDeletionReason: null,
              version: drSql`${deliveries.version} + 1`,
              updatedAt: new Date(),
            })
            .where(eq(deliveries.id, id));
          publishEvent(app, {
            type: 'delivery_updated',
            entityId: id,
            ts: new Date().toISOString(),
          });
          deleted.push(id);
        } catch (err) {
          req.log.error({ err, id }, 'bulk-mark-deletion: failed');
          skipped.push({ id, reason: 'internal_error' });
        }
      }
      return { deleted, skipped };
    },
  );

  // ──────────── Bulk: восстановить N приёмок (снять пометку) ────────────
  app.post(
    '/api/v1/deliveries/bulk-unmark-deletion',
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
            .from(deliveries)
            .where(eq(deliveries.id, id))
            .limit(1);
          if (!existing) {
            skipped.push({ id, reason: 'not_found' });
            continue;
          }
          // Видимость + право: тот же набор что у single unmark.
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
            .update(deliveries)
            .set({
              pendingDeletionAt: null,
              pendingDeletionByUserId: null,
              pendingDeletionReason: null,
              version: drSql`${deliveries.version} + 1`,
              updatedAt: new Date(),
            })
            .where(eq(deliveries.id, id));
          publishEvent(app, {
            type: 'delivery_updated',
            entityId: id,
            ts: new Date().toISOString(),
          });
          deleted.push(id);
        } catch (err) {
          req.log.error({ err, id }, 'bulk-unmark-deletion: failed');
          skipped.push({ id, reason: 'internal_error' });
        }
      }
      return { deleted, skipped };
    },
  );

  // ──────────── Bulk: удалить навсегда (только pending, только admin) ────────────
  app.post(
    '/api/v1/deliveries/bulk-hard-delete',
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
            .from(deliveries)
            .where(eq(deliveries.id, id))
            .limit(1);
          if (!existing) {
            skipped.push({ id, reason: 'not_found' });
            continue;
          }
          const isPending = existing.pendingDeletionAt !== null;
          if (!isPending) {
            // Без pending — только draft/not_filled (как в single).
            const code = (await getStatusCodeById(app, existing.statusId)) ?? '';
            if (!DELIVERY_HARD_DELETE_STATUSES.has(code)) {
              skipped.push({ id, reason: 'must_mark_first' });
              continue;
            }
          }
          // Удаление одной транзакцией + дочистка S3 через outbox (как в
          // одиночном DELETE, Волна 1D): FOR UPDATE блокирует конкурентную
          // загрузку фото, S3-ключи собираются под блокировкой и пишутся в
          // s3_cleanup_outbox, touch — в той же транзакции. Синхронного S3 нет.
          const done = await app.db.transaction(async (tx) => {
            const locked = await tx
              .select({ id: deliveries.id })
              .from(deliveries)
              .where(eq(deliveries.id, id))
              .for('update')
              .limit(1);
            if (locked.length === 0) return false; // удалена конкурентно

            const photos = await tx
              .select({ s3Key: deliveryPhotos.s3Key, thumbS3Key: deliveryPhotos.thumbS3Key })
              .from(deliveryPhotos)
              .where(eq(deliveryPhotos.deliveryId, id));
            const keySet = new Set<string>();
            for (const p of photos) {
              if (p.s3Key) keySet.add(p.s3Key);
              if (p.thumbS3Key) keySet.add(p.thumbS3Key);
            }
            const attachedSdIds = (
              await tx
                .select({ sourceDocumentId: deliverySources.sourceDocumentId })
                .from(deliverySources)
                .where(eq(deliverySources.deliveryId, id))
            ).map((r: { sourceDocumentId: string }) => r.sourceDocumentId);

            await tx.insert(entityDeletions).values({
              entityType: 'delivery',
              entityId: id,
              siteId: existing.siteId,
              deletedByUserId: req.user?.id ?? null,
            });
            if (keySet.size > 0) {
              await tx
                .insert(s3CleanupOutbox)
                .values(
                  Array.from(keySet, (s3Key) => ({ s3Key, entityType: 'delivery', entityId: id })),
                );
            }
            await touchSourceDocuments({ db: tx }, attachedSdIds);
            await tx.delete(deliveries).where(eq(deliveries.id, id));
            return true;
          });
          if (!done) {
            skipped.push({ id, reason: 'not_found' });
            continue;
          }
          publishEvent(app, {
            type: 'delivery_deleted',
            entityId: id,
            ts: new Date().toISOString(),
          });
          deleted.push(id);
        } catch (err) {
          req.log.error({ err, id }, 'bulk-hard-delete: failed');
          skipped.push({ id, reason: 'internal_error' });
        }
      }
      return { deleted, skipped };
    },
  );

  // Экспорт принятых приёмок в xlsx с тем же набором фильтров, что и в UI.
  // Каждая приёмка — строка верхнего уровня; позиции (delivery_items) —
  // строки с outlineLevel=1 (свёрнуты по умолчанию, раскрываются в Excel
  // через «+»). Контрагент резолвится как в UI: delivery.contractorId ||
  // sourceDocument.contractorId первого привязанного УПД.
  {

    // Параметры — те же, что у списка, минус пагинация: выгрузка обязана
    // повторять экран. Раньше здесь жила своя схема из восьми полей, и период,
    // displayId, features, reviewState и nophoto в выгрузку не доезжали вовсе.
    const ExportDeliveriesQuerySchema = ListQuerySchema.omit({ limit: true, offset: true });

    app.get(
      '/api/v1/deliveries/export.xlsx',
      {
        preHandler: [app.authenticate],
        schema: { querystring: ExportDeliveriesQuerySchema },
      },
      async (req, reply) => {
        // Тот же WHERE, что у списка: и RBAC-скоуп, и пользовательские фильтры
        // приходят из buildDeliveryFilters, а не из второй копии правил.
        const conds = await buildDeliveryFilters(req.user, req.query);

        const supplier = alias(counterparties, 'supplier');
        const contractor = alias(counterparties, 'contractor');
        const rows = await app.db
          .select({
            d: deliveries,
            statusCode: statuses.code,
            statusLabel: statuses.label,
            supplierName: supplier.name,
            contractorName: contractor.name,
            siteCode: sites.code,
            siteName: sites.name,
          })
          .from(deliveries)
          .innerJoin(statuses, eq(deliveries.statusId, statuses.id))
          .leftJoin(supplier, eq(deliveries.supplierId, supplier.id))
          .leftJoin(contractor, eq(deliveries.contractorId, contractor.id))
          .leftJoin(sites, eq(deliveries.siteId, sites.id))
          .where(and(...conds))
          // Симметрия с list-роутом: displayId DESC даёт стабильный
          // порядок в Excel-выгрузке (не зависит от свежести правок).
          .orderBy(desc(deliveries.displayId));

        const deliveryIds = rows.map((r) => r.d.id);
        type SrcLink = { deliveryId: string; sourceDocumentId: string };
        type SrcDoc = {
          id: string;
          docNumber: string | null;
          contractorId: string | null;
          contractorName: string | null;
        };
        const srcLinks: SrcLink[] = deliveryIds.length
          ? await app.db
              .select({
                deliveryId: deliverySources.deliveryId,
                sourceDocumentId: deliverySources.sourceDocumentId,
              })
              .from(deliverySources)
              .where(inArray(deliverySources.deliveryId, deliveryIds))
          : [];
        const sdIds = Array.from(new Set(srcLinks.map((l) => l.sourceDocumentId)));
        const sdContractor = alias(counterparties, 'sd_contractor');
        const sdRowsRaw: SrcDoc[] = sdIds.length
          ? await app.db
              .select({
                id: sourceDocuments.id,
                docNumber: sourceDocuments.docNumber,
                contractorId: sourceDocuments.contractorId,
                contractorName: sdContractor.name,
              })
              .from(sourceDocuments)
              .leftJoin(sdContractor, eq(sourceDocuments.contractorId, sdContractor.id))
              .where(inArray(sourceDocuments.id, sdIds))
          : [];
        const sdById = new Map<string, SrcDoc>(sdRowsRaw.map((r) => [r.id, r]));
        const linksByDelivery = new Map<string, SrcLink[]>();
        for (const l of srcLinks) {
          const arr = linksByDelivery.get(l.deliveryId) ?? [];
          arr.push(l);
          linksByDelivery.set(l.deliveryId, arr);
        }

        // Резолвим контрагента и номер документа как в UI:
        // contractor = delivery.contractorId || sd.contractorId первой привязки.
        const resolved = rows.map((r) => {
          const links = linksByDelivery.get(r.d.id) ?? [];
          const firstSd = links[0] ? sdById.get(links[0].sourceDocumentId) : undefined;
          const contractorIdR = r.d.contractorId ?? firstSd?.contractorId ?? null;
          const contractorNameR = r.contractorName ?? firstSd?.contractorName ?? null;
          const docNumber = firstSd?.docNumber ?? null;
          return {
            ...r,
            contractorIdResolved: contractorIdR,
            contractorNameResolved: contractorNameR,
            docNumber,
          };
        });

        // Фильтров в памяти больше нет: подрядчик и поиск по номеру документа
        // применены в SQL тем же предикатом, что и в списке. Прежняя версия
        // сравнивала q только с номером ПЕРВОГО привязанного документа — у
        // машины из нескольких УПД выгрузка теряла строки, которые список
        // показывал.
        const filtered = resolved;

        const finalIds = filtered.map((r) => r.d.id);
        const itemsByDelivery = new Map<string, (typeof deliveryItems.$inferSelect)[]>();
        if (finalIds.length > 0) {
          const items = await app.db
            .select()
            .from(deliveryItems)
            .where(inArray(deliveryItems.deliveryId, finalIds))
            .orderBy(deliveryItems.deliveryId, deliveryItems.lineNo);
          for (const it of items) {
            const arr = itemsByDelivery.get(it.deliveryId) ?? [];
            arr.push(it);
            itemsByDelivery.set(it.deliveryId, arr);
          }
        }
        const photoCounts = new Map<string, number>();
        if (finalIds.length > 0) {
          const counts: { deliveryId: string; count: number }[] = await app.db
            .select({
              deliveryId: deliveryPhotos.deliveryId,
              count: drSql<number>`count(*)::int`,
            })
            .from(deliveryPhotos)
            .where(inArray(deliveryPhotos.deliveryId, finalIds))
            .groupBy(deliveryPhotos.deliveryId);
          for (const c of counts) photoCounts.set(c.deliveryId, c.count);
        }

        const ExcelJS = (await import('exceljs')).default;
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Принятые', {
          views: [{ state: 'frozen', ySplit: 1 }],
          properties: { defaultRowHeight: 16 },
        });
        ws.columns = [
          { header: '№', key: 'idx', width: 6 },
          // Короткий id приёмки — по нему строку из Excel находят на портале
          // (фильтр «id» в Принятых). Без него в файле не было ничего, чем
          // строку можно опознать, кроме номера документа.
          { header: 'id', key: 'displayId', width: 9 },
          { header: 'Статус', key: 'status', width: 16 },
          { header: 'Авто', key: 'vehiclePlate', width: 12 },
          { header: 'Прибытие', key: 'arrivedAt', width: 18 },
          { header: '№ УПД', key: 'docNumber', width: 16 },
          { header: 'Поставщик', key: 'supplierName', width: 28 },
          { header: 'Подрядчик', key: 'contractorName', width: 28 },
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
        headerRow.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFEDEDED' },
        };

        let idx = 0;
        for (const r of filtered) {
          idx++;
          const d = r.d;
          const items = itemsByDelivery.get(d.id) ?? [];
          // Сумма документа: Σ qty × price по позициям (то же, что в UI).
          let docSum: number | null = null;
          let docVatSum: number | null = null;
          for (const it of items) {
            const qtyRaw = it.qtyActual ?? it.qtyPlanned;
            const qty = qtyRaw != null && qtyRaw !== '' ? Number(qtyRaw) : null;
            const price = it.price != null && it.price !== '' ? Number(it.price) : null;
            if (qty != null && price != null && Number.isFinite(qty) && Number.isFinite(price)) {
              docSum = (docSum ?? 0) + qty * price;
            }
            if (it.vatSum != null && it.vatSum !== '' && Number.isFinite(Number(it.vatSum))) {
              docVatSum = (docVatSum ?? 0) + Number(it.vatSum);
            }
          }
          const siteFull =
            r.siteCode && r.siteName ? `${r.siteCode} · ${r.siteName}` : (r.siteName ?? '');
          const docRow = ws.addRow({
            idx,
            displayId: d.displayId,
            status: r.statusLabel,
            vehiclePlate: d.vehiclePlate ?? '',
            arrivedAt: fmtDateTimeRu(d.arrivedAt),
            docNumber: r.docNumber ?? '',
            supplierName: r.supplierName ?? '',
            contractorName: r.contractorNameResolved ?? '',
            siteName: siteFull,
            photos: photoCounts.get(d.id) ?? 0,
            nameRaw: '',
            qtyPlanned: null,
            qtyActual: null,
            unit: '',
            price: null,
            vatSum: docVatSum,
            sum: docSum,
          });
          docRow.font = { bold: true };
          docRow.getCell('vatSum').numFmt = MONEY_FMT;
          docRow.getCell('sum').numFmt = MONEY_FMT;
          docRow.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFF7F7F7' },
          };

          for (const it of items) {
            const qtyP =
              it.qtyPlanned != null && it.qtyPlanned !== '' ? Number(it.qtyPlanned) : null;
            const qtyA = it.qtyActual != null && it.qtyActual !== '' ? Number(it.qtyActual) : null;
            const price = it.price != null && it.price !== '' ? Number(it.price) : null;
            const qtyForRowTotal = qtyA ?? qtyP;
            const rowSum =
              qtyForRowTotal != null &&
              price != null &&
              Number.isFinite(qtyForRowTotal) &&
              Number.isFinite(price)
                ? qtyForRowTotal * price
                : null;
            const itemRow = ws.addRow({
              idx: it.lineNo,
              displayId: null,
              status: '',
              vehiclePlate: '',
              arrivedAt: '',
              docNumber: '',
              supplierName: '',
              contractorName: '',
              siteName: '',
              photos: null,
              nameRaw: it.nameRaw,
              qtyPlanned: qtyP,
              qtyActual: qtyA,
              unit: it.unit,
              price,
              vatSum: it.vatSum != null && it.vatSum !== '' ? Number(it.vatSum) : null,
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
        const filename = `deliveries-${today}.xlsx`;
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

  // Ручной выбор поставщика из Справочника → Поставщики (suppliers).
  // Сценарий: приёмка оформлена в мобиле без УПД («Создать приёмку»),
  // менеджер на портале хочет указать поставщика напрямую из своего
  // эталонного списка. При привязанной УПД эта ручка отказывает —
  // имя поставщика приходит из УПД (приоритет УПД, обсуждено с
  // пользователем). Бэк по справочнику находит или создаёт служебную
  // запись в counterparties (с тем же ИНН/именем) и пишет её id в
  // deliveries.supplier_id; мобила и старая логика DTO не ломаются.
  //
  // body.supplierDirectoryId = null → снять поставщика (delivery.supplier_id := null).
  app.patch(
    '/api/v1/deliveries/:id/supplier-from-directory',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          supplierDirectoryId: z.string().uuid().nullable(),
        }),
        response: {
          200: DeliverySchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [d] = await app.db
        .select({
          id: deliveries.id,
          pendingDeletionAt: deliveries.pendingDeletionAt,
        })
        .from(deliveries)
        .where(eq(deliveries.id, req.params.id))
        .limit(1);
      if (!d) return reply.code(404).send({ error: 'not_found' });
      if (d.pendingDeletionAt !== null) {
        return reply.code(409).send({
          error: 'pending_deletion',
          message: 'Документ помечен на удаление — мутации запрещены',
        });
      }

      // УПД-приоритет: если у приёмки есть привязанная УПД, имя
      // поставщика «официальное» (из counterparty.supplier_id УПД).
      // Ручной выбор тут не имеет смысла — отказываем 409, чтобы UI
      // показал tooltip «Поставщик из УПД».
      const linked = await app.db
        .select({ sd: deliverySources.sourceDocumentId })
        .from(deliverySources)
        .where(eq(deliverySources.deliveryId, d.id))
        .limit(1);
      if (linked.length > 0) {
        return reply.code(409).send({
          error: 'upd_takes_priority',
          message: 'У приёмки привязана УПД — поставщик берётся из неё',
        });
      }

      // null → снять поставщика (выбор «— очистить —» в UI).
      if (req.body.supplierDirectoryId === null) {
        await app.db
          .update(deliveries)
          .set({ supplierId: null, updatedAt: new Date() })
          .where(eq(deliveries.id, d.id));
        publishEvent(app, {
          type: 'delivery_updated',
          entityId: d.id,
          ts: new Date().toISOString(),
        });
        const dto = await buildDeliveryDto(app, d.id, req.user?.role);
        if (!dto) return reply.code(404).send({ error: 'not_found' });
        return dto;
      }

      // Берём поставщика из справочника, нормализуем ИНН (в suppliers
      // он может быть «грязным» — пробелы, префиксы; см. миграцию 0055).
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

      // Ищем counterparty с тем же ИНН. kpp у заказчика в справочнике
      // нет, поэтому мэтчим только по ИНН (это самый стабильный ключ).
      // Если несколько с одним ИНН — берём первую попавшуюся (это
      // редкая ситуация и не критична: справочник перекроет).
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
        // Создаём служебную counterparty: isSupplier=true, нормализованный
        // ИНН, имя из справочника. Уникальность по (inn, kpp) гарантирует
        // схема; ON CONFLICT нам не нужен — мы уже проверили выше.
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
        .update(deliveries)
        .set({ supplierId: counterpartyId, updatedAt: new Date() })
        .where(eq(deliveries.id, d.id));

      publishEvent(app, {
        type: 'delivery_updated',
        entityId: d.id,
        ts: new Date().toISOString(),
      });

      const dto = await buildDeliveryDto(app, d.id, req.user?.role);
      if (!dto) return reply.code(404).send({ error: 'not_found' });
      return dto;
    },
  );

  // PATCH флагов приёмки (inTransit/isAssets). Менеджер на портале
  // правит, если инспектор на мобиле ошибочно поставил/не поставил
  // соответствующий чекбокс на 1 этапе.
  //
  // Минимально-инвазивный endpoint: меняет ТОЛЬКО эти два поля и
  // updated_at, ничего больше. Не трогает items/photos/status/supplier
  // и не запускает items wipe-and-reinsert (как делал бы POST /deliveries
  // upsert). Безопасно для приёмок в любом статусе — мобила следующим
  // /sync получит обновлённые флаги через sourceDocuments/deliveries
  // секции, никаких контрактных breaking-изменений.
  app.patch(
    '/api/v1/deliveries/:id/flags',
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
          200: DeliverySchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [d] = await app.db
        .select({
          id: deliveries.id,
          pendingDeletionAt: deliveries.pendingDeletionAt,
        })
        .from(deliveries)
        .where(eq(deliveries.id, req.params.id))
        .limit(1);
      if (!d) return reply.code(404).send({ error: 'not_found' });
      if (d.pendingDeletionAt !== null) {
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

      await app.db.update(deliveries).set(patch).where(eq(deliveries.id, d.id));

      publishEvent(app, {
        type: 'delivery_updated',
        entityId: d.id,
        ts: new Date().toISOString(),
      });

      const dto = await buildDeliveryDto(app, d.id, req.user?.role);
      if (!dto) return reply.code(404).send({ error: 'not_found' });
      return dto;
    },
  );

  // Привязка УПД к существующей приёмке (приёмка остаётся в своём статусе,
  // ручные материалы из мобилы НЕ удаляются). Заменяет старый клиентский
  // путь «POST /api/v1/deliveries с items:[]» в KppPage.tsx → linkUpd,
  // который через общую логику updateDelivery делал wipe-and-reinsert
  // delivery_items + downgrade статуса до not_filled — это уничтожало
  // строки, добавленные инспектором на 1/2 этапах в мобиле.
  //
  // Поведение нового endpoint'а:
  //  1) INSERT в delivery_sources (PK защищает от дубля; если УПД уже
  //     привязана — 409 «already_linked»).
  //  2) Подгрузка items УПД (sourceDocumentItems) и существующих items
  //     приёмки. Дедуп строк УПД по нормализованному (nameRaw,unit,qty)
  //     — повторный нажим не задвоит строку, и если инспектор уже руками
  //     внёс ту же позицию, она не задублируется.
  //  3) INSERT только новых строк (с lineNo = max(existing)+1, ...).
  //  4) Bump version + updated_at. Статус, supplier_id, contractor_id,
  //     site_id, comment, photo и пр. — НЕ трогаем (минимальная инвазия).
  //  5) touchSourceDocuments(УПД) + publishEvent('delivery_updated').
  //
  // Всё в одной транзакции — при ошибке откат полный (привязка + items).
  app.post(
    '/api/v1/deliveries/:id/link-source',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ sourceDocumentId: z.string().uuid() }),
        response: {
          200: DeliverySchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [d] = await app.db
        .select({
          id: deliveries.id,
          pendingDeletionAt: deliveries.pendingDeletionAt,
        })
        .from(deliveries)
        .where(eq(deliveries.id, req.params.id))
        .limit(1);
      if (!d) return reply.code(404).send({ error: 'not_found' });
      if (d.pendingDeletionAt !== null) {
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
            // Служебная запись пакета (держатель вложений, промежуточный
            // документ сборки логических УПД) снаружи не существует и к
            // приёмке не привязывается.
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

      // Маркер «УПД уже привязана» — бросаем внутри транзакции, ловим
      // снаружи и отвечаем 409 без падения сервиса (PK нарушение даёт
      // невнятный 500 без этого хука).
      class AlreadyLinkedError extends Error {}

      try {
        await app.db.transaction(
          async (
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            tx: any,
          ) => {
            const [already] = await tx
              .select({ deliveryId: deliverySources.deliveryId })
              .from(deliverySources)
              .where(
                and(
                  eq(deliverySources.deliveryId, d.id),
                  eq(deliverySources.sourceDocumentId, src.id),
                ),
              )
              .limit(1);
            if (already) throw new AlreadyLinkedError();
            await tx.insert(deliverySources).values({ deliveryId: d.id, sourceDocumentId: src.id });

            // Существующие items приёмки (ручные + предыдущие из УПД).
            // lineNo нужен, чтобы поставить новые позиции В КОНЕЦ списка.
            const existingItems: {
              nameRaw: string;
              unit: string;
              qtyPlanned: string | null;
              lineNo: number;
              sourceDocumentId: string | null;
              sourceDocumentItemId: string | null;
            }[] = await tx
              .select({
                nameRaw: deliveryItems.nameRaw,
                unit: deliveryItems.unit,
                qtyPlanned: deliveryItems.qtyPlanned,
                lineNo: deliveryItems.lineNo,
                sourceDocumentId: deliveryItems.sourceDocumentId,
                sourceDocumentItemId: deliveryItems.sourceDocumentItemId,
              })
              .from(deliveryItems)
              .where(eq(deliveryItems.deliveryId, d.id));

            // Дедупликация идёт ВНУТРИ документа, а не по всей приёмке.
            //
            // Раньше ключ (nameRaw, unit, qty) сравнивался со всеми позициями
            // сразу, и одинаковая строка из второй УПД молча пропадала —
            // приёмка занижалась ровно на неё. Машина же привозит два разных
            // документа, и в каждом эта позиция своя.
            //
            // Что защита сохраняет: повторный нажим «Привязать» и повторную
            // привязку после отвязки. Основной признак — сохранённое
            // происхождение строки: по нему позиция находится точно, без
            // угадывания. Ключ (name, unit, qty) остаётся запасным — для
            // строк, чей sourceDocumentItemId обнулился переразбором документа.
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

            const newRows: (typeof deliveryItems.$inferInsert)[] = [];
            let lineNo = startLineNo;
            for (const r of updRows) {
              if (existingSourceItemIds.has(r.id)) continue;
              if (existingKeys.has(buildKey(r.nameRaw, r.unit, r.qty))) {
                continue;
              }
              newRows.push({
                deliveryId: d.id,
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
              await tx.insert(deliveryItems).values(newRows);
            }

            // Bump version+updated_at. Статус и прочие поля приёмки
            // НЕ ТРОГАЕМ — это критично для confirmed_mol-приёмок:
            // привязка УПД не должна откатить статус обратно к not_filled.
            await tx
              .update(deliveries)
              .set({
                version: drSql`${deliveries.version} + 1`,
                updatedAt: new Date(),
              })
              .where(eq(deliveries.id, d.id));
          },
        );
      } catch (err) {
        if (err instanceof AlreadyLinkedError) {
          return reply.code(409).send({
            error: 'already_linked',
            message: 'УПД уже привязана к этой приёмке',
          });
        }
        throw err;
      }

      // touchSourceDocuments — чтобы Inbox мобилы обновился, и привязанная
      // УПД исчезла из ожидаемых у инспектора. Делаем после транзакции,
      // потому что touch не атомарен с insert (это уже отдельный bump).
      await touchSourceDocuments(app, [src.id]);
      publishEvent(app, {
        type: 'delivery_updated',
        entityId: d.id,
        ts: new Date().toISOString(),
      });

      const dto = await buildDeliveryDto(app, d.id, req.user?.role);
      if (!dto) return reply.code(404).send({ error: 'not_found' });
      return dto;
    },
  );

  // Отвязка документа от приёмки — парное действие к link-source.
  //
  // Понадобилась вместе с правилом «upsert не меняет привязки»: без явной
  // отвязки ошибочную привязку стало бы нечем откатить. Раньше её роль играл
  // upsert с урезанным sourceDocumentIds, и он же был дырой — планшет стирал
  // привязки менеджера.
  //
  // Позиции НЕ удаляются и происхождение НЕ обнуляется: строка могла быть уже
  // проверена и исправлена инспектором, а знание «откуда она взялась» — данные,
  // а не следствие связи. В интерфейсе такая группа показывается как
  // «Отвязанный УПД № …», а повторная привязка находит свои строки по
  // сохранённому sourceDocumentItemId и не задваивает их.
  app.post(
    '/api/v1/deliveries/:id/unlink-source',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ sourceDocumentId: z.string().uuid() }),
        response: {
          200: DeliverySchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [d] = await app.db
        .select({ id: deliveries.id, pendingDeletionAt: deliveries.pendingDeletionAt })
        .from(deliveries)
        .where(eq(deliveries.id, req.params.id))
        .limit(1);
      if (!d) return reply.code(404).send({ error: 'not_found' });
      if (d.pendingDeletionAt !== null) {
        return reply.code(409).send({
          error: 'pending_deletion',
          message: 'Документ помечен на удаление — мутации запрещены',
        });
      }

      const removed = await app.db.transaction(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async (tx: any) => {
          const deleted = await tx
            .delete(deliverySources)
            .where(
              and(
                eq(deliverySources.deliveryId, d.id),
                eq(deliverySources.sourceDocumentId, req.body.sourceDocumentId),
              ),
            )
            .returning({ sourceDocumentId: deliverySources.sourceDocumentId });
          if (deleted.length === 0) return false;

          await tx
            .update(deliveries)
            .set({ version: drSql`${deliveries.version} + 1`, updatedAt: new Date() })
            .where(eq(deliveries.id, d.id));
          return true;
        },
      );

      if (!removed) {
        return reply.code(404).send({
          error: 'not_linked',
          message: 'Этот документ не привязан к приёмке',
        });
      }

      // Документ снова свободен — мобильный Inbox должен его увидеть.
      await touchSourceDocuments(app, [req.body.sourceDocumentId]);
      publishEvent(app, {
        type: 'delivery_updated',
        entityId: d.id,
        ts: new Date().toISOString(),
      });

      const dto = await buildDeliveryDto(app, d.id, req.user?.role);
      if (!dto) return reply.code(404).send({ error: 'not_found' });
      return dto;
    },
  );
}

async function createDelivery(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  input: z.infer<typeof DeliveryUpsertSchema>,
  statusId: string,
  inspectorId: string | null,
  /**
   * Сессия, из которой пришёл запрос = устройство, заведшее запись.
   * Проставляется ТОЛЬКО здесь: updateDelivery поле не трогает, иначе
   * потерялось бы, каким планшетом запись создана. null — для путей, где
   * сессии нет (парная transfer-приёмка, серверные сценарии).
   */
  createdBySessionId: string | null = null,
) {
  // «Ручной внос» на мобиле: инспектор создаёт приёмку сразу со статусом
  // confirmed_mol (без выбора УПД, минуя 1-2 этап). В этом случае
  // инспектор = подтверждающий МОЛ, заполняем confirmedByMol* при INSERT,
  // чтобы веб-портал показал «Подтверждено МОЛ (<инспектор>)» сразу.
  // Без этого fix'а status='confirmed_mol' создавался без автора, и в
  // карточке отображался прочерк. Существующий flow (create 'filled' →
  // update 'confirmed_mol') не затронут — там isFirstConfirm в updateDelivery
  // уже выставляет эти поля.
  const isDirectConfirm = input.statusCode === 'confirmed_mol';
  const now = new Date();
  // Время подтверждения — с планшета (момент нажатия «Завершить»), а не время
  // приёма мутации: при офлайне они расходятся на часы. Старые сборки поля не
  // шлют — для них resolveConfirmedAt вернёт `now`, как было раньше.
  const confirmedAtCandidate = isDirectConfirm
    ? resolveConfirmedAt({
        raw: input.confirmedByMolAt,
        lowerBound: input.arrivedAt,
        now,
        log: app.log,
        entity: 'delivery',
        id: input.id,
      })
    : null;
  // Атомарность: шапка + позиции + источники + touch УПД пишутся в ОДНОЙ
  // транзакции. Раньше это были отдельные insert'ы — сбой на середине
  // (constraint/обрыв) оставлял «приёмку без позиций» или 500, что на
  // мобильном выливалось в исчерпание retry и потерю мутации. Теперь —
  // либо всё, либо ничего. Контракт ответа не меняется.
  return await app.db.transaction(async (tx: typeof app.db) => {
    const [created] = await tx
      .insert(deliveries)
      .values({
        id: input.id,
        statusId,
        siteId: input.siteId,
        supplierId: input.supplierId ?? null,
        contractorId: input.contractorId ?? null,
        recipientMolId: input.recipientMolId ?? null,
        vehiclePlate: input.vehiclePlate ?? null,
        driverName: input.driverName ?? null,
        arrivedAt: input.arrivedAt ? new Date(input.arrivedAt) : null,
        inspectorId,
        comment: input.comment ?? null,
        inTransit: input.inTransit ?? false,
        isAssets: input.isAssets ?? false,
        ...(isDirectConfirm && {
          confirmedByMolUserId: inspectorId,
          confirmedByMolAt: confirmedAtCandidate,
        }),
        createdBySessionId,
        version: 1,
      })
      .returning();
    if (!created) throw new Error('Failed to insert delivery');
    if (input.items.length) {
      // При СОЗДАНИИ приёмки происхождение берётся из запроса: строк в БД ещё
      // нет, переносить нечего. Ограничение то же, что и дальше по жизни
      // приёмки, — документ должен быть в её наборе связей.
      const linkedOnCreate = new Set(input.sourceDocumentIds);
      await tx.insert(deliveryItems).values(
        input.items.map((i) => ({
          deliveryId: created.id,
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
      await assertSourcesAvailableForDelivery({ db: tx }, input.sourceDocumentIds, created.id);
      try {
        await tx
          .insert(deliverySources)
          .values(
            input.sourceDocumentIds.map((sid) => ({
              deliveryId: created.id,
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
      // /sync и инспектор увидел изменение видимости без logout/login.
      // См. domain/sourceDocuments/touch.ts.
      await touchSourceDocuments({ db: tx }, input.sourceDocumentIds);
    }
    return created;
  });
}

async function updateDelivery(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  existing: typeof deliveries.$inferSelect,
  input: z.infer<typeof DeliveryUpsertSchema>,
  statusId: string,
  userId: string | null,
  /**
   * Объект, которому запись обязана принадлежать в момент UPDATE. Не null
   * только для inspector_kpp: `existing` читается вне транзакции, и без этого
   * условия менеджер мог успеть перенести приёмку между проверкой и апдейтом.
   * Ноль задетых строк → [ForeignSiteError] и откат транзакции.
   */
  expectedSiteId: string | null = null,
) {
  const id = existing.id;
  // Защита от downgrade жизненного статуса. См. status-guard.ts:
  //   confirmed_mol — защищён от ВСЕГО ниже (исторический guard).
  //   filled        — защищён от not_filled (новый guard: мобильный
  //                   Stage 2 фильтрует только filled, downgrade
  //                   из веб-портала уносил приёмку с мобильного
  //                   2 этапа, инспектор её больше не видел).
  // Апгрейды (not_filled → filled → confirmed_mol) разрешены.
  const existingCode = await getStatusCodeById(app, existing.statusId);
  const effectiveStatusId = isDeliveryDowngrade(existingCode ?? '', input.statusCode)
    ? existing.statusId
    : statusId;
  // Наблюдаемость: status-guard молча оставляет прежний статус. Контракт
  // ответа НЕ меняем (старый клиент не ждёт новой ошибки), но логируем факт —
  // чтобы рассинхрон «клиент думает confirmed_mol, на сервере filled» был
  // виден в логах. См. status-guard.ts.
  if (effectiveStatusId !== statusId) {
    app.log?.warn?.(
      {
        entity: 'delivery',
        id,
        existingStatus: existingCode,
        requestedStatus: input.statusCode,
        effectiveStatus: existingCode,
      },
      'status-guard: prevented delivery status downgrade',
    );
  }
  // Первичная фиксация аудита подтверждения. Идемпотентность обеспечивает
  // COALESCE в самом UPDATE (см. ниже), а не проверка по `existing`: тот
  // прочитан ДО транзакции, и два параллельных запроса оба сочли бы себя
  // первыми. Время берём с планшета — это момент, когда инспектор нажал
  // «Завершить», а не когда мутация доехала до сервера (см. confirmed-at.ts).
  const wantsConfirm = input.statusCode === 'confirmed_mol';
  const confirmedAtCandidate = wantsConfirm
    ? resolveConfirmedAt({
        raw: input.confirmedByMolAt,
        lowerBound: input.arrivedAt ?? existing.arrivedAt,
        log: app.log,
        entity: 'delivery',
        id,
      })
    : null;
  // В raw-SQL шаблон уходит ISO-строка с явным приведением: postgres.js не
  // умеет биндить объект Date внутри sql`` и падает на Bind.
  const confirmedAtIso = confirmedAtCandidate?.toISOString() ?? null;

  // Позиции берутся из запроса как есть. Ветки «клиент прислал только
  // sourceDocumentIds — сервер сам подтянет позиции из УПД» здесь больше нет:
  // привязка документа к существующей приёмке стала явным действием
  // (POST /:id/link-source), и позиции подтягивает оно же, в одной транзакции
  // со связью. Оставить её тут значило бы создать позиции без связи.
  //
  // clientId держим отдельно от полей строки: он нужен только для переноса
  // происхождения и в БД не пишется (id генерирует Postgres).
  const itemsForInsert = input.items.map((i) => ({
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
  // одна транзакция (см. createDelivery). Раньше delete items проходил, а
  // insert падал → приёмка теряла все позиции.
  return await app.db.transaction(async (tx: typeof app.db) => {
    const updatedRows = await tx
      .update(deliveries)
      .set({
        statusId: effectiveStatusId,
        siteId: input.siteId,
        supplierId: input.supplierId ?? null,
        contractorId: input.contractorId ?? null,
        recipientMolId: input.recipientMolId ?? null,
        vehiclePlate: input.vehiclePlate ?? null,
        driverName: input.driverName ?? null,
        arrivedAt: input.arrivedAt ? new Date(input.arrivedAt) : null,
        comment: input.comment ?? null,
        inTransit: input.inTransit ?? false,
        isAssets: input.isAssets ?? false,
        // COALESCE, а не условная запись: первое подтверждение побеждает даже при
        // повторной или параллельной мутации — SQL смотрит на актуальную строку,
        // а не на прочитанный до транзакции снимок.
        ...(wantsConfirm && {
          confirmedByMolUserId: drSql`COALESCE(${deliveries.confirmedByMolUserId}, ${userId}::uuid)`,
          confirmedByMolAt: drSql`COALESCE(${deliveries.confirmedByMolAt}, ${confirmedAtIso}::timestamptz)`,
        }),
        version: drSql`${deliveries.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        expectedSiteId
          ? and(eq(deliveries.id, id), eq(deliveries.siteId, expectedSiteId))
          : eq(deliveries.id, id),
      )
      .returning({ id: deliveries.id });
    // Объект записи изменился после чтения existing — прерываем транзакцию,
    // маршрут отдаст 403 foreign_site (см. domain/operations/foreign-site.ts).
    if (updatedRows.length === 0) throw new ForeignSiteError();

    // Происхождение позиций переносится ЯВНО: строки удаляются и вставляются
    // заново, а `source_document_id` — данные, которых в запросе может не быть
    // (старый планшет о поле не знает) и которым в запросе нельзя доверять
    // (клиент не должен переписывать происхождение существующей строки).
    // Поэтому снимок делается ДО delete, а решение принимает resolveItemOrigins.
    const previousItems = await tx
      .select({
        id: deliveryItems.id,
        nameRaw: deliveryItems.nameRaw,
        unit: deliveryItems.unit,
        lineNo: deliveryItems.lineNo,
        sourceDocumentId: deliveryItems.sourceDocumentId,
        sourceDocumentItemId: deliveryItems.sourceDocumentItemId,
      })
      .from(deliveryItems)
      .where(eq(deliveryItems.deliveryId, id));

    // Связи существующей приёмки — авторитетны, и они же ограничивают, из каких
    // документов позиция вообще может приехать.
    const linkedSources: { sourceDocumentId: string }[] = await tx
      .select({ sourceDocumentId: deliverySources.sourceDocumentId })
      .from(deliverySources)
      .where(eq(deliverySources.deliveryId, id));
    const linkedDocumentIds = linkedSources.map((s) => s.sourceDocumentId);

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

    await tx.delete(deliveryItems).where(eq(deliveryItems.deliveryId, id));
    if (itemsForInsert.length) {
      await tx.insert(deliveryItems).values(
        itemsForInsert.map(({ clientId: _clientId, ...i }, idx) => ({
          ...i,
          deliveryId: id,
          sourceDocumentId: origins[idx]?.sourceDocumentId ?? null,
          sourceDocumentItemId: origins[idx]?.sourceDocumentItemId ?? null,
        })),
      );
    }

    // Привязки существующей приёмки upsert НЕ меняет.
    //
    // Раньше здесь стоял DELETE всех связей + INSERT присланного списка. Пока
    // документ у приёмки был один, это работало; с несколькими — планшет,
    // знающий про одну УПД, стирал остальные, привязанные менеджером, а
    // устаревший клиент мог воскресить явно отвязанный документ. Опереться на
    // baseVersion нельзя: в контракте он необязателен.
    //
    // Теперь набор связей меняют только явные действия: POST /:id/link-source и
    // POST /:id/unlink-source. При СОЗДАНИИ приёмки связи по-прежнему берутся из
    // запроса — см. createDelivery.
    //
    // Бамп updated_at всё равно нужен: реквизиты приёмки могли поменяться, а
    // мобильный Inbox фильтрует документы по привязкам и ждёт дельту.
    await touchSourceDocuments({ db: tx }, linkedDocumentIds);
  });
}

function isSourceDocumentUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; constraint?: string; constraint_name?: string };
  if (e.code !== '23505') return false;
  const name = e.constraint ?? e.constraint_name ?? '';
  return name.endsWith('_source_document_id_unique');
}
