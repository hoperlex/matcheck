import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, ilike, inArray, isNotNull, isNull, ne, or, sql as drSql } from 'drizzle-orm';
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
} from '@matcheck/contracts';
import {
  counterparties,
  deliveries,
  deliveryItems,
  deliveryPhotos,
  deliverySources,
  entityDeletions,
  shipments,
  sites,
  sourceDocumentItems,
  sourceDocuments,
  statuses,
  suppliers,
  users,
} from '../db/schema.js';
import { deleteObject } from '../domain/storage/s3.signer.js';
import {
  getStatusCodeById,
  resolveStatusId as resolveStatusIdShared,
} from '../domain/statuses/lookup.js';
import { touchSourceDocuments } from '../domain/sourceDocuments/touch.js';
import { isDeliveryDowngrade } from '../domain/operations/status-guard.js';
import { canSeeReview } from '../lib/review.js';
import {
  expandCustomerCounterpartyToOpIds,
  resolveContractorOpIds,
  deliveryContractorPredicate,
  deliveryVisibleToContractor,
} from '../lib/contractor-scope.js';
import { publishEvent } from './events.js';
import { dateRangeConditions } from '../lib/date-range.js';

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

// UUID-regex для безопасного парсинга csv-параметров из URL. Невалидные
// значения отбрасываем — иначе Postgres падает на `id IN ('not-uuid')`.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Парсит "a,b,c" в массив UUID, отбрасывая пустые и невалидные значения.
function parseUuidCsv(s: string | undefined): string[] {
  if (!s) return [];
  return s.split(',').map((v) => v.trim()).filter((v) => UUID_RE.test(v));
}

// Парсит "a,b,c" в массив строк, отбрасывая пустые. Без UUID-валидации —
// используется для feature-кодов ('transit', 'assets', ...).
function parseCsv(s: string | undefined): string[] {
  if (!s) return [];
  return s.split(',').map((v) => v.trim()).filter(Boolean);
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

// Статусы, при которых разрешён hard-delete без предварительной пометки.
const HARD_DELETE_STATUSES = new Set(['draft', 'not_filled']);
// Статусы, для которых соответственно требуется soft-delete (mark → admin hard).
const SOFT_DELETE_STATUSES = new Set(['filled', 'confirmed_mol']);

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
  _app: any,
  _sourceDocumentIds: string[],
  _excludeDeliveryId: string | null,
) {
  return;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolveStatusId = (app: any, code: string) =>
  resolveStatusIdShared(app, 'delivery', code);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildDeliveryDto(app: any, id: string, viewerRole?: string | null) {
  // Отметку проверки (review_*) видит только менеджмент; для прочих ролей и для
  // анонимных путей (share) поля обнуляются. viewerRole не передан → скрываем.
  const showReview = canSeeReview(viewerRole);
  // Два независимых join на users: один на МОЛ, другой на автора soft-delete пометки.
  // Для парных приёмок (transfer) подтягиваем плоско дату отгрузки и
  // объект-источник из связанного shipment + sites.
  const pendingUser = alias(users, 'pending_user');
  const reviewUser = alias(users, 'review_user');
  // Имена объекта/поставщика/подрядчика — прямо в DTO (для всех ролей).
  // Нужны, чтобы роль contractor не ходила в закрытые для неё справочники
  // (/sites, /counterparties): названия берутся из scoped-DTO её записей.
  // deliverySite — отдельный alias, т.к. sites уже join'ится на объект-источник
  // парной отгрузки (transfer).
  const deliverySite = alias(sites, 'delivery_site');
  const supplierCp = alias(counterparties, 'supplier_cp');
  const contractorCp = alias(counterparties, 'contractor_cp');
  const rows = await app.db
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
    .leftJoin(contractorCp, eq(deliveries.contractorId, contractorCp.id))
    .where(eq(deliveries.id, id))
    .limit(1);
  const r = rows[0] as
    | {
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
      }
    | undefined;
  if (!r) return null;
  const d = r.d;
  const s = r.s;
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
    items: items.map((i) => ({
      id: i.id,
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
    })),
    photos: photos.map((p) => ({
      id: p.id,
      kind: p.kind,
      stage: p.stage,
      s3Key: p.s3Key,
      thumbS3Key: p.thumbS3Key,
      contentHash: p.contentHash,
      takenAt: p.takenAt.toISOString(),
      uploadedAt: p.uploadedAt?.toISOString() ?? null,
    })),
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

export async function deliveryRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);
  app.get(
    '/api/v1/deliveries',
    {
      preHandler: [app.authenticate],
      schema: { querystring: ListQuerySchema, response: { 200: DeliveryListResponseSchema } },
    },
    async (req) => {
      const {
        status, inspectorId, changedSince, trash, noDocument,
        contractorIds: contractorIdsCsv,
        supplierIds: supplierIdsCsv,
        siteIds: siteIdsCsv,
        q, displayId, plate,
        features: featuresCsv,
        arrivedFrom, arrivedTo, nophoto,
        reviewState,
        limit, offset,
      } = req.query;

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
      if (req.user?.role === 'inspector_kpp') {
        if (!req.user.siteId) {
          filters.push(drSql`false`);
        } else {
          filters.push(eq(deliveries.siteId, req.user.siteId));
        }
      } else if (req.user?.role === 'contractor') {
        // contractor видит только свои приёмки по всем объектам: contractor_id
        // приёмки ∈ его operational id ИЛИ унаследован от привязанного УПД.
        // Без назначенного подрядчика / без совпадений по ИНН — пусто.
        const opIds = await resolveContractorOpIds(app, req.user);
        if (!opIds || opIds.length === 0) {
          filters.push(drSql`false`);
        } else {
          filters.push(deliveryContractorPredicate(opIds));
        }
      } else if (inspectorId) {
        filters.push(eq(deliveries.inspectorId, inspectorId));
      }
      // Чужие черновики (draft) скрыты, если status не указан явно
      if (!status && req.user?.role !== 'inspector_kpp' && req.user) {
        const draftId = await resolveStatusId(app, 'draft');
        filters.push(
          or(ne(deliveries.statusId, draftId), eq(deliveries.inspectorId, req.user.id))!,
        );
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
          filters.push(drSql`(
            ${deliveries.contractorId} = ANY(${opIds}::uuid[])
            OR (
              ${deliveries.contractorId} IS NULL
              AND EXISTS (
                SELECT 1 FROM delivery_sources ds_c
                JOIN source_documents sd_c ON sd_c.id = ds_c.source_document_id
                WHERE ds_c.delivery_id = ${deliveries.id}
                  AND sd_c.contractor_id = ANY(${opIds}::uuid[])
              )
            )
          )`);
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

      const items = (await Promise.all(rows.map((r) => buildDeliveryDto(app, r.id, req.user?.role)))).filter(
        (x): x is NonNullable<typeof x> => x !== null,
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
      preHandler: [app.authenticate],
      schema: {
        body: DeliveryUpsertSchema,
        response: {
          200: DeliverySchema,
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

      // inspector_kpp всегда создаёт/редактирует приёмки своего объекта,
      // независимо от того, что прислал клиент.
      if (req.user?.role === 'inspector_kpp') {
        if (!req.user.siteId) {
          return reply.code(400).send({
            error: 'no_site_assigned',
            message: 'Объект не назначен — обратитесь к администратору',
          });
        }
        input.siteId = req.user.siteId;
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
            await createDelivery(app, input, statusId, inspectorId);
          } else {
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
            await updateDelivery(app, existing, input, statusId, req.user?.id ?? null);
          }
          const dto = await buildDeliveryDto(app, input.id, req.user?.role);
          if (!dto) return reply.code(404).send({ error: 'not_found' });
          publishEvent(app, { type: 'delivery_updated', entityId: dto.id, ts: new Date().toISOString() });
          return dto;
        }

        const created = await createDelivery(app, input, statusId, inspectorId);
        const dto = await buildDeliveryDto(app, created.id, req.user?.role);
        if (!dto) throw new Error('Delivery missing after create');
        publishEvent(app, { type: 'delivery_updated', entityId: dto.id, ts: new Date().toISOString() });
        return dto;
      } catch (err) {
        if (err instanceof SourceAlreadyLinkedError) {
          return reply.code(400).send({
            error: 'source_document_already_linked',
            message: 'УПД уже привязана к другой приёмке',
            details: { sourceDocumentIds: err.sourceDocumentIds },
          });
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
        if (!HARD_DELETE_STATUSES.has(code)) {
          return reply.code(409).send({
            error: 'must_mark_first',
            message: 'Сначала пометьте документ на удаление',
          });
        }
        // Для draft/not_filled — прежняя ролевая модель.
        if (role === 'inspector_kpp') {
          if (!req.user?.siteId || existing.siteId !== req.user.siteId) {
            return reply.code(403).send({ error: 'forbidden' });
          }
        } else if (role !== 'admin' && role !== 'manager') {
          return reply.code(403).send({ error: 'forbidden' });
        }
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

      // Удаляем S3-объекты фото перед каскадным удалением записей.
      const photos = await app.db
        .select({ s3Key: deliveryPhotos.s3Key, thumbS3Key: deliveryPhotos.thumbS3Key })
        .from(deliveryPhotos)
        .where(eq(deliveryPhotos.deliveryId, req.params.id));
      for (const p of photos) {
        try {
          await deleteObject(p.s3Key);
          if (p.thumbS3Key) await deleteObject(p.thumbS3Key);
        } catch (err) {
          req.log.warn({ err, s3Key: p.s3Key }, 'failed to delete s3 object');
        }
      }

      // Сохраняем список привязанных УПД до удаления — после CASCADE
      // delivery_sources они уже будут отвязаны, но их updated_at нужно
      // забампать, чтобы /sync вернул их в Inbox инспектора («снова
      // ожидаемая»).
      const attachedSdIds = (
        await app.db
          .select({ sourceDocumentId: deliverySources.sourceDocumentId })
          .from(deliverySources)
          .where(eq(deliverySources.deliveryId, req.params.id))
      ).map((r: { sourceDocumentId: string }) => r.sourceDocumentId);

      // Журнал hard-delete + физическое удаление одной транзакцией:
      // офлайн-клиент узнаёт об удалении через /sync.deletedIds.
      await app.db.transaction(async (tx) => {
        await tx.insert(entityDeletions).values({
          entityType: 'delivery',
          entityId: existing.id,
          siteId: existing.siteId,
          deletedByUserId: req.user?.id ?? null,
        });
        await tx.delete(deliveries).where(eq(deliveries.id, req.params.id));
      });
      // После удаления delivery (и каскадного удаления junction-строк)
      // бампаем updated_at УПД, чтобы они вернулись в Inbox инспектора.
      await touchSourceDocuments(app, attachedSdIds);
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
      if (role === 'inspector_kpp') {
        if (!req.user?.siteId || existing.siteId !== req.user.siteId) {
          return reply.code(404).send({ error: 'not_found' });
        }
      } else if (role !== 'admin' && role !== 'manager') {
        return reply.code(403).send({ error: 'forbidden' });
      }

      if (existing.pendingDeletionAt !== null) {
        return reply.code(409).send({
          error: 'already_pending',
          message: 'Документ уже помечен на удаление',
        });
      }

      const code = (await getStatusCodeById(app, existing.statusId)) ?? '';
      if (!SOFT_DELETE_STATUSES.has(code)) {
        return reply.code(400).send({
          error: 'cannot_mark_status',
          message: 'Пометка на удаление возможна только для статусов «Оформлена» и «Подтверждено МОЛ»',
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
      publishEvent(app, { type: 'delivery_updated', entityId: dto.id, ts: new Date().toISOString() });
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
      publishEvent(app, { type: 'delivery_updated', entityId: dto.id, ts: new Date().toISOString() });
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
        reason:
          | 'not_found'
          | 'already_pending'
          | 'wrong_status'
          | 'forbidden'
          | 'internal_error';
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
          if (!SOFT_DELETE_STATUSES.has(code)) {
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
            if (!HARD_DELETE_STATUSES.has(code)) {
              skipped.push({ id, reason: 'must_mark_first' });
              continue;
            }
          }
          // S3-объекты удаляются до DB-delete; ошибки в S3 не должны
          // блокировать удаление записи (логируем и продолжаем).
          const photos = await app.db
            .select({
              s3Key: deliveryPhotos.s3Key,
              thumbS3Key: deliveryPhotos.thumbS3Key,
            })
            .from(deliveryPhotos)
            .where(eq(deliveryPhotos.deliveryId, id));
          for (const p of photos) {
            try {
              await deleteObject(p.s3Key);
              if (p.thumbS3Key) await deleteObject(p.thumbS3Key);
            } catch (s3Err) {
              req.log.warn({ err: s3Err, s3Key: p.s3Key }, 'bulk-hard-delete: s3 delete failed');
            }
          }
          const attachedSdIds = (
            await app.db
              .select({ sourceDocumentId: deliverySources.sourceDocumentId })
              .from(deliverySources)
              .where(eq(deliverySources.deliveryId, id))
          ).map((r: { sourceDocumentId: string }) => r.sourceDocumentId);
          await app.db.transaction(async (tx) => {
            await tx.insert(entityDeletions).values({
              entityType: 'delivery',
              entityId: id,
              siteId: existing.siteId,
              deletedByUserId: req.user?.id ?? null,
            });
            await tx.delete(deliveries).where(eq(deliveries.id, id));
          });
          await touchSourceDocuments(app, attachedSdIds);
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
    const csvUuids = (raw: string | undefined): string[] => {
      if (!raw) return [];
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^[0-9a-fA-F-]{36}$/.test(s));
    };
    const fmtDateTimeRu = (d: Date | string | null): string => {
      if (!d) return '';
      const date = d instanceof Date ? d : new Date(d);
      if (Number.isNaN(date.getTime())) return '';
      const dd = String(date.getUTCDate()).padStart(2, '0');
      const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
      const yyyy = date.getUTCFullYear();
      const hh = String(date.getUTCHours()).padStart(2, '0');
      const mi = String(date.getUTCMinutes()).padStart(2, '0');
      return `${dd}.${mm}.${yyyy} ${hh}:${mi}`;
    };

    const ExportDeliveriesQuerySchema = z.object({
      contractorIds: z.string().optional(),
      supplierIds: z.string().optional(),
      siteIds: z.string().optional(),
      q: z.string().trim().min(1).max(200).optional(),
      status: z.string().trim().min(1).max(50).optional(),
      plate: z.string().trim().min(1).max(50).optional(),
      trash: z.coerce.boolean().optional(),
      noDocument: z.coerce.boolean().optional(),
    });

    app.get(
      '/api/v1/deliveries/export.xlsx',
      {
        preHandler: [app.authenticate],
        schema: { querystring: ExportDeliveriesQuerySchema },
      },
      async (req, reply) => {
        const { contractorIds, supplierIds, siteIds, q, status, plate, trash, noDocument } =
          req.query;
        const cIds = csvUuids(contractorIds);
        const sIds = csvUuids(supplierIds);
        const stIds = csvUuids(siteIds);

        const conds = [
          trash
            ? isNotNull(deliveries.pendingDeletionAt)
            : isNull(deliveries.pendingDeletionAt),
        ];
        if (sIds.length) conds.push(inArray(deliveries.supplierId, sIds));
        if (stIds.length) conds.push(inArray(deliveries.siteId, stIds));
        if (plate) conds.push(ilike(deliveries.vehiclePlate, `%${plate}%`));
        if (status && status !== 'no_document') {
          const statusId = await resolveStatusId(app, status);
          conds.push(eq(deliveries.statusId, statusId));
        }
        if (noDocument || status === 'no_document') {
          conds.push(
            drSql`not exists (select 1 from delivery_sources ds where ds.delivery_id = ${deliveries.id})`,
          );
        }
        if (req.user?.role === 'inspector_kpp') {
          if (!req.user.siteId) {
            conds.push(drSql`false`);
          } else {
            conds.push(eq(deliveries.siteId, req.user.siteId));
          }
        } else if (req.user?.role === 'contractor') {
          // Экспорт строит свой WHERE отдельно от списка — дублируем скоуп.
          const opIds = await resolveContractorOpIds(app, req.user);
          if (!opIds || opIds.length === 0) {
            conds.push(drSql`false`);
          } else {
            conds.push(deliveryContractorPredicate(opIds));
          }
        }

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

        // Клиентоподобные фильтры по контрагенту и q (поиск по номеру УПД).
        const filtered = resolved.filter((r) => {
          if (cIds.length) {
            if (!r.contractorIdResolved || !cIds.includes(r.contractorIdResolved)) return false;
          }
          if (q) {
            const num = r.docNumber ?? '';
            if (!num.toLowerCase().includes(q.toLowerCase())) return false;
          }
          return true;
        });

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

        const MONEY_FMT = '# ##0.00 "₽"';
        const QTY_FMT = '# ##0.####';

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
          const siteFull = r.siteCode && r.siteName ? `${r.siteCode} · ${r.siteName}` : r.siteName ?? '';
          const docRow = ws.addRow({
            idx,
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
            const qtyP = it.qtyPlanned != null && it.qtyPlanned !== '' ? Number(it.qtyPlanned) : null;
            const qtyA = it.qtyActual != null && it.qtyActual !== '' ? Number(it.qtyActual) : null;
            const price = it.price != null && it.price !== '' ? Number(it.price) : null;
            const qtyForRowTotal = qtyA ?? qtyP;
            const rowSum =
              qtyForRowTotal != null && price != null && Number.isFinite(qtyForRowTotal) && Number.isFinite(price)
                ? qtyForRowTotal * price
                : null;
            const itemRow = ws.addRow({
              idx: it.lineNo,
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
          .refine(
            (b) => b.inTransit !== undefined || b.isAssets !== undefined,
            { message: 'Минимум одно из полей (inTransit, isAssets) должно быть задано' },
          ),
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
        .where(eq(sourceDocuments.id, req.body.sourceDocumentId))
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
            await tx
              .insert(deliverySources)
              .values({ deliveryId: d.id, sourceDocumentId: src.id });

            // Существующие items приёмки (ручные + предыдущие из УПД).
            // lineNo нужен, чтобы поставить новые позиции В КОНЕЦ списка.
            const existingItems: {
              nameRaw: string;
              unit: string;
              qtyPlanned: string | null;
              lineNo: number;
            }[] = await tx
              .select({
                nameRaw: deliveryItems.nameRaw,
                unit: deliveryItems.unit,
                qtyPlanned: deliveryItems.qtyPlanned,
                lineNo: deliveryItems.lineNo,
              })
              .from(deliveryItems)
              .where(eq(deliveryItems.deliveryId, d.id));

            // Ключ дедупликации: нормализованные nameRaw + unit + qty.
            // Защищает от двух кейсов:
            //   а) повторный нажим кнопки «Привязать УПД» — позиции из
            //      УПД уже могут быть в приёмке, не задваиваем;
            //   б) инспектор руками внёс точно ту же строку, что в УПД,
            //      — не делаем визуальный дубль.
            // При несовпадении единицы измерения / количества — строки
            // считаются разными, и УПД-строка добавляется отдельно.
            const buildKey = (
              name: string,
              unit: string,
              qty: string | null,
            ): string =>
              `${name.trim().toLowerCase()}|${unit.trim().toLowerCase()}|${
                qty == null ? '' : Number(qty).toString()
              }`;
            const existingKeys = new Set(
              existingItems.map((i) =>
                buildKey(i.nameRaw, i.unit, i.qtyPlanned),
              ),
            );
            const startLineNo =
              existingItems.length === 0
                ? 1
                : Math.max(...existingItems.map((i) => i.lineNo)) + 1;

            const updRows: (typeof sourceDocumentItems.$inferSelect)[] =
              await tx
                .select()
                .from(sourceDocumentItems)
                .where(eq(sourceDocumentItems.sourceDocumentId, src.id))
                .orderBy(sourceDocumentItems.lineNo);

            const newRows: (typeof deliveryItems.$inferInsert)[] = [];
            let lineNo = startLineNo;
            for (const r of updRows) {
              if (existingKeys.has(buildKey(r.nameRaw, r.unit, r.qty))) {
                continue;
              }
              newRows.push({
                deliveryId: d.id,
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
}

async function createDelivery(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  input: z.infer<typeof DeliveryUpsertSchema>,
  statusId: string,
  inspectorId: string | null,
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
        confirmedByMolAt: now,
      }),
      version: 1,
    })
    .returning();
  if (!created) throw new Error('Failed to insert delivery');
  if (input.items.length) {
    await tx.insert(deliveryItems).values(
      input.items.map((i) => ({
        deliveryId: created.id,
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
          input.sourceDocumentIds.map((sid) => ({ deliveryId: created.id, sourceDocumentId: sid })),
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
  // Первичная фиксация аудита подтверждения (идемпотентно: повторное
  // подтверждение не перезаписывает кто/когда).
  const isFirstConfirm =
    input.statusCode === 'confirmed_mol' && existing.confirmedByMolUserId === null;

  // Ручная привязка УПД к приёмке без документа на портале: клиент шлёт
  // непустой sourceDocumentIds и пустой items — сервер подтягивает позиции
  // из УПД (qtyPlanned из qty, qtyActual=null). Дальше оператор/инспектор
  // доводит приёмку до filled штатным путём.
  const [existingSourcesCount] = await app.db
    .select({ c: drSql<number>`count(*)::int` })
    .from(deliverySources)
    .where(eq(deliverySources.deliveryId, id));
  const existingHadNoDocs = (existingSourcesCount?.c ?? 0) === 0;
  const itemsForInsert =
    existingHadNoDocs &&
    input.sourceDocumentIds.length > 0 &&
    input.items.length === 0
      ? await buildDeliveryItemsFromSources(app, input.sourceDocumentIds)
      : input.items.map((i) => ({
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
  await tx
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
      ...(isFirstConfirm && {
        confirmedByMolUserId: userId,
        confirmedByMolAt: new Date(),
      }),
      version: drSql`${deliveries.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(deliveries.id, id));
  await tx.delete(deliveryItems).where(eq(deliveryItems.deliveryId, id));
  if (itemsForInsert.length) {
    await tx.insert(deliveryItems).values(
      itemsForInsert.map((i) => ({ ...i, deliveryId: id })),
    );
  }
  if (input.sourceDocumentIds.length) {
    await assertSourcesAvailableForDelivery({ db: tx }, input.sourceDocumentIds, id);
  }
  // Запоминаем какие УПД были привязаны раньше — нужно бампать
  // их updated_at тоже (для УПД, которая отвязывается, видимость
  // в Inbox должна вернуться).
  const previousSources: { sourceDocumentId: string }[] = await tx
    .select({ sourceDocumentId: deliverySources.sourceDocumentId })
    .from(deliverySources)
    .where(eq(deliverySources.deliveryId, id));
  await tx.delete(deliverySources).where(eq(deliverySources.deliveryId, id));
  if (input.sourceDocumentIds.length) {
    try {
      await tx
        .insert(deliverySources)
        .values(input.sourceDocumentIds.map((sid) => ({ deliveryId: id, sourceDocumentId: sid })));
    } catch (err) {
      if (isSourceDocumentUniqueViolation(err)) {
        throw new SourceAlreadyLinkedError(input.sourceDocumentIds);
      }
      throw err;
    }
  }
  // Бамп updated_at для всех затронутых УПД: и для новопривязанных,
  // и для тех, которые отвязались. См. domain/sourceDocuments/touch.ts.
  const affected = new Set<string>([
    ...previousSources.map((p) => p.sourceDocumentId),
    ...input.sourceDocumentIds,
  ]);
  await touchSourceDocuments({ db: tx }, [...affected]);
  });
}

function isSourceDocumentUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; constraint?: string; constraint_name?: string };
  if (e.code !== '23505') return false;
  const name = e.constraint ?? e.constraint_name ?? '';
  return name.endsWith('_source_document_id_unique');
}

// Подтягивает позиции из привязываемых УПД в формате delivery_items.
// Используется при ручной привязке УПД к приёмке «Без документа» на портале:
// диспетчер указывает только sourceDocumentId, а сервер копирует позиции
// (qtyPlanned из source_document_items.qty, qtyActual=null). lineNo пересчитываем
// сквозным образом, чтобы при нескольких УПД получился непрерывный список.
async function buildDeliveryItemsFromSources(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  sourceDocumentIds: string[],
): Promise<
  Array<{
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
