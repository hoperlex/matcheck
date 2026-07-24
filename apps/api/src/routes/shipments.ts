import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, ilike, inArray, isNotNull, isNull, ne, or, sql as drSql } from 'drizzle-orm';
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
} from '@matcheck/contracts';
import {
  counterparties,
  entityDeletions,
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
import { deleteObject } from '../domain/storage/s3.signer.js';
import {
  getStatusCodeById,
  resolveStatusId as resolveStatusIdShared,
} from '../domain/statuses/lookup.js';
import { touchSourceDocuments } from '../domain/sourceDocuments/touch.js';
import { isShipmentDowngrade } from '../domain/operations/status-guard.js';
import { canSeeReview } from '../lib/review.js';
import { syncPairedTransferDelivery } from '../domain/transfers/pair.js';
import {
  expandCustomerCounterpartyToOpIds,
  resolveContractorOpIds,
} from '../lib/contractor-scope.js';
import { publishEvent } from './events.js';
import { dateRangeConditions } from '../lib/date-range.js';

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
  // Фильтр по отметке проверки (менеджмент): approved|issues|none. См. deliveries.ts.
  reviewState: z.enum(['approved', 'issues', 'none']).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

// ─── Helpers для server-side фильтров (симметрично deliveries.ts) ──────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseUuidCsv(s: string | undefined): string[] {
  if (!s) return [];
  return s.split(',').map((v) => v.trim()).filter((v) => UUID_RE.test(v));
}

function parseCsv(s: string | undefined): string[] {
  if (!s) return [];
  return s.split(',').map((v) => v.trim()).filter(Boolean);
}

const KNOWN_FEATURES = new Set(['transit', 'assets', 'upd', 'waybill']);
const KNOWN_PURPOSES = new Set([
  'Вывоз материала',
  'Перемещение на объект',
  'Вывоз мусора',
  'Другое',
]);

// expandCustomerCounterpartyToOpIds вынесена в lib/contractor-scope.ts (3-й
// потребитель — скоупинг роли contractor). См. импорт выше.

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

// См. одноимённую функцию в deliveries.ts. После миграции 0063 одна УПД
// может быть привязана к N отгрузкам — функция no-op, оставлена ради
// совместимости с колл-сайтами. PRIMARY KEY (shipment_id, source_document_id)
// гарантирует уникальность ПАРЫ (повторный INSERT той же пары упадёт на PK).
async function assertSourcesAvailableForShipment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _app: any,
  _sourceDocumentIds: string[],
  _excludeShipmentId: string | null,
) {
  return;
}

function isSourceDocumentUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; constraint?: string; constraint_name?: string };
  if (e.code !== '23505') return false;
  const name = e.constraint ?? e.constraint_name ?? '';
  return name.endsWith('_source_document_id_unique');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolveStatusId = (app: any, code: string) =>
  resolveStatusIdShared(app, 'shipment', code);

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
) {
  const s = r.s;
  const st = r.st;
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
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

// Одиночный DTO отгрузки (GET /:id, ответы мутаций, share). Внешнее поведение
// не изменилось — та же форма через общий assembleShipmentDto.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildShipmentDto(app: any, id: string, viewerRole?: string | null) {
  const showReview = canSeeReview(viewerRole);
  const rows = await selectShipmentHeaders(app).where(eq(shipments.id, id)).limit(1);
  const r = rows[0] as ShipmentHeaderRow | undefined;
  if (!r) return null;
  const items: (typeof shipmentItems.$inferSelect)[] = await app.db
    .select()
    .from(shipmentItems)
    .where(eq(shipmentItems.shipmentId, id))
    .orderBy(shipmentItems.lineNo);
  const photos: (typeof shipmentPhotos.$inferSelect)[] = await app.db
    .select()
    .from(shipmentPhotos)
    .where(eq(shipmentPhotos.shipmentId, id));
  const sources: { sourceDocumentId: string }[] = await app.db
    .select({ sourceDocumentId: shipmentSources.sourceDocumentId })
    .from(shipmentSources)
    .where(eq(shipmentSources.shipmentId, id));
  return assembleShipmentDto(r, items, photos, sources, showReview);
}

// Батч-построение DTO для списка: ~5 запросов на страницу вместо 4×N (устранение
// N+1). Форма каждого элемента идентична buildShipmentDto (общий assembleShipmentDto).
// Порядок страницы — по входному ids; ORDER BY items/sources повторяет одиночный
// PK-скан (lineNo и sourceDocumentId) — sourceDocumentIds[0] не меняется.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildShipmentDtosBatch(app: any, ids: string[], viewerRole?: string | null) {
  if (ids.length === 0) return [];
  const showReview = canSeeReview(viewerRole);
  const headerRows = (await selectShipmentHeaders(app).where(
    inArray(shipments.id, ids),
  )) as ShipmentHeaderRow[];
  const itemRows: (typeof shipmentItems.$inferSelect)[] = await app.db
    .select()
    .from(shipmentItems)
    .where(inArray(shipmentItems.shipmentId, ids))
    .orderBy(shipmentItems.shipmentId, shipmentItems.lineNo);
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

  const result: ReturnType<typeof assembleShipmentDto>[] = [];
  for (const id of ids) {
    const r = headerById.get(id);
    if (!r) continue;
    result.push(
      assembleShipmentDto(
        r,
        itemsById.get(id) ?? [],
        photosById.get(id) ?? [],
        sourcesById.get(id) ?? [],
        showReview,
      ),
    );
  }
  return result;
}

export async function shipmentRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);

  app.get(
    '/api/v1/shipments',
    {
      preHandler: [app.authenticate],
      schema: { querystring: ListQuerySchema, response: { 200: ShipmentListResponseSchema } },
    },
    async (req) => {
      const {
        status, kind, siteId, inspectorId, changedSince, trash, noDocument,
        contractorIds: contractorIdsCsv,
        supplierIds: supplierIdsCsv,
        siteIds: siteIdsCsv,
        q, displayId, plate,
        features: featuresCsv,
        purposes: purposesCsv,
        shippedFrom, shippedTo, nophoto,
        reviewState,
        limit, offset,
      } = req.query;

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
      if (reviewState) {
        filters.push(
          reviewState === 'none'
            ? isNull(shipments.reviewState)
            : eq(shipments.reviewState, reviewState),
        );
      }
      // inspector_kpp видит отгрузки своего объекта-источника (включая чужие).
      // Без назначенного объекта — пустой результат. Для admin/manager
      // siteId из query — обычный опциональный фильтр.
      if (req.user?.role === 'inspector_kpp') {
        if (!req.user.siteId) {
          filters.push(drSql`false`);
        } else {
          filters.push(eq(shipments.siteId, req.user.siteId));
        }
      } else if (req.user?.role === 'contractor') {
        // contractor видит отгрузки, где он — получатель (receiver_counterparty_id),
        // по всем объектам, независимо от kind. Наследования от УПД нет (как и у
        // UI-фильтра). Без назначенного подрядчика / без совпадений — пусто.
        const opIds = await resolveContractorOpIds(app, req.user);
        if (!opIds || opIds.length === 0) {
          filters.push(drSql`false`);
        } else {
          filters.push(inArray(shipments.receiverCounterpartyId, opIds));
        }
      } else {
        if (siteId) filters.push(eq(shipments.siteId, siteId));
        if (inspectorId) filters.push(eq(shipments.inspectorId, inspectorId));
      }
      if (!status && req.user?.role !== 'inspector_kpp' && req.user) {
        const draftId = await resolveStatusId(app, 'draft');
        filters.push(
          or(ne(shipments.statusId, draftId), eq(shipments.inspectorId, req.user.id))!,
        );
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
        const needle = `%${q.trim()}%`;
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
        filters.push(ilike(shipments.vehiclePlate, `%${plate.trim()}%`));
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

      // nophoto: нет связанных фото.
      if (nophoto) {
        filters.push(drSql`NOT EXISTS (
          SELECT 1 FROM shipment_photos sp WHERE sp.shipment_id = ${shipments.id}
        )`);
      }

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
        if (
          !opIds ||
          !dto.receiverCounterpartyId ||
          !opIds.includes(dto.receiverCounterpartyId)
        ) {
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
      preHandler: [app.authenticate],
      schema: {
        body: ShipmentUpsertSchema,
        response: {
          200: ShipmentSchema,
          400: ErrorResponseSchema,
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

      // inspector_kpp всегда работает в рамках своего объекта-источника;
      // вход из body игнорируется и заменяется значением из БД.
      if (req.user?.role === 'inspector_kpp') {
        if (!req.user.siteId) {
          return reply.code(400).send({
            error: 'no_site_assigned',
            message: 'Объект не назначен — обратитесь к администратору',
          });
        }
        input.siteId = req.user.siteId;
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
        return reply
          .code(statusCode)
          .send({ error: linksError.code, message: linksError.message });
      }

      try {
        if (input.id) {
          const [existing] = await app.db
            .select()
            .from(shipments)
            .where(eq(shipments.id, input.id))
            .limit(1);
          if (!existing) {
            await createShipment(app, input, statusId, inspectorId);
          } else {
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
            await updateShipment(app, existing, input, statusId, req.user?.id ?? null);
          }
          if (input.kind === 'transfer') {
            await syncPairedTransferDelivery(app, input.id);
          }
          const dto = await buildShipmentDto(app, input.id, req.user?.role);
          if (!dto) return reply.code(404).send({ error: 'not_found' });
          publishEvent(app, { type: 'shipment_updated', entityId: dto.id, ts: new Date().toISOString() });
          return dto;
        }

        const created = await createShipment(app, input, statusId, inspectorId);
        if (input.kind === 'transfer') {
          await syncPairedTransferDelivery(app, created.id);
        }
        const dto = await buildShipmentDto(app, created.id, req.user?.role);
        if (!dto) throw new Error('Shipment missing after create');
        publishEvent(app, { type: 'shipment_updated', entityId: dto.id, ts: new Date().toISOString() });
        return dto;
      } catch (err) {
        if (err instanceof SourceAlreadyLinkedError) {
          return reply.code(400).send({
            error: 'source_document_already_linked',
            message: 'УПД уже привязана к другой отгрузке',
            details: { sourceDocumentIds: err.sourceDocumentIds },
          });
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
        if (!HARD_DELETE_STATUSES.has(code)) {
          return reply.code(409).send({
            error: 'must_mark_first',
            message: 'Сначала пометьте документ на удаление',
          });
        }
        if (role === 'inspector_kpp') {
          if (!req.user?.siteId || existing.siteId !== req.user.siteId) {
            return reply.code(403).send({ error: 'forbidden' });
          }
        } else if (role !== 'admin' && role !== 'manager') {
          return reply.code(403).send({ error: 'forbidden' });
        }
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

      const photos = await app.db
        .select({ s3Key: shipmentPhotos.s3Key, thumbS3Key: shipmentPhotos.thumbS3Key })
        .from(shipmentPhotos)
        .where(eq(shipmentPhotos.shipmentId, req.params.id));
      for (const p of photos) {
        try {
          await deleteObject(p.s3Key);
          if (p.thumbS3Key) await deleteObject(p.thumbS3Key);
        } catch (err) {
          req.log.warn({ err, s3Key: p.s3Key }, 'failed to delete s3 object');
        }
      }

      // Сохраняем список привязанных УПД до удаления — после CASCADE
      // shipment_sources они будут отвязаны, и updated_at нужно
      // забампать, чтобы /sync вернул УПД в Inbox инспектора.
      const attachedSdIds = (
        await app.db
          .select({ sourceDocumentId: shipmentSources.sourceDocumentId })
          .from(shipmentSources)
          .where(eq(shipmentSources.shipmentId, req.params.id))
      ).map((r: { sourceDocumentId: string }) => r.sourceDocumentId);

      // Журнал hard-delete + физическое удаление одной транзакцией:
      // офлайн-клиент узнаёт об удалении через /sync.deletedIds.
      await app.db.transaction(async (tx) => {
        await tx.insert(entityDeletions).values({
          entityType: 'shipment',
          entityId: existing.id,
          siteId: existing.siteId,
          deletedByUserId: req.user?.id ?? null,
        });
        await tx.delete(shipments).where(eq(shipments.id, req.params.id));
      });
      await touchSourceDocuments(app, attachedSdIds);
      publishEvent(app, {
        type: 'shipment_deleted',
        entityId: req.params.id,
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
      publishEvent(app, { type: 'shipment_updated', entityId: dto.id, ts: new Date().toISOString() });
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
      publishEvent(app, { type: 'shipment_updated', entityId: dto.id, ts: new Date().toISOString() });
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
          if (!SOFT_DELETE_STATUSES.has(code)) {
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
            if (!HARD_DELETE_STATUSES.has(code)) {
              skipped.push({ id, reason: 'must_mark_first' });
              continue;
            }
          }
          const photos = await app.db
            .select({
              s3Key: shipmentPhotos.s3Key,
              thumbS3Key: shipmentPhotos.thumbS3Key,
            })
            .from(shipmentPhotos)
            .where(eq(shipmentPhotos.shipmentId, id));
          for (const p of photos) {
            try {
              await deleteObject(p.s3Key);
              if (p.thumbS3Key) await deleteObject(p.thumbS3Key);
            } catch (s3Err) {
              req.log.warn({ err: s3Err, s3Key: p.s3Key }, 'bulk-hard-delete: s3 delete failed (shipment)');
            }
          }
          const attachedSdIds = (
            await app.db
              .select({ sourceDocumentId: shipmentSources.sourceDocumentId })
              .from(shipmentSources)
              .where(eq(shipmentSources.shipmentId, id))
          ).map((r: { sourceDocumentId: string }) => r.sourceDocumentId);
          await app.db.transaction(async (tx) => {
            await tx.insert(entityDeletions).values({
              entityType: 'shipment',
              entityId: id,
              siteId: existing.siteId,
              deletedByUserId: req.user?.id ?? null,
            });
            await tx.delete(shipments).where(eq(shipments.id, id));
          });
          await touchSourceDocuments(app, attachedSdIds);
          publishEvent(app, {
            type: 'shipment_deleted',
            entityId: id,
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
          .refine(
            (b) => b.inTransit !== undefined || b.isAssets !== undefined,
            { message: 'Минимум одно из полей (inTransit, isAssets) должно быть задано' },
          ),
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
        .where(eq(sourceDocuments.id, req.body.sourceDocumentId))
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
            await tx
              .insert(shipmentSources)
              .values({ shipmentId: s.id, sourceDocumentId: src.id });

            const existingItems: {
              nameRaw: string;
              unit: string;
              qtyPlanned: string | null;
              lineNo: number;
            }[] = await tx
              .select({
                nameRaw: shipmentItems.nameRaw,
                unit: shipmentItems.unit,
                qtyPlanned: shipmentItems.qtyPlanned,
                lineNo: shipmentItems.lineNo,
              })
              .from(shipmentItems)
              .where(eq(shipmentItems.shipmentId, s.id));

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

            const newRows: (typeof shipmentItems.$inferInsert)[] = [];
            let lineNo = startLineNo;
            for (const r of updRows) {
              if (existingKeys.has(buildKey(r.nameRaw, r.unit, r.qty))) {
                continue;
              }
              newRows.push({
                shipmentId: s.id,
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
  const { kind, receiverCounterpartyId, receiverMolId, destSiteId, siteId, sourceDocumentIds } = input;
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
        confirmedByMolAt: now,
      }),
      version: 1,
    })
    .returning();
  if (!created) throw new Error('Failed to insert shipment');
  if (input.items.length) {
    await tx.insert(shipmentItems).values(
      input.items.map((i) => ({
        shipmentId: created.id,
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
    await assertSourcesAvailableForShipment({ db: tx }, input.sourceDocumentIds, created.id);
    try {
      await tx
        .insert(shipmentSources)
        .values(
          input.sourceDocumentIds.map((sid) => ({ shipmentId: created.id, sourceDocumentId: sid })),
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
  const isFirstConfirm =
    input.statusCode === 'confirmed_mol' && existing.confirmedByMolUserId === null;

  // Ручная привязка УПД к отгрузке без документа на портале: клиент шлёт
  // непустой sourceDocumentIds и пустой items — сервер подтягивает позиции
  // из УПД. См. updateDelivery (симметрично).
  const [existingSourcesCount] = await app.db
    .select({ c: drSql<number>`count(*)::int` })
    .from(shipmentSources)
    .where(eq(shipmentSources.shipmentId, id));
  const existingHadNoDocs = (existingSourcesCount?.c ?? 0) === 0;
  const itemsForInsert =
    existingHadNoDocs &&
    input.sourceDocumentIds.length > 0 &&
    input.items.length === 0
      ? await buildShipmentItemsFromSources(app, input.sourceDocumentIds)
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
  // одна транзакция (симметрично updateDelivery).
  return await app.db.transaction(async (tx: typeof app.db) => {
  await tx
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
      ...(isFirstConfirm && {
        confirmedByMolUserId: userId,
        confirmedByMolAt: new Date(),
      }),
      version: drSql`${shipments.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(shipments.id, id));
  await tx.delete(shipmentItems).where(eq(shipmentItems.shipmentId, id));
  if (itemsForInsert.length) {
    await tx.insert(shipmentItems).values(
      itemsForInsert.map((i) => ({ ...i, shipmentId: id })),
    );
  }
  if (input.sourceDocumentIds.length) {
    await assertSourcesAvailableForShipment({ db: tx }, input.sourceDocumentIds, id);
  }
  // Запоминаем какие УПД были привязаны раньше — нужно бампать
  // их updated_at тоже (для УПД, которая отвязывается, видимость
  // в Inbox должна вернуться).
  const previousSources: { sourceDocumentId: string }[] = await tx
    .select({ sourceDocumentId: shipmentSources.sourceDocumentId })
    .from(shipmentSources)
    .where(eq(shipmentSources.shipmentId, id));
  await tx.delete(shipmentSources).where(eq(shipmentSources.shipmentId, id));
  if (input.sourceDocumentIds.length) {
    try {
      await tx
        .insert(shipmentSources)
        .values(input.sourceDocumentIds.map((sid) => ({ shipmentId: id, sourceDocumentId: sid })));
    } catch (err) {
      if (isSourceDocumentUniqueViolation(err)) {
        throw new SourceAlreadyLinkedError(input.sourceDocumentIds);
      }
      throw err;
    }
  }
  // Бамп updated_at для всех затронутых УПД: и для новопривязанных,
  // и для тех, которые отвязались.
  const affected = new Set<string>([
    ...previousSources.map((p) => p.sourceDocumentId),
    ...input.sourceDocumentIds,
  ]);
  await touchSourceDocuments({ db: tx }, [...affected]);
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
