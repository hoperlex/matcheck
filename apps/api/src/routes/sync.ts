import type { FastifyInstance } from 'fastify';
import { desc, eq, gte, sql as drSql } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import { SyncDeltaResponseSchema } from '@matcheck/contracts';
import {
  assets,
  counterparties,
  deliveries,
  deliveryItems,
  deliveryPhotos,
  deliverySources,
  entityDeletions,
  materials,
  responsiblePersons,
  shipments,
  shipmentItems,
  shipmentPhotos,
  shipmentSources,
  sites,
  sourceDocumentAttachments,
  sourceDocumentItems,
  sourceDocuments,
  statuses,
  users,
} from '../db/schema.js';

const QuerySchema = z.object({
  since: z.string().datetime().optional(),
  // Окно (в днях) для initial-sync: deliveries/shipments/sourceDocuments
  // отдаются за последние N дней. Default 90. При since != null игнорируется
  // (старые записи могли поменяться, дельта-sync их захватывает).
  windowDays: z.coerce.number().int().min(1).max(365).optional(),
});

export async function syncRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);
  app.get(
    '/api/v1/sync',
    {
      preHandler: [app.authenticate],
      schema: { querystring: QuerySchema, response: { 200: SyncDeltaResponseSchema } },
    },
    async (req) => {
      const since = req.query.since ? new Date(req.query.since) : null;
      const windowDays = req.query.windowDays ?? 90;
      // effectiveSince — для deliveries/shipments/sourceDocuments:
      //  - при дельта-sync (since != null): since;
      //  - при initial-sync (since == null): now - windowDays days.
      // Справочники (counterparties/materials/sites/statuses) окно не применяют —
      // они полностью нужны клиенту независимо от дат.
      const effectiveSince = since ?? new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
      const inspectorOnly = req.user?.role === 'inspector_kpp';
      const userSiteId = req.user?.siteId ?? null;

      // Инспектор без привязки к объекту не должен видеть никаких данных —
      // это явная ошибка конфигурации, а не "доступ ко всему".
      if (inspectorOnly && !userSiteId) {
        const now = new Date().toISOString();
        return {
          cursor: now,
          serverNow: now,
          counterparties: [],
          materials: [],
          responsiblePersons: [],
          assets: [],
          sites: [],
          statuses: [],
          sourceDocuments: [],
          deliveries: [],
          shipments: [],
          deletedIds: {
            deliveries: [],
            shipments: [],
            sourceDocuments: [],
            responsiblePersons: [],
            assets: [],
          },
        };
      }

      const cpRows = await app.db
        .select()
        .from(counterparties)
        .where(since ? gte(counterparties.updatedAt, since) : undefined)
        .orderBy(desc(counterparties.updatedAt))
        .limit(500);
      const matRows = await app.db
        .select()
        .from(materials)
        .where(since ? gte(materials.updatedAt, since) : undefined)
        .orderBy(desc(materials.updatedAt))
        .limit(500);
      const siteRows = await app.db
        .select()
        .from(sites)
        .where(since ? gte(sites.updatedAt, since) : undefined)
        .orderBy(desc(sites.updatedAt))
        .limit(500);
      // Статусы (entity_type='delivery'|'shipment'|…) клиент использует для UI:
      // лейбл, цвет, sortOrder. Меняются редко — отдаём всегда без фильтра.
      const statusRows = await app.db
        .select()
        .from(statuses)
        .orderBy(statuses.entityType, statuses.sortOrder);

      // Источниковые документы: для inspector_kpp фильтруем только по siteId.
      // Раньше тут был дополнительный фильтр not_exists (отдавать только не
      // привязанные УПД), но он ломал зеркало «портал ↔ мобила»: после
      // привязки УПД к приёмке на портале её `updated_at` не менялся,
      // в дельту /sync она не попадала, и Inbox инспектора залипал
      // фантомами до logout/login. Теперь:
      //   1) При INSERT/DELETE в delivery_sources/shipment_sources сервер
      //      бампает source_documents.updated_at (см. domain/sourceDocuments/touch.ts).
      //   2) /sync отдаёт инспектору ВСЕ УПД сайта в окне.
      //   3) Мобила фильтрует Inbox локально по своему junction-кэшу
      //      (см. IntakeUpdSelectViewModel — фильтр attachedIds), который
      //      синхронизируется через deliveries[].sourceDocumentIds.
      // Limit поднят до 1000 — на активном сайте инспектор после долгого
      // оффлайна может получить большую дельту, 200 обрезало бы важное.
      const sdWhereParts = [gte(sourceDocuments.updatedAt, effectiveSince)];
      if (inspectorOnly && userSiteId) {
        sdWhereParts.push(eq(sourceDocuments.siteId, userSiteId));
      }
      const sdRows = await app.db
        .select()
        .from(sourceDocuments)
        .where(drAnd(...sdWhereParts))
        .orderBy(desc(sourceDocuments.updatedAt))
        .limit(1000);

      const sdIds = sdRows.map((r) => r.id);
      const sdItemRows = sdIds.length
        ? await app.db
            .select()
            .from(sourceDocumentItems)
            .where(sql_in(sourceDocumentItems.sourceDocumentId, sdIds))
        : [];
      const sdAttachRows = sdIds.length
        ? await app.db
            .select()
            .from(sourceDocumentAttachments)
            .where(sql_in(sourceDocumentAttachments.sourceDocumentId, sdIds))
        : [];

      // Контакт автора УПД — нужен мобильному клиенту для кнопки звонка
      // в шапке списка материалов на 1 Этапе. Один SELECT по уникальным
      // userId'ам, чтобы не делать N+1. EDO/mail-полученные УПД имеют
      // createdByUserId = null — пропускаются.
      const sdCreatorIds = Array.from(
        new Set(sdRows.map((r) => r.createdByUserId).filter((v): v is string => !!v)),
      );
      const sdCreators = sdCreatorIds.length
        ? await app.db
            .select({ id: users.id, email: users.email, phone: users.phone })
            .from(users)
            .where(sql_in(users.id, sdCreatorIds))
        : [];
      const sdCreatorById = new Map(sdCreators.map((u) => [u.id, u]));

      // Инспектор видит всё в рамках своего объекта (включая записи других
      // инспекторов на том же siteId) — синхронизировано с GET /deliveries,
      // см. коммит 1833b9d. До этого фильтр был по inspectorId.
      // Окно effectiveSince применяется и при initial-sync (windowDays), и при
      // дельта-sync (since).
      const dRowsJoined = await app.db
        .select({ d: deliveries, s: statuses, molEmail: users.email })
        .from(deliveries)
        .innerJoin(statuses, eq(deliveries.statusId, statuses.id))
        .leftJoin(users, eq(deliveries.confirmedByMolUserId, users.id))
        .where(
          inspectorOnly && userSiteId
            ? eqAnd(deliveries.siteId, userSiteId, gte(deliveries.updatedAt, effectiveSince))
            : gte(deliveries.updatedAt, effectiveSince),
        )
        .orderBy(desc(deliveries.updatedAt))
        .limit(500);
      const dRows = dRowsJoined.map((r) => ({ ...r.d, _status: r.s, _molEmail: r.molEmail }));
      const dIds = dRows.map((r) => r.id);

      // Для парных приёмок (transfer) подтягиваем плоско дату отгрузки и
      // объект-источник из связанного shipment + sites — это то, что показывает
      // KppPage в шапке вместо «УПД №…».
      const srcShipmentIds = dRows
        .map((d) => d.sourceShipmentId)
        .filter((id): id is string => id !== null);
      const srcShipmentRows = srcShipmentIds.length
        ? await app.db
            .select({
              id: shipments.id,
              shippedAt: shipments.shippedAt,
              siteId: shipments.siteId,
              siteCode: sites.code,
            })
            .from(shipments)
            .leftJoin(sites, eq(shipments.siteId, sites.id))
            .where(sql_in(shipments.id, srcShipmentIds))
        : [];
      const srcShipmentById = new Map<
        string,
        { shippedAt: Date | null; siteId: string; siteCode: string | null }
      >();
      for (const r of srcShipmentRows) {
        srcShipmentById.set(r.id, {
          shippedAt: r.shippedAt,
          siteId: r.siteId,
          siteCode: r.siteCode,
        });
      }

      const dItems = dIds.length
        ? await app.db.select().from(deliveryItems).where(sql_in(deliveryItems.deliveryId, dIds))
        : [];
      const dPhotos = dIds.length
        ? await app.db.select().from(deliveryPhotos).where(sql_in(deliveryPhotos.deliveryId, dIds))
        : [];
      const dSources = dIds.length
        ? await app.db
            .select()
            .from(deliverySources)
            .where(sql_in(deliverySources.deliveryId, dIds))
        : [];

      // ── Shipments (симметрично deliveries: видимость по siteId + окно) ──
      const shRowsJoined = await app.db
        .select({ s: shipments, st: statuses, molEmail: users.email })
        .from(shipments)
        .innerJoin(statuses, eq(shipments.statusId, statuses.id))
        .leftJoin(users, eq(shipments.confirmedByMolUserId, users.id))
        .where(
          inspectorOnly && userSiteId
            ? eqAnd(shipments.siteId, userSiteId, gte(shipments.updatedAt, effectiveSince))
            : gte(shipments.updatedAt, effectiveSince),
        )
        .orderBy(desc(shipments.updatedAt))
        .limit(500);
      const shRows = shRowsJoined.map((r) => ({ ...r.s, _status: r.st, _molEmail: r.molEmail }));
      const shIds = shRows.map((r) => r.id);
      const shItems = shIds.length
        ? await app.db.select().from(shipmentItems).where(sql_in(shipmentItems.shipmentId, shIds))
        : [];
      const shPhotos = shIds.length
        ? await app.db
            .select()
            .from(shipmentPhotos)
            .where(sql_in(shipmentPhotos.shipmentId, shIds))
        : [];
      const shSources = shIds.length
        ? await app.db
            .select()
            .from(shipmentSources)
            .where(sql_in(shipmentSources.shipmentId, shIds))
        : [];

      // ── deletedIds (журнал hard-delete для офлайн-клиента) ──
      // Возвращаем только при дельта-sync (since != null) — на initial-sync
      // клиент стартует с нуля, история удалений не нужна. Для inspector_kpp
      // фильтр по siteId работает только для документов с siteId. Глобальные
      // справочники (МОЛ/ОС) удаляются без siteId — их клиент видит независимо
      // от роли.
      const deletedDeliveryIds: string[] = [];
      const deletedShipmentIds: string[] = [];
      const deletedSourceDocumentIds: string[] = [];
      const deletedResponsiblePersonIds: string[] = [];
      const deletedAssetIds: string[] = [];
      if (since) {
        // 1) Site-scoped удаления (deliveries/shipments/source_documents).
        const siteScoped = await app.db
          .select({ entityType: entityDeletions.entityType, entityId: entityDeletions.entityId })
          .from(entityDeletions)
          .where(
            inspectorOnly && userSiteId
              ? eqAnd(
                  entityDeletions.siteId,
                  userSiteId,
                  gte(entityDeletions.deletedAt, since),
                )
              : gte(entityDeletions.deletedAt, since),
          );
        for (const r of siteScoped) {
          if (r.entityType === 'delivery') deletedDeliveryIds.push(r.entityId);
          else if (r.entityType === 'shipment') deletedShipmentIds.push(r.entityId);
          else if (r.entityType === 'source_document')
            deletedSourceDocumentIds.push(r.entityId);
        }
        // 2) Глобальные справочники (siteId IS NULL) — независимо от роли.
        const globalDel = await app.db
          .select({ entityType: entityDeletions.entityType, entityId: entityDeletions.entityId })
          .from(entityDeletions)
          .where(
            drAnd(
              drSql`${entityDeletions.siteId} is null`,
              gte(entityDeletions.deletedAt, since),
            ),
          );
        for (const r of globalDel) {
          if (r.entityType === 'responsible_person')
            deletedResponsiblePersonIds.push(r.entityId);
          else if (r.entityType === 'asset') deletedAssetIds.push(r.entityId);
        }
      }

      // Справочники МОЛ/ОС — дельта по updatedAt; для initial-sync (since=null)
      // отдаём все записи.
      const respPersonRows = await app.db
        .select()
        .from(responsiblePersons)
        .where(since ? gte(responsiblePersons.updatedAt, since) : undefined)
        .orderBy(desc(responsiblePersons.updatedAt))
        .limit(500);
      const assetRows = await app.db
        .select()
        .from(assets)
        .where(since ? gte(assets.updatedAt, since) : undefined)
        .orderBy(desc(assets.updatedAt))
        .limit(500);

      return {
        cursor: new Date().toISOString(),
        serverNow: new Date().toISOString(),
        deletedIds: {
          deliveries: deletedDeliveryIds,
          shipments: deletedShipmentIds,
          sourceDocuments: deletedSourceDocumentIds,
          responsiblePersons: deletedResponsiblePersonIds,
          assets: deletedAssetIds,
        },
        counterparties: cpRows.map((c) => ({
          id: c.id,
          inn: c.inn,
          kpp: c.kpp,
          name: c.name,
          address: c.address,
          isSelf: c.isSelf,
          isSupplier: c.isSupplier,
          isCustomer: c.isCustomer,
          isContractor: c.isContractor,
          createdAt: c.createdAt.toISOString(),
          updatedAt: c.updatedAt.toISOString(),
        })),
        materials: matRows.map((m) => ({
          id: m.id,
          code: m.code,
          name: m.name,
          unit: m.unit,
          createdAt: m.createdAt.toISOString(),
          updatedAt: m.updatedAt.toISOString(),
        })),
        responsiblePersons: respPersonRows.map((r) => ({
          id: r.id,
          fullName: r.fullName,
          phone: r.phone,
          position: r.position,
          isActive: r.isActive,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        })),
        assets: assetRows.map((a) => ({
          id: a.id,
          code: a.code,
          name: a.name,
          unit: a.unit,
          isActive: a.isActive,
          createdAt: a.createdAt.toISOString(),
          updatedAt: a.updatedAt.toISOString(),
        })),
        sites: siteRows.map((s) => ({
          id: s.id,
          code: s.code,
          name: s.name,
          fullName: s.fullName,
          address: s.address,
          isActive: s.isActive,
          createdAt: s.createdAt.toISOString(),
          updatedAt: s.updatedAt.toISOString(),
        })),
        statuses: statusRows.map((st) => ({
          id: st.id,
          entityType: st.entityType,
          code: st.code,
          label: st.label,
          color: st.color,
          sortOrder: st.sortOrder,
        })),
        sourceDocuments: sdRows.map((sd) => {
          const creator = sd.createdByUserId ? sdCreatorById.get(sd.createdByUserId) : null;
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
          createdByUserId: sd.createdByUserId,
          createdByUserEmail: creator?.email ?? null,
          createdByUserPhone: creator?.phone ?? null,
          items: sdItemRows
            .filter((i) => i.sourceDocumentId === sd.id)
            .map((i) => ({
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
            })),
          attachments: sdAttachRows
            .filter((a) => a.sourceDocumentId === sd.id)
            .map((a) => ({
              id: a.id,
              s3Key: a.s3Key,
              filename: a.filename,
              mimeType: a.mimeType,
              sizeBytes: a.sizeBytes,
              role: a.role,
            })),
          };
        }),
        deliveries: dRows.map((d) => ({
          id: d.id,
          status: {
            id: d._status.id,
            entityType: d._status.entityType,
            code: d._status.code,
            label: d._status.label,
            color: d._status.color,
            sortOrder: d._status.sortOrder,
          },
          siteId: d.siteId,
          supplierId: d.supplierId,
          contractorId: d.contractorId,
          recipientMolId: d.recipientMolId,
          vehiclePlate: d.vehiclePlate,
          driverName: d.driverName,
          arrivedAt: d.arrivedAt?.toISOString() ?? null,
          inspectorId: d.inspectorId,
          comment: d.comment,
          inTransit: d.inTransit,
          confirmedByMolUserId: d.confirmedByMolUserId,
          confirmedByMolUserEmail: d._molEmail,
          confirmedByMolAt: d.confirmedByMolAt?.toISOString() ?? null,
          // Soft-delete: email автора пометки в sync не подтягиваем (опциональный
          // join усложнил бы запрос), офлайн-клиент покажет адрес как «—».
          pendingDeletionAt: d.pendingDeletionAt?.toISOString() ?? null,
          pendingDeletionByUserId: d.pendingDeletionByUserId,
          pendingDeletionByUserEmail: null,
          pendingDeletionReason: d.pendingDeletionReason,
          version: d.version,
          sourceDocumentIds: dSources
            .filter((s) => s.deliveryId === d.id)
            .map((s) => s.sourceDocumentId),
          sourceShipmentId: d.sourceShipmentId,
          sourceShipmentShippedAt:
            (d.sourceShipmentId ? srcShipmentById.get(d.sourceShipmentId)?.shippedAt : null)?.toISOString() ??
            null,
          sourceShipmentSiteId:
            (d.sourceShipmentId ? srcShipmentById.get(d.sourceShipmentId)?.siteId : null) ?? null,
          sourceShipmentSiteCode:
            (d.sourceShipmentId ? srcShipmentById.get(d.sourceShipmentId)?.siteCode : null) ?? null,
          items: dItems
            .filter((i) => i.deliveryId === d.id)
            .map((i) => ({
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
          photos: dPhotos
            .filter((p) => p.deliveryId === d.id)
            .map((p) => ({
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
        })),
        shipments: shRows.map((s) => ({
          id: s.id,
          status: {
            id: s._status.id,
            entityType: s._status.entityType,
            code: s._status.code,
            label: s._status.label,
            color: s._status.color,
            sortOrder: s._status.sortOrder,
          },
          kind: s.kind,
          purpose: s.purpose,
          inTransit: s.inTransit,
          siteId: s.siteId,
          receiverCounterpartyId: s.receiverCounterpartyId,
          receiverMolId: s.receiverMolId,
          destSiteId: s.destSiteId,
          supplierId: s.supplierId,
          vehiclePlate: s.vehiclePlate,
          driverName: s.driverName,
          shippedAt: s.shippedAt?.toISOString() ?? null,
          inspectorId: s.inspectorId,
          comment: s.comment,
          confirmedByMolUserId: s.confirmedByMolUserId,
          confirmedByMolUserEmail: s._molEmail,
          confirmedByMolAt: s.confirmedByMolAt?.toISOString() ?? null,
          pendingDeletionAt: s.pendingDeletionAt?.toISOString() ?? null,
          pendingDeletionByUserId: s.pendingDeletionByUserId,
          pendingDeletionByUserEmail: null,
          pendingDeletionReason: s.pendingDeletionReason,
          version: s.version,
          sourceDocumentIds: shSources
            .filter((x) => x.shipmentId === s.id)
            .map((x) => x.sourceDocumentId),
          items: shItems
            .filter((i) => i.shipmentId === s.id)
            .map((i) => ({
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
          photos: shPhotos
            .filter((p) => p.shipmentId === s.id)
            .map((p) => ({
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
        })),
      };
    },
  );
}

import { and as drAnd, inArray, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

function sql_in<T extends AnyPgColumn>(col: T, ids: string[]) {
  return inArray(col, ids);
}
function eqAnd<T extends AnyPgColumn>(col: T, val: string, more: SQL): SQL {
  return drAnd(eq(col, val), more)!;
}
