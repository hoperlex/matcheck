import type { FastifyInstance } from 'fastify';
import { desc, eq, gte } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import { SyncDeltaResponseSchema } from '@matcheck/contracts';
import {
  counterparties,
  deliveries,
  deliveryItems,
  deliveryPhotos,
  deliverySources,
  materials,
  sites,
  sourceDocumentAttachments,
  sourceDocumentItems,
  sourceDocuments,
  statuses,
} from '../db/schema.js';

const QuerySchema = z.object({
  since: z.string().datetime().optional(),
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

      const sdRows = await app.db
        .select()
        .from(sourceDocuments)
        .where(since ? gte(sourceDocuments.updatedAt, since) : undefined)
        .orderBy(desc(sourceDocuments.updatedAt))
        .limit(200);

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

      const inspectorOnly = req.user?.role === 'inspector_kpp';
      const inspectorId = req.user?.id;
      const dRowsJoined = await app.db
        .select({ d: deliveries, s: statuses })
        .from(deliveries)
        .innerJoin(statuses, eq(deliveries.statusId, statuses.id))
        .where(
          inspectorOnly && inspectorId
            ? since
              ? eqAnd(deliveries.inspectorId, inspectorId, gte(deliveries.updatedAt, since))
              : eq(deliveries.inspectorId, inspectorId)
            : since
              ? gte(deliveries.updatedAt, since)
              : undefined,
        )
        .orderBy(desc(deliveries.updatedAt))
        .limit(500);
      const dRows = dRowsJoined.map((r) => ({ ...r.d, _status: r.s }));
      const dIds = dRows.map((r) => r.id);
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

      return {
        cursor: new Date().toISOString(),
        serverNow: new Date().toISOString(),
        counterparties: cpRows.map((c) => ({
          id: c.id,
          inn: c.inn,
          kpp: c.kpp,
          name: c.name,
          address: c.address,
          isSelf: c.isSelf,
          isSupplier: c.isSupplier,
          isCustomer: c.isCustomer,
          isCarrier: c.isCarrier,
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
        sourceDocuments: sdRows.map((sd) => ({
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
        })),
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
          vehiclePlate: d.vehiclePlate,
          driverName: d.driverName,
          arrivedAt: d.arrivedAt?.toISOString() ?? null,
          inspectorId: d.inspectorId,
          comment: d.comment,
          version: d.version,
          sourceDocumentIds: dSources
            .filter((s) => s.deliveryId === d.id)
            .map((s) => s.sourceDocumentId),
          items: dItems
            .filter((i) => i.deliveryId === d.id)
            .map((i) => ({
              id: i.id,
              materialId: i.materialId,
              nameRaw: i.nameRaw,
              qtyPlanned: i.qtyPlanned,
              qtyActual: i.qtyActual,
              unit: i.unit,
              comment: i.comment,
              lineNo: i.lineNo,
              volumeM3: i.volumeM3,
              massKg: i.massKg,
              volumeConfidence: i.volumeConfidence as 'low' | 'medium' | 'high' | null,
              groupName: i.groupName,
            })),
          photos: dPhotos
            .filter((p) => p.deliveryId === d.id)
            .map((p) => ({
              id: p.id,
              kind: p.kind,
              s3Key: p.s3Key,
              thumbS3Key: p.thumbS3Key,
              contentHash: p.contentHash,
              takenAt: p.takenAt.toISOString(),
            })),
          createdAt: d.createdAt.toISOString(),
          updatedAt: d.updatedAt.toISOString(),
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
