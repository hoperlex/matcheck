// «Оставить копию как новую поставку» — правило «одна карточка на планшете».
//
// Копия документа (needs_resolution + duplicate_upd) на планшет не едет. Снять
// с неё пометку значит отправить её инспектору. Делать это можно, только если
// на планшете не останется второй карточки того же документа.
//
// Что прячет документ на планшете — сверено с Android:
//   * `sourceDocumentIds` берутся только у приёмок и отгрузок с
//     `pendingDeletionAt IS NULL` (RemoteDeliveryDao / RemoteShipmentDao);
//   * в `/sync` они собираются только из delivery_sources (sync.ts) — связи ЭДО
//     (delivery_edo_matches) планшет не видит вовсе;
//   * машина портала прячется целиком по groupId (UpdSelectFilter.kt).
//
// Отсюда «принят» = есть живая (не в корзине) приёмка через delivery_sources или
// живая отгрузка через shipment_sources. Подсчёт ссылок для удаления
// (`countDocumentReferences`) шире — там и ЭДО, и корзина — и это правильно:
// удалять документ, на который что-то ссылается, нельзя, а прятать его на
// планшете такие ссылки не умеют.
//
// Блокировок братьев нет намеренно. Мешает ЛЮБОЙ непринятый брат в рабочем
// статусе, включая другую копию в needs_resolution. Поэтому две параллельные
// попытки оставить две копии одного оригинала взаимно откажут: каждая видит
// другую либо в needs_resolution, либо уже parsed и непринятой. Чужие строки не
// блокируются — и взаимоблокировок между машинами нет.

import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { UpdValidation } from '@matcheck/contracts';
import type { Db } from '../../db/client.js';
import {
  deliveries,
  deliveryEdoMatches,
  deliverySources,
  shipmentSources,
  shipments,
  sites,
  sourceDocumentItems,
  sourceDocuments,
  statuses,
} from '../../db/schema.js';
import { deriveUpdParseOutcome, expectedItemsCountOf, type UpdParseOutcome } from '../edo/upd-outcome.js';
import { documentGroupIdSql } from './document-group.js';

/** Статусы, в которых документ может оказаться (или уже есть) на планшете. */
const WORKING_STATUSES = ['parsed', 'needs_resolution', 'queued', 'processing'] as const;

export type DuplicateOperationRef = {
  kind: 'delivery' | 'shipment';
  id: string;
  displayId: number;
  statusLabel: string | null;
  /** Приёмка — arrived_at, отгрузка — shipped_at. */
  at: string | null;
  /** В корзине: планшет такую операцию не учитывает. */
  pendingDeletion: boolean;
};

export type DuplicateSibling = {
  id: string;
  status: string;
  parseErrorCode: string | null;
  docNumber: string | null;
  expectedDate: string | null;
  siteName: string | null;
  /** Машина портала (groupId планшета); null у загрузок менеджера, почты, ЭДО. */
  groupId: string | null;
  operations: DuplicateOperationRef[];
  /** Связи ЭДО: от удаления защищают, на планшете документ не прячут. */
  edoLinks: number;
  /** Принят так, как это понимает планшет. */
  accepted: boolean;
};

/** След решения в source_documents.duplicate_resolution (миграция 0148). */
export type DuplicateResolutionTrace = {
  action: 'kept';
  existingId: string | null;
  existingDocNumber: string | null;
  siblings: Array<{ id: string; docNumber: string | null; operations: DuplicateOperationRef[] }>;
  duplicateCheck: unknown;
  comment: string | null;
  userId: string | null;
  at: string;
};

export type KeepReason = 'legacy' | 'incomplete' | 'sibling_not_accepted' | 'same_machine';

export type KeepVerdict =
  | { allowed: true; outcome: UpdParseOutcome; siblings: DuplicateSibling[] }
  | {
      allowed: false;
      reason: KeepReason;
      missing: string[];
      blockingIds: string[];
      siblings: DuplicateSibling[];
    };

export const KEEP_REASON_MESSAGES: Record<KeepReason, string> = {
  legacy:
    'У этой копии не хватает реквизитов для проверки (поставщик, номер или дата) — оставить её нельзя. Удалите копию или замените ею оригинал.',
  incomplete:
    'Копия распознана не полностью — допишите в карточке копии номер и материалы, затем повторите.',
  sibling_not_accepted:
    'Такой же документ ещё не принят — его карточка уже есть на планшете. Перенесите дату у него или удалите эту копию.',
  same_machine:
    'Копия загружена в той же поставке, что и принятый документ, — на планшете она будет скрыта вместе с ним.',
};

/** Операции (приёмки и отгрузки) по набору документов. */
export async function loadDocumentOperations(
  db: Db,
  documentIds: string[],
): Promise<Map<string, DuplicateOperationRef[]>> {
  const out = new Map<string, DuplicateOperationRef[]>();
  if (documentIds.length === 0) return out;
  const push = (docId: string, ref: DuplicateOperationRef) => {
    const list = out.get(docId) ?? [];
    list.push(ref);
    out.set(docId, list);
  };

  const dRows = await db
    .select({
      docId: deliverySources.sourceDocumentId,
      id: deliveries.id,
      displayId: deliveries.displayId,
      statusLabel: statuses.label,
      at: deliveries.arrivedAt,
      pendingDeletionAt: deliveries.pendingDeletionAt,
    })
    .from(deliverySources)
    .innerJoin(deliveries, eq(deliveries.id, deliverySources.deliveryId))
    .leftJoin(statuses, eq(statuses.id, deliveries.statusId))
    .where(inArray(deliverySources.sourceDocumentId, documentIds))
    .orderBy(deliveries.displayId);
  for (const r of dRows) {
    push(r.docId, {
      kind: 'delivery',
      id: r.id,
      displayId: r.displayId,
      statusLabel: r.statusLabel ?? null,
      at: r.at?.toISOString() ?? null,
      pendingDeletion: r.pendingDeletionAt != null,
    });
  }

  const sRows = await db
    .select({
      docId: shipmentSources.sourceDocumentId,
      id: shipments.id,
      displayId: shipments.displayId,
      statusLabel: statuses.label,
      at: shipments.shippedAt,
      pendingDeletionAt: shipments.pendingDeletionAt,
    })
    .from(shipmentSources)
    .innerJoin(shipments, eq(shipments.id, shipmentSources.shipmentId))
    .leftJoin(statuses, eq(statuses.id, shipments.statusId))
    .where(inArray(shipmentSources.sourceDocumentId, documentIds))
    .orderBy(shipments.displayId);
  for (const r of sRows) {
    push(r.docId, {
      kind: 'shipment',
      id: r.id,
      displayId: r.displayId,
      statusLabel: r.statusLabel ?? null,
      at: r.at?.toISOString() ?? null,
      pendingDeletion: r.pendingDeletionAt != null,
    });
  }
  return out;
}

/** Принят ли документ так, как это понимает планшет. */
export function isAcceptedForTablet(operations: DuplicateOperationRef[] | undefined): boolean {
  return (operations ?? []).some((op) => !op.pendingDeletion);
}

/**
 * Ссылки, при которых документ нельзя удалить: приёмки и отгрузки (в том числе
 * в корзине) и связи ЭДО. Единое правило для удаления и для «Заменить».
 */
export async function countDocumentReferences(
  db: Db,
  documentId: string,
): Promise<{ deliveries: number; shipments: number }> {
  const [{ count: d } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(deliverySources)
    .where(eq(deliverySources.sourceDocumentId, documentId));
  const [{ count: e } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(deliveryEdoMatches)
    .where(eq(deliveryEdoMatches.sourceDocumentId, documentId));
  const [{ count: s } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(shipmentSources)
    .where(eq(shipmentSources.sourceDocumentId, documentId));
  return { deliveries: d + e, shipments: s };
}

/**
 * Братья копии: документы того же вида с тем же ключом дедупликации
 * (поставщик из справочника, номер, дата), которые могут оказаться на планшете.
 *
 * Сравнение колонка-с-колонкой (self-join), а не с параметром: дата документа —
 * timestamp без таймзоны, и передача её из JS сдвигала бы день при TZ процесса.
 */
export async function loadDuplicateSiblings(db: Db, dupId: string): Promise<DuplicateSibling[]> {
  const dup = alias(sourceDocuments, 'dup');
  const rows = await db
    .select({
      id: sourceDocuments.id,
      status: sourceDocuments.status,
      parseErrorCode: sourceDocuments.parseErrorCode,
      docNumber: sourceDocuments.docNumber,
      expectedDate: sql<string | null>`to_char(${sourceDocuments.expectedDate}, 'YYYY-MM-DD')`,
      siteName: sites.name,
      groupId: documentGroupIdSql(),
    })
    .from(sourceDocuments)
    .innerJoin(
      dup,
      and(
        eq(dup.id, dupId),
        eq(sourceDocuments.kind, dup.kind),
        eq(sourceDocuments.supplierDirectoryId, dup.supplierDirectoryId),
        eq(sourceDocuments.docNumber, dup.docNumber),
        eq(sourceDocuments.docDate, dup.docDate),
      ),
    )
    .leftJoin(sites, eq(sites.id, sourceDocuments.siteId))
    .where(
      and(
        ne(sourceDocuments.id, dupId),
        eq(sourceDocuments.isTechnical, false),
        inArray(sourceDocuments.status, [...WORKING_STATUSES]),
      ),
    )
    .orderBy(sourceDocuments.createdAt);

  const ids = rows.map((r) => r.id);
  const operations = await loadDocumentOperations(db, ids);
  const edoCounts = new Map<string, number>();
  if (ids.length > 0) {
    const edoRows = await db
      .select({
        docId: deliveryEdoMatches.sourceDocumentId,
        count: sql<number>`count(*)::int`,
      })
      .from(deliveryEdoMatches)
      .where(inArray(deliveryEdoMatches.sourceDocumentId, ids))
      .groupBy(deliveryEdoMatches.sourceDocumentId);
    for (const r of edoRows) if (r.docId) edoCounts.set(r.docId, r.count);
  }

  return rows.map((r) => {
    const ops = operations.get(r.id) ?? [];
    return {
      id: r.id,
      status: r.status,
      parseErrorCode: r.parseErrorCode ?? null,
      docNumber: r.docNumber ?? null,
      expectedDate: r.expectedDate ?? null,
      siteName: r.siteName ?? null,
      groupId: r.groupId ?? null,
      operations: ops,
      edoLinks: edoCounts.get(r.id) ?? 0,
      accepted: isAcceptedForTablet(ops),
    };
  });
}

type DupRow = Pick<
  typeof sourceDocuments.$inferSelect,
  | 'id'
  | 'supplierDirectoryId'
  | 'docNumber'
  | 'docDate'
  | 'totalSum'
  | 'llmConfidence'
  | 'validation'
>;

/**
 * Можно ли оставить копию как новую поставку. Порядок отказов:
 * legacy → incomplete → sibling_not_accepted → same_machine.
 *
 * Исход считает то же правило, что и разбор (deriveUpdParseOutcome), по
 * СОХРАНЁННОЙ validation: пометка дубля затёрла исходный исход
 * (`partial_parse`/`validation_mismatch`), а validation — ровно то, что воркер
 * посчитал до неё. Проверка неполного списка берётся оттуда же: PATCH копии
 * переносит ожидаемое число позиций (см. маршрут), так что правка количества её
 * не стирает.
 */
export async function duplicateKeepVerdict(db: Db, sd: DupRow): Promise<KeepVerdict> {
  const validation = sd.validation as UpdValidation | null;
  if (!sd.supplierDirectoryId || !sd.docNumber || !sd.docDate || !validation) {
    return { allowed: false, reason: 'legacy', missing: [], blockingIds: [], siblings: [] };
  }

  const items = await db
    .select({
      qty: sourceDocumentItems.qty,
      price: sourceDocumentItems.price,
      sum: sourceDocumentItems.sum,
      vatRate: sourceDocumentItems.vatRate,
    })
    .from(sourceDocumentItems)
    .where(eq(sourceDocumentItems.sourceDocumentId, sd.id));
  const outcome = deriveUpdParseOutcome(
    {
      items: items.map((i) => ({
        qty: i.qty != null ? Number(i.qty) : null,
        price: i.price != null ? Number(i.price) : null,
        sum: i.sum != null ? Number(i.sum) : null,
        vatRate: i.vatRate != null ? Number(i.vatRate) : null,
      })),
      docNumber: sd.docNumber,
      totalSum: sd.totalSum != null ? Number(sd.totalSum) : null,
      confidence: sd.llmConfidence != null ? Number(sd.llmConfidence) : null,
      itemsCount: expectedItemsCountOf(validation),
    },
    validation,
  );

  const siblings = await loadDuplicateSiblings(db, sd.id);

  if (outcome.status !== 'parsed') {
    const missing =
      (outcome.parseErrorDetails as { missing?: string[] } | null)?.missing ?? [];
    return { allowed: false, reason: 'incomplete', missing, blockingIds: [], siblings };
  }

  const notAccepted = siblings.filter((s) => !s.accepted);
  if (notAccepted.length > 0) {
    return {
      allowed: false,
      reason: 'sibling_not_accepted',
      missing: [],
      blockingIds: notAccepted.map((s) => s.id),
      siblings,
    };
  }

  const [self] = await db
    .select({ groupId: documentGroupIdSql() })
    .from(sourceDocuments)
    .where(eq(sourceDocuments.id, sd.id))
    .limit(1);
  const selfGroup = self?.groupId ?? null;
  if (selfGroup) {
    const sameMachine = siblings.filter((s) => s.accepted && s.groupId === selfGroup);
    if (sameMachine.length > 0) {
      return {
        allowed: false,
        reason: 'same_machine',
        missing: [],
        blockingIds: sameMachine.map((s) => s.id),
        siblings,
      };
    }
  }

  return { allowed: true, outcome, siblings };
}

export type ReplaceVerdict =
  | { allowed: true; existingMissing: boolean }
  | { allowed: false; reason: 'original_used' | 'no_existing_ref' };

/**
 * Можно ли «Заменить»: удалить найденный документ и распознать копию заново.
 * Удалённый оригинал — не помеха: удалять нечего, копия просто распознаётся.
 */
export async function replaceVerdict(db: Db, existingId: string | null): Promise<ReplaceVerdict> {
  if (!existingId) return { allowed: false, reason: 'no_existing_ref' };
  const [existing] = await db
    .select({ id: sourceDocuments.id })
    .from(sourceDocuments)
    .where(eq(sourceDocuments.id, existingId))
    .limit(1);
  if (!existing) return { allowed: true, existingMissing: true };
  const refs = await countDocumentReferences(db, existingId);
  if (refs.deliveries + refs.shipments > 0) return { allowed: false, reason: 'original_used' };
  return { allowed: true, existingMissing: false };
}

/** existingId из деталей пометки дубля. */
export function duplicateExistingIdOf(details: unknown): string | null {
  if (!details || typeof details !== 'object') return null;
  const v = (details as { existingId?: unknown }).existingId;
  return typeof v === 'string' ? v : null;
}
