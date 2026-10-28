import { and, asc, count, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type {
  DeliverySupplierOrder,
  EstimatOrderContractor,
  SupplierOrderCandidate,
} from '@matcheck/contracts';
import type { Db } from '../../db/client.js';
import {
  counterparties,
  deliveries,
  deliverySources,
  deliverySupplierOrders,
  estimatSupplierOrderEvents,
  estimatSupplierOrders,
  sites,
  sourceDocuments,
  suppliers,
} from '../../db/schema.js';
import { loadOwnInns } from '../sourceDocuments/supplier-inn-check.js';
import { innDigits } from './estimat.types.js';
import { linkedDeliveriesCountSql, loadLastRevokedAt, orderSearchSql, toSummary } from './orders-read.js';

/**
 * ИНН сторон приёмки — наборами из всех источников.
 *
 * deliveries.supplier_id заполнен редко: привязка УПД его не трогает
 * (routes/deliveries.ts, link-source), и поставщик живёт в документе. Поэтому
 * поставщик — своё поле плюс поставщик каждого связанного документа тем же
 * COALESCE, что в сборке DTO; подрядчик — получатель приёмки плюс покупатель и
 * грузополучатель документов (как у подсказки получателя), без своих ИНН.
 */
export type PartyInns = { supplierInns: Set<string>; contractorInns: Set<string> };

export async function loadDeliveryPartyInns(db: Db, deliveryId: string): Promise<PartyInns> {
  const ownSupplier = alias(counterparties, 'own_supplier');
  const ownContractor = alias(counterparties, 'own_contractor');
  const docSupplier = alias(counterparties, 'doc_supplier');
  const docBuyer = alias(counterparties, 'doc_buyer');
  const docConsignee = alias(counterparties, 'doc_consignee');
  const [own, docs, ownInns] = await Promise.all([
    db
      .select({ supplierInn: ownSupplier.inn, contractorInn: ownContractor.inn })
      .from(deliveries)
      .leftJoin(ownSupplier, eq(ownSupplier.id, deliveries.supplierId))
      .leftJoin(ownContractor, eq(ownContractor.id, deliveries.contractorId))
      .where(eq(deliveries.id, deliveryId))
      .limit(1),
    db
      .select({
        supplierInn: sql<string | null>`COALESCE(NULLIF(BTRIM(${sourceDocuments.supplierInnRaw}), ''), NULLIF(BTRIM(${suppliers.inn}), ''), NULLIF(BTRIM(${docSupplier.inn}), ''))`,
        buyerInn: sql<string | null>`COALESCE(NULLIF(BTRIM(${sourceDocuments.buyerInnRaw}), ''), NULLIF(BTRIM(${docBuyer.inn}), ''))`,
        consigneeInn: sql<string | null>`COALESCE(NULLIF(BTRIM(${sourceDocuments.consigneeInnRaw}), ''), NULLIF(BTRIM(${docConsignee.inn}), ''))`,
      })
      .from(deliverySources)
      .innerJoin(sourceDocuments, eq(sourceDocuments.id, deliverySources.sourceDocumentId))
      .leftJoin(suppliers, eq(suppliers.id, sourceDocuments.supplierDirectoryId))
      .leftJoin(docSupplier, eq(docSupplier.id, sourceDocuments.supplierId))
      .leftJoin(docBuyer, eq(docBuyer.id, sourceDocuments.buyerId))
      .leftJoin(docConsignee, eq(docConsignee.id, sourceDocuments.consigneeId))
      .where(eq(deliverySources.deliveryId, deliveryId)),
    loadOwnInns(db),
  ]);
  const supplierInns = new Set<string>();
  const contractorInns = new Set<string>();
  const add = (set: Set<string>, raw: string | null | undefined) => {
    const inn = innDigits(raw);
    if (inn && !ownInns.has(inn)) set.add(inn);
  };
  add(supplierInns, own[0]?.supplierInn);
  add(contractorInns, own[0]?.contractorInn);
  for (const d of docs) {
    add(supplierInns, d.supplierInn);
    add(contractorInns, d.buyerInn);
    add(contractorInns, d.consigneeInn);
  }
  return { supplierInns, contractorInns };
}

/**
 * Совпадение сторон заказа со сторонами приёмки. null — сравнивать не с чем
 * (у приёмки или у заказа нет ИНН этой стороны): отсутствие ИНН ≠ несовпадение.
 */
export function matchFlags(
  order: { supplierInn: string | null; contractors: readonly EstimatOrderContractor[] },
  inns: PartyInns,
): { supplierMatch: boolean | null; contractorMatch: boolean | null } {
  const orderSupplier = innDigits(order.supplierInn);
  const supplierMatch =
    inns.supplierInns.size === 0 || !orderSupplier ? null : inns.supplierInns.has(orderSupplier);
  const orderContractors = order.contractors.map((c) => innDigits(c.inn)).filter((v): v is string => !!v);
  const contractorMatch =
    inns.contractorInns.size === 0 || orderContractors.length === 0
      ? null
      : orderContractors.some((inn) => inns.contractorInns.has(inn));
  return { supplierMatch, contractorMatch };
}

/** Заказы, привязанные к приёмке. */
export async function listDeliveryOrders(db: Db, deliveryId: string): Promise<DeliverySupplierOrder[]> {
  const o = estimatSupplierOrders;
  const rows = await db
    .select({
      order: o,
      siteCode: sites.code,
      linkedAt: deliverySupplierOrders.linkedAt,
      siteMismatch: deliverySupplierOrders.siteMismatch,
    })
    .from(deliverySupplierOrders)
    .innerJoin(o, eq(o.id, deliverySupplierOrders.orderId))
    .leftJoin(sites, eq(sites.id, o.siteId))
    .where(eq(deliverySupplierOrders.deliveryId, deliveryId))
    .orderBy(asc(deliverySupplierOrders.linkedAt), asc(o.id));
  if (rows.length === 0) return [];
  const [inns, revoked] = await Promise.all([
    loadDeliveryPartyInns(db, deliveryId),
    loadLastRevokedAt(db, rows.map((r) => r.order.id)),
  ]);
  return rows.map((r) => ({
    ...toSummary(r.order, { siteCode: r.siteCode, lastApprovalRevokedAt: revoked.get(r.order.id) ?? null }),
    linkedAt: r.linkedAt.toISOString(),
    siteMismatch: r.siteMismatch,
    ...matchFlags(r.order, inns),
  }));
}

/** Стадии, которые подбор показывает без «Все стадии»: живые и отмена в процессе. */
const DEFAULT_CANDIDATE_STAGES = ['forming', 'sourcing', 'approval', 'awarded', 'recorded', 'cancel_pending'];

export type CandidateQuery = {
  deliveryId: string;
  deliverySiteId: string;
  q?: string;
  allSites: boolean;
  allStages: boolean;
  limit: number;
  offset: number;
};

/** Список ИНН одной строкой: postgres.js на свежем соединении сериализует массивы строкой. */
const innCsv = (set: Set<string>) => [...set].join(',');

/**
 * Окно подбора. Совпадения сторон влияют только на порядок и метки — подбор
 * ничего не скрывает, кроме удалённых в EstiMat (их привязать нельзя).
 */
export async function findCandidates(
  db: Db,
  query: CandidateQuery,
): Promise<{ items: SupplierOrderCandidate[]; total: number }> {
  const o = estimatSupplierOrders;
  const inns = await loadDeliveryPartyInns(db, query.deliveryId);
  const supplierCsv = innCsv(inns.supplierInns);
  const contractorCsv = innCsv(inns.contractorInns);

  const conds: SQL[] = [isNull(o.deletedAt)];
  if (!query.allSites) conds.push(eq(o.siteId, query.deliverySiteId));
  if (!query.allStages) conds.push(inArray(o.sourcingStatus, DEFAULT_CANDIDATE_STAGES));
  const search = query.q ? orderSearchSql(query.q) : undefined;
  if (search) conds.push(search);
  const where = and(...conds);

  const supplierMatchSql = sql<boolean>`coalesce(${o.supplierInn} = any(string_to_array(${supplierCsv}, ',')), false)`;
  const contractorMatchSql = sql<boolean>`exists (
    select 1 from jsonb_array_elements(${o.contractors}) c
    where regexp_replace(coalesce(c->>'inn', ''), '\\D', '', 'g') = any(string_to_array(${contractorCsv}, ','))
  )`;
  const stageRankSql = sql<number>`case when ${o.sourcingStatus} in ('awarded', 'recorded') then 0 else 1 end`;
  const linkedSql = sql<boolean>`exists (
    select 1 from ${deliverySupplierOrders}
    where ${deliverySupplierOrders.orderId} = ${o.id} and ${deliverySupplierOrders.deliveryId} = ${query.deliveryId}
  )`;

  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        order: o,
        siteCode: sites.code,
        linked: linkedSql,
        linkedDeliveriesCount: linkedDeliveriesCountSql,
      })
      .from(o)
      .leftJoin(sites, eq(sites.id, o.siteId))
      .where(where)
      .orderBy(
        sql`${supplierMatchSql} desc`,
        sql`${contractorMatchSql} desc`,
        stageRankSql,
        sql`${o.supplyApprovedAt} desc nulls last`,
        sql`${o.estimatCreatedAt} desc nulls last`,
        asc(o.id),
      )
      .limit(query.limit)
      .offset(query.offset),
    db.select({ n: count() }).from(o).where(where),
  ]);
  const revoked = await loadLastRevokedAt(db, rows.map((r) => r.order.id));
  return {
    items: rows.map((r) => ({
      ...toSummary(r.order, { siteCode: r.siteCode, lastApprovalRevokedAt: revoked.get(r.order.id) ?? null }),
      ...matchFlags(r.order, inns),
      siteMatch: r.order.siteId !== null && r.order.siteId === query.deliverySiteId,
      linked: Boolean(r.linked),
      linkedDeliveriesCount: Number(r.linkedDeliveriesCount ?? 0),
    })),
    total: Number(totalRow?.n ?? 0),
  };
}

// ─── Привязка и отвязка ─────────────────────────────────────────────────────

export type LinkResult =
  | { ok: true; inserted: boolean; siteId: string }
  | { ok: false; status: 404; error: 'not_found' | 'order_not_found' }
  | { ok: false; status: 409; error: 'pending_deletion' | 'transfer_pair' | 'order_deleted'; message: string }
  | {
      ok: false;
      status: 409;
      error: 'site_mismatch';
      message: string;
      orderSiteCode: string | null;
      projectCode: string | null;
      deliverySiteCode: string | null;
    };

/**
 * Привязать заказ к приёмке. Порядок блокировок — сначала приёмка (как у
 * link-source и привязки ЭДО), потом заказ:
 *  - приёмка FOR NO KEY UPDATE: конфликтует с UPDATE пометки на удаление, так что
 *    проверка pending_deletion и вставка атомарны;
 *  - заказ FOR SHARE: конфликтует с UPDATE пометки «удалён в EstiMat».
 * deliveries.version/updated_at не меняются — мобильный клиент связь не видит.
 */
export async function linkOrder(
  db: Db,
  input: { deliveryId: string; orderId: string; userId: string | null; confirmSiteMismatch: boolean },
): Promise<LinkResult> {
  return db.transaction(async (tx) => {
    const [delivery] = await tx
      .select({
        id: deliveries.id,
        siteId: deliveries.siteId,
        displayId: deliveries.displayId,
        pendingDeletionAt: deliveries.pendingDeletionAt,
        sourceShipmentId: deliveries.sourceShipmentId,
      })
      .from(deliveries)
      .where(eq(deliveries.id, input.deliveryId))
      .for('no key update');
    if (!delivery) return { ok: false, status: 404, error: 'not_found' } as const;
    if (delivery.pendingDeletionAt !== null) {
      return {
        ok: false,
        status: 409,
        error: 'pending_deletion',
        message: 'Приёмка помечена на удаление — привязать заказ нельзя',
      } as const;
    }
    if (delivery.sourceShipmentId !== null) {
      return {
        ok: false,
        status: 409,
        error: 'transfer_pair',
        message: 'Приёмка перемещения — заказ поставщику к ней не относится',
      } as const;
    }

    const [order] = await tx
      .select({
        id: estimatSupplierOrders.id,
        siteId: estimatSupplierOrders.siteId,
        projectCode: estimatSupplierOrders.projectCode,
        deletedAt: estimatSupplierOrders.deletedAt,
      })
      .from(estimatSupplierOrders)
      .where(eq(estimatSupplierOrders.id, input.orderId))
      .for('share');
    if (!order) return { ok: false, status: 404, error: 'order_not_found' } as const;
    if (order.deletedAt !== null) {
      return {
        ok: false,
        status: 409,
        error: 'order_deleted',
        message: 'Заказ удалён в EstiMat — привязать его нельзя',
      } as const;
    }

    const siteMismatch = order.siteId !== delivery.siteId;
    if (siteMismatch && !input.confirmSiteMismatch) {
      const codes = await tx
        .select({ id: sites.id, code: sites.code })
        .from(sites)
        .where(inArray(sites.id, [delivery.siteId, ...(order.siteId ? [order.siteId] : [])]));
      const codeOf = (id: string | null) => (id ? (codes.find((s) => s.id === id)?.code ?? null) : null);
      const orderSiteCode = codeOf(order.siteId);
      const deliverySiteCode = codeOf(delivery.siteId);
      return {
        ok: false,
        status: 409,
        error: 'site_mismatch',
        message: order.siteId
          ? `Заказ для объекта ${orderSiteCode ?? '—'}, приёмка — на объекте ${deliverySiteCode ?? '—'}`
          : `Объект заказа (${order.projectCode ?? 'без кода'}) не найден в портале, приёмка — на объекте ${deliverySiteCode ?? '—'}`,
        orderSiteCode,
        projectCode: order.projectCode,
        deliverySiteCode,
      } as const;
    }

    const inserted = await tx
      .insert(deliverySupplierOrders)
      .values({
        deliveryId: delivery.id,
        orderId: order.id,
        linkedByUserId: input.userId,
        siteMismatch,
      })
      .onConflictDoNothing()
      .returning({ orderId: deliverySupplierOrders.orderId });
    if (inserted.length) {
      await tx.insert(estimatSupplierOrderEvents).values({
        orderId: order.id,
        kind: 'delivery_linked',
        deliveryId: delivery.id,
        userId: input.userId,
        details: { deliveryDisplayId: delivery.displayId, ...(siteMismatch ? { siteMismatch: true } : {}) },
      });
    }
    return { ok: true, inserted: inserted.length > 0, siteId: delivery.siteId } as const;
  });
}

export type UnlinkResult =
  | { ok: true; deleted: boolean; siteId: string }
  | { ok: false; status: 404; error: 'not_found' }
  | { ok: false; status: 409; error: 'pending_deletion'; message: string };

/** Отвязать заказ. Та же блокировка приёмки, что у привязки. Повтор — 200 без события. */
export async function unlinkOrder(
  db: Db,
  input: { deliveryId: string; orderId: string; userId: string | null },
): Promise<UnlinkResult> {
  return db.transaction(async (tx) => {
    const [delivery] = await tx
      .select({
        id: deliveries.id,
        siteId: deliveries.siteId,
        displayId: deliveries.displayId,
        pendingDeletionAt: deliveries.pendingDeletionAt,
      })
      .from(deliveries)
      .where(eq(deliveries.id, input.deliveryId))
      .for('no key update');
    if (!delivery) return { ok: false, status: 404, error: 'not_found' } as const;
    if (delivery.pendingDeletionAt !== null) {
      return {
        ok: false,
        status: 409,
        error: 'pending_deletion',
        message: 'Приёмка помечена на удаление — отвязать заказ нельзя',
      } as const;
    }
    const deleted = await tx
      .delete(deliverySupplierOrders)
      .where(
        and(
          eq(deliverySupplierOrders.deliveryId, delivery.id),
          eq(deliverySupplierOrders.orderId, input.orderId),
        ),
      )
      .returning({ orderId: deliverySupplierOrders.orderId });
    if (deleted.length) {
      await tx.insert(estimatSupplierOrderEvents).values({
        orderId: input.orderId,
        kind: 'delivery_unlinked',
        deliveryId: delivery.id,
        userId: input.userId,
        details: { deliveryDisplayId: delivery.displayId },
      });
    }
    return { ok: true, deleted: deleted.length > 0, siteId: delivery.siteId } as const;
  });
}

/** Привязан ли заказ к приёмке — для состава привязанного заказа. */
export async function isOrderLinked(db: Db, deliveryId: string, orderId: string): Promise<boolean> {
  const [row] = await db
    .select({ orderId: deliverySupplierOrders.orderId })
    .from(deliverySupplierOrders)
    .where(and(eq(deliverySupplierOrders.deliveryId, deliveryId), eq(deliverySupplierOrders.orderId, orderId)))
    .limit(1);
  return !!row;
}
