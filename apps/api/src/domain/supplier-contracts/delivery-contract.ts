// Договор приёмки: чтение с флагами, окно подбора, выбор/замена и отвязка.
//
// Область договора (scope): общий договор приёмки (documentId = null) или
// договор документа в режиме «Разные получатели по документам» (0146). Одна
// строка delivery_contracts на область — UNIQUE NULLS NOT DISTINCT
// (delivery_id, source_document_id). КАЖДОЕ чтение и удаление связи — с явной
// областью: без неё отвязка общего договора снесла бы договоры документов.
// deliveries не меняется — мобильный клиент и upsert приёмки связь не видят.
//
// Порядок проверок выбора (PUT) — так, чтобы повтор после потерянного ответа
// давал 200, а чужая замена — 409:
//   1. приёмка FOR NO KEY UPDATE (сериализует все изменения связей этой
//      приёмки, в том числе первую вставку, когда строки связи ещё нет;
//      recipient-mode и unlink-source берут ту же строку FOR UPDATE);
//   2. для документа: режим выключен → 409 per_document_off, документ не
//      привязан → 404 document_not_linked;
//   3. связь области уже на contractId → 200 без события (цель достигнута);
//   4. pending_deletion / transfer_pair → 409;
//   5. текущая связь ≠ replaceContractId → 409 contract_changed;
//   6. договор FOR SHARE: нет → 404, вид ≠ «С поставщиком» → 409 contract_kind;
//   7. upsert связи + событие linked/replaced.

import { and, asc, count, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import type {
  ContractCandidate,
  ContractCandidatesContext,
  ContractSiteMatch,
  DeliveryContract,
  DeliveryContractResponse,
  SupplierContractSummary,
} from '@matcheck/contracts';
import type { Db } from '../../db/client.js';
import {
  counterparties,
  deliveries,
  deliveryContractEvents,
  deliveryContracts,
  deliverySources,
  sites,
  sourceDocuments,
  supplierContracts,
  suppliers,
  users,
  type DeliveryContractEventReason,
} from '../../db/schema.js';
import { loadDeliveryPartyInns } from '../estimat/delivery-orders.js';
import { innDigits } from '../estimat/estimat.types.js';
import { loadOwnInns } from '../sourceDocuments/supplier-inn-check.js';
import { readCatalogInfo } from './apply.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

/** Условие области: общий договор (null) или договор документа. */
function scopeWhere(deliveryId: string, documentId: string | null): SQL {
  return and(
    eq(deliveryContracts.deliveryId, deliveryId),
    documentId === null
      ? isNull(deliveryContracts.sourceDocumentId)
      : eq(deliveryContracts.sourceDocumentId, documentId),
  )!;
}

/**
 * ИНН поставщика одного документа приёмки — тот же COALESCE, что у
 * loadDeliveryPartyInns, без собственных ИНН. Пусто — ИНН неизвестен.
 */
export async function loadDocumentSupplierInns(
  db: Executor,
  deliveryId: string,
  documentId: string,
): Promise<Set<string>> {
  const [rows, own] = await Promise.all([
    db
      .select({
        inn: sql<string | null>`COALESCE(NULLIF(BTRIM(${sourceDocuments.supplierInnRaw}), ''), NULLIF(BTRIM(${suppliers.inn}), ''), NULLIF(BTRIM(${counterparties.inn}), ''))`,
      })
      .from(deliverySources)
      .innerJoin(sourceDocuments, eq(sourceDocuments.id, deliverySources.sourceDocumentId))
      .leftJoin(suppliers, eq(suppliers.id, sourceDocuments.supplierDirectoryId))
      .leftJoin(counterparties, eq(counterparties.id, sourceDocuments.supplierId))
      .where(and(eq(deliverySources.deliveryId, deliveryId), eq(deliverySources.sourceDocumentId, documentId))),
    loadOwnInns(db as Db),
  ]);
  const out = new Set<string>();
  for (const r of rows) {
    const inn = innDigits(r.inn);
    if (inn && !own.has(inn)) out.add(inn);
  }
  return out;
}

type ContractRow = typeof supplierContracts.$inferSelect;

/** Коды объектов по id — одним запросом на весь список. */
async function siteCodesById(db: Db): Promise<Map<string, string>> {
  const rows = await db.select({ id: sites.id, code: sites.code }).from(sites);
  return new Map(rows.map((r) => [r.id, r.code]));
}

function siteIdsOf(row: ContractRow): string[] {
  // На свежем соединении postgres.js может отдать uuid[] строкой «{a,b}».
  const v = row.siteIds as unknown;
  if (Array.isArray(v)) return v as string[];
  if (typeof v === 'string') return v.replace(/^\{|\}$/g, '').split(',').filter(Boolean);
  return [];
}

export function toContractSummary(row: ContractRow, codes: Map<string, string>): SupplierContractSummary {
  return {
    id: row.id,
    onecId: row.onecId,
    counterpartyName: row.counterpartyName,
    counterpartyInn: row.counterpartyInn,
    name: row.name,
    number: row.number,
    contractDate: row.contractDate,
    kind: row.kind,
    objectText: row.objectText,
    siteStatus: row.siteStatus,
    siteCodes: siteIdsOf(row)
      .map((id) => codes.get(id))
      .filter((c): c is string => !!c)
      .sort((a, b) => a.localeCompare(b, 'ru')),
    missingSince: row.missingSince ? row.missingSince.toISOString() : null,
  };
}

/** Объект договора относительно объекта приёмки. conflict никогда не «match». */
export function contractSiteMatch(
  status: ContractRow['siteStatus'],
  siteIds: readonly string[],
  deliverySiteId: string,
): ContractSiteMatch {
  if (status === 'none' || siteIds.length === 0) return 'unknown';
  const has = siteIds.includes(deliverySiteId);
  if (status === 'conflict') return has ? 'conflict' : 'other';
  if (!has) return 'other';
  return status === 'group' ? 'group' : 'match';
}

/** Совпадение контрагента договора с поставщиком приёмки. null — ИНН поставщика неизвестен. */
function supplierMatchOf(inn: string, supplierInns: ReadonlySet<string>): boolean | null {
  return supplierInns.size === 0 ? null : supplierInns.has(inn);
}

type LinkRow = {
  contract: ContractRow;
  sourceDocumentId: string | null;
  linkedAt: Date;
  linkedByName: string | null;
};

function toDeliveryContract(
  row: LinkRow,
  codes: Map<string, string>,
  supplierInns: ReadonlySet<string>,
  deliverySiteId: string,
): DeliveryContract {
  const c = row.contract;
  return {
    ...toContractSummary(c, codes),
    linkedAt: row.linkedAt.toISOString(),
    linkedByName: row.linkedByName ?? null,
    supplierMatch: supplierMatchOf(c.counterpartyInn, supplierInns),
    siteMatch: contractSiteMatch(c.siteStatus, siteIdsOf(c), deliverySiteId),
    kindChanged: c.kind !== 'supplier',
    missing: c.missingSince !== null,
  };
}

/**
 * Договоры приёмки: общий и договоры документов. Флаги пересчитываются при
 * каждом запросе: у общего — по ИНН всей приёмки, у договора документа — по
 * ИНН поставщика этого документа.
 */
export async function getDeliveryContract(
  db: Db,
  delivery: { id: string; siteId: string },
): Promise<DeliveryContractResponse> {
  const [links, catalog, [mode]] = await Promise.all([
    db
      .select({
        contract: supplierContracts,
        sourceDocumentId: deliveryContracts.sourceDocumentId,
        linkedAt: deliveryContracts.linkedAt,
        linkedByName: users.fullName,
      })
      .from(deliveryContracts)
      .innerJoin(supplierContracts, eq(supplierContracts.id, deliveryContracts.contractId))
      .leftJoin(users, eq(users.id, deliveryContracts.linkedByUserId))
      .where(eq(deliveryContracts.deliveryId, delivery.id))
      .orderBy(asc(deliveryContracts.sourceDocumentId)),
    readCatalogInfo(db),
    db
      .select({ perDocument: deliveries.recipientsPerDocument })
      .from(deliveries)
      .where(eq(deliveries.id, delivery.id))
      .limit(1),
  ]);
  const perDocument = mode?.perDocument ?? false;
  if (links.length === 0) return { contract: null, perDocument, documents: [], catalog };

  const general = links.find((l) => l.sourceDocumentId === null) ?? null;
  const own = links.filter((l): l is LinkRow & { sourceDocumentId: string } => l.sourceDocumentId !== null);
  const [codes, deliveryInns, docInns] = await Promise.all([
    siteCodesById(db),
    general ? loadDeliveryPartyInns(db, delivery.id) : Promise.resolve(null),
    Promise.all(own.map((l) => loadDocumentSupplierInns(db, delivery.id, l.sourceDocumentId))),
  ]);
  return {
    contract: general
      ? toDeliveryContract(general, codes, deliveryInns!.supplierInns, delivery.siteId)
      : null,
    perDocument,
    documents: own.map((l, i) => ({
      documentId: l.sourceDocumentId,
      contract: toDeliveryContract(l, codes, docInns[i]!, delivery.siteId),
    })),
    catalog,
  };
}

// ─── Окно подбора ───────────────────────────────────────────────────────────

export type ContractCandidateQuery = {
  deliveryId: string;
  deliverySiteId: string;
  /** null — общий договор приёмки; иначе подбор для документа (по его ИНН). */
  documentId: string | null;
  q?: string;
  allSuppliers: boolean;
  limit: number;
  offset: number;
};

const innCsv = (set: ReadonlySet<string>) => [...set].join(',');

function searchSql(q: string): SQL {
  const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const c = supplierContracts;
  return sql`(${c.name} ilike ${like} or ${c.number} ilike ${like}
    or ${c.counterpartyName} ilike ${like} or ${c.counterpartyInn} ilike ${like})`;
}

export async function findContractCandidates(
  db: Db,
  query: ContractCandidateQuery,
): Promise<{ items: ContractCandidate[]; total: number; context: ContractCandidatesContext }> {
  const c = supplierContracts;
  const [supplierInns, codes, catalog, current] = await Promise.all([
    query.documentId === null
      ? loadDeliveryPartyInns(db, query.deliveryId).then((x) => x.supplierInns)
      : loadDocumentSupplierInns(db, query.deliveryId, query.documentId),
    siteCodesById(db),
    readCatalogInfo(db),
    db
      .select({ contractId: deliveryContracts.contractId })
      .from(deliveryContracts)
      .where(scopeWhere(query.deliveryId, query.documentId))
      .limit(1),
  ]);
  const inns = { supplierInns };
  const supplierKnown = inns.supplierInns.size > 0;
  const filteredBySupplier = supplierKnown && !query.allSuppliers;
  const csv = innCsv(inns.supplierInns);
  const supplierFilter = sql`${c.counterpartyInn} = any(string_to_array(${csv}, ','))`;

  const conds: SQL[] = [eq(c.kind, 'supplier')];
  if (filteredBySupplier) conds.push(supplierFilter);
  const q = query.q?.trim();
  if (q) conds.push(searchSql(q));
  const where = and(...conds);

  const site = query.deliverySiteId;
  const hasSite = sql`${site}::uuid = any(${c.siteIds})`;
  const siteRank = sql<number>`case
    when ${c.siteStatus} in ('exact', 'group') and ${hasSite} then 0
    when ${c.siteStatus} = 'none' or cardinality(${c.siteIds}) = 0 then 1
    when ${c.siteStatus} = 'conflict' and ${hasSite} then 1
    else 2 end`;
  // Без ИНН поставщика ранг не нужен: константа в ORDER BY — это номер колонки.
  const order: SQL[] = supplierKnown ? [sql`case when ${supplierFilter} then 0 else 1 end`] : [];

  const [rows, [totalRow], [supplierTotal]] = await Promise.all([
    db
      .select({ contract: c })
      .from(c)
      .where(where)
      .orderBy(
        ...order,
        sql`${siteRank}`,
        sql`case when ${c.missingSince} is null then 0 else 1 end`,
        sql`${c.contractDate} desc nulls last`,
        asc(c.id),
      )
      .limit(query.limit)
      .offset(query.offset),
    db.select({ n: count() }).from(c).where(where),
    supplierKnown
      ? db.select({ n: count() }).from(c).where(and(eq(c.kind, 'supplier'), supplierFilter))
      : Promise.resolve([{ n: 0 }]),
  ]);

  const currentId = current[0]?.contractId ?? null;
  const [siteRow] = await db.select({ code: sites.code }).from(sites).where(eq(sites.id, site)).limit(1);
  return {
    items: rows.map(({ contract }) => ({
      ...toContractSummary(contract, codes),
      supplierMatch: supplierMatchOf(contract.counterpartyInn, inns.supplierInns),
      siteMatch: contractSiteMatch(contract.siteStatus, siteIdsOf(contract), site),
      missing: contract.missingSince !== null,
      current: contract.id === currentId,
    })),
    total: Number(totalRow?.n ?? 0),
    context: {
      documentId: query.documentId,
      supplierInns: [...inns.supplierInns].sort(),
      supplierKnown,
      filteredBySupplier,
      siteCode: siteRow?.code ?? null,
      supplierContractsTotal: Number(supplierTotal?.n ?? 0),
      importedAt: catalog.importedAt,
    },
  };
}

// ─── Выбор, замена, отвязка ─────────────────────────────────────────────────

type DeliveryLockRow = {
  id: string;
  siteId: string;
  pendingDeletionAt: Date | null;
  sourceShipmentId: string | null;
  recipientsPerDocument: boolean;
};

async function lockDelivery(tx: Tx, deliveryId: string): Promise<DeliveryLockRow | undefined> {
  const [d] = await tx
    .select({
      id: deliveries.id,
      siteId: deliveries.siteId,
      pendingDeletionAt: deliveries.pendingDeletionAt,
      sourceShipmentId: deliveries.sourceShipmentId,
      recipientsPerDocument: deliveries.recipientsPerDocument,
    })
    .from(deliveries)
    .where(eq(deliveries.id, deliveryId))
    .for('no key update');
  return d;
}

async function currentLink(tx: Tx, deliveryId: string, documentId: string | null): Promise<string | null> {
  const [row] = await tx
    .select({ contractId: deliveryContracts.contractId })
    .from(deliveryContracts)
    .where(scopeWhere(deliveryId, documentId))
    .for('update');
  return row?.contractId ?? null;
}

type ScopeFailure =
  | { ok: false; status: 404; error: 'document_not_linked' }
  | { ok: false; status: 409; error: 'per_document_off'; message: string; siteId: string };

/** Проверки области документа под блокировкой приёмки. null — область годится. */
async function checkDocumentScope(
  tx: Tx,
  delivery: DeliveryLockRow,
  documentId: string | null,
): Promise<ScopeFailure | null> {
  if (documentId === null) return null;
  if (!delivery.recipientsPerDocument) {
    return {
      ok: false,
      status: 409,
      error: 'per_document_off',
      message: 'Договор по документу выбирают в режиме «Разные получатели по документам» — он выключен',
      siteId: delivery.siteId,
    };
  }
  const [link] = await tx
    .select({ id: deliverySources.sourceDocumentId })
    .from(deliverySources)
    .where(and(eq(deliverySources.deliveryId, delivery.id), eq(deliverySources.sourceDocumentId, documentId)))
    .limit(1);
  if (!link) return { ok: false, status: 404, error: 'document_not_linked' };
  return null;
}

export type SetContractResult =
  | { ok: true; changed: boolean; siteId: string }
  | { ok: false; status: 404; error: 'not_found' | 'contract_not_found' | 'document_not_linked' }
  | {
      ok: false;
      status: 409;
      error: 'pending_deletion' | 'transfer_pair' | 'contract_kind' | 'contract_changed' | 'per_document_off';
      message: string;
      siteId: string;
    };

export async function setDeliveryContract(
  db: Db,
  input: {
    deliveryId: string;
    /** null — общий договор приёмки. */
    documentId: string | null;
    contractId: string;
    replaceContractId: string | null;
    userId: string | null;
  },
): Promise<SetContractResult> {
  return db.transaction(async (tx) => {
    const delivery = await lockDelivery(tx, input.deliveryId);
    if (!delivery) return { ok: false, status: 404, error: 'not_found' } as const;
    const scopeFailure = await checkDocumentScope(tx, delivery, input.documentId);
    if (scopeFailure) return scopeFailure;
    const current = await currentLink(tx, delivery.id, input.documentId);
    if (current === input.contractId) return { ok: true, changed: false, siteId: delivery.siteId } as const;

    if (delivery.pendingDeletionAt !== null) {
      return {
        ok: false,
        status: 409,
        error: 'pending_deletion',
        message: 'Приёмка помечена на удаление — выбрать договор нельзя',
        siteId: delivery.siteId,
      } as const;
    }
    if (delivery.sourceShipmentId !== null) {
      return {
        ok: false,
        status: 409,
        error: 'transfer_pair',
        message: 'Приёмка перемещения — договор поставщика к ней не относится',
        siteId: delivery.siteId,
      } as const;
    }
    if (current !== input.replaceContractId) {
      return {
        ok: false,
        status: 409,
        error: 'contract_changed',
        message: current
          ? 'Договор приёмки уже изменил другой пользователь'
          : 'Договор приёмки уже отвязал другой пользователь',
        siteId: delivery.siteId,
      } as const;
    }

    const [contract] = await tx
      .select({ id: supplierContracts.id, kind: supplierContracts.kind })
      .from(supplierContracts)
      .where(eq(supplierContracts.id, input.contractId))
      .for('share');
    if (!contract) return { ok: false, status: 404, error: 'contract_not_found' } as const;
    if (contract.kind !== 'supplier') {
      return {
        ok: false,
        status: 409,
        error: 'contract_kind',
        message: 'Это не договор с поставщиком — к приёмке его выбрать нельзя',
        siteId: delivery.siteId,
      } as const;
    }

    await tx
      .insert(deliveryContracts)
      .values({
        deliveryId: delivery.id,
        sourceDocumentId: input.documentId,
        contractId: contract.id,
        linkedByUserId: input.userId,
      })
      .onConflictDoUpdate({
        target: [deliveryContracts.deliveryId, deliveryContracts.sourceDocumentId],
        set: { contractId: contract.id, linkedByUserId: input.userId, linkedAt: sql`now()` },
      });
    await tx.insert(deliveryContractEvents).values({
      deliveryId: delivery.id,
      sourceDocumentId: input.documentId,
      contractId: contract.id,
      previousContractId: current,
      kind: current ? 'replaced' : 'linked',
      userId: input.userId,
    });
    return { ok: true, changed: true, siteId: delivery.siteId } as const;
  });
}

export type UnsetContractResult =
  | { ok: true; changed: boolean; siteId: string }
  | { ok: false; status: 404; error: 'not_found' }
  | { ok: false; status: 409; error: 'pending_deletion' | 'contract_changed'; message: string; siteId: string };

/**
 * Отвязать договор области. Связи нет — 200 без события (цель достигнута),
 * поэтому выключенный режим или отвязанный документ здесь не ошибка: их
 * договоры уже сняты в recipient-mode / unlink-source.
 */
export async function unsetDeliveryContract(
  db: Db,
  input: { deliveryId: string; documentId: string | null; expectedContractId: string; userId: string | null },
): Promise<UnsetContractResult> {
  return db.transaction(async (tx) => {
    const delivery = await lockDelivery(tx, input.deliveryId);
    if (!delivery) return { ok: false, status: 404, error: 'not_found' } as const;
    const current = await currentLink(tx, delivery.id, input.documentId);
    if (current === null) return { ok: true, changed: false, siteId: delivery.siteId } as const;
    if (delivery.pendingDeletionAt !== null) {
      return {
        ok: false,
        status: 409,
        error: 'pending_deletion',
        message: 'Приёмка помечена на удаление — отвязать договор нельзя',
        siteId: delivery.siteId,
      } as const;
    }
    if (current !== input.expectedContractId) {
      return {
        ok: false,
        status: 409,
        error: 'contract_changed',
        message: 'Договор приёмки уже изменил другой пользователь',
        siteId: delivery.siteId,
      } as const;
    }
    await tx.delete(deliveryContracts).where(scopeWhere(delivery.id, input.documentId));
    await tx.insert(deliveryContractEvents).values({
      deliveryId: delivery.id,
      sourceDocumentId: input.documentId,
      contractId: null,
      previousContractId: current,
      kind: 'unlinked',
      userId: input.userId,
    });
    return { ok: true, changed: true, siteId: delivery.siteId } as const;
  });
}

// ─── Снятие договоров документов без действия человека ─────────────────────

async function dropDocumentLinks(
  tx: Tx,
  deliveryId: string,
  documentId: string | null,
  userId: string | null,
  reason: DeliveryContractEventReason,
): Promise<number> {
  const where = and(
    eq(deliveryContracts.deliveryId, deliveryId),
    documentId === null
      ? isNotNull(deliveryContracts.sourceDocumentId)
      : eq(deliveryContracts.sourceDocumentId, documentId),
  );
  const removed = await tx
    .delete(deliveryContracts)
    .where(where)
    .returning({ sourceDocumentId: deliveryContracts.sourceDocumentId, contractId: deliveryContracts.contractId });
  if (removed.length > 0) {
    await tx.insert(deliveryContractEvents).values(
      removed.map((r) => ({
        deliveryId,
        sourceDocumentId: r.sourceDocumentId,
        contractId: null,
        previousContractId: r.contractId,
        kind: 'unlinked' as const,
        reason,
        userId,
      })),
    );
  }
  return removed.length;
}

/**
 * Выключили «Разные получатели по документам» — договоры документов снимаются
 * вместе со своими получателями и признаками; общий договор остаётся. Зовётся
 * в транзакции recipient-mode под блокировкой приёмки.
 */
export async function resetDocumentContracts(tx: Tx, deliveryId: string, userId: string | null): Promise<number> {
  return dropDocumentLinks(tx, deliveryId, null, userId, 'mode_off');
}

/**
 * Документ отвязывают от приёмки — его договор снимается с записью в журнал до
 * удаления связи (FK-каскад остаётся страховкой). Зовётся в транзакции
 * unlink-source под блокировкой приёмки.
 */
export async function dropDocumentContract(
  tx: Tx,
  deliveryId: string,
  documentId: string,
  userId: string | null,
): Promise<number> {
  return dropDocumentLinks(tx, deliveryId, documentId, userId, 'document_unlinked');
}

// ─── Вкладка «Договоры» ─────────────────────────────────────────────────────

export async function listSupplierContracts(
  db: Db,
  query: { q?: string; siteId?: string; limit: number; offset: number },
): Promise<{ items: SupplierContractSummary[]; total: number; importedAt: string | null }> {
  const c = supplierContracts;
  const conds: SQL[] = [];
  const q = query.q?.trim();
  if (q) conds.push(searchSql(q));
  if (query.siteId) conds.push(sql`${query.siteId}::uuid = any(${c.siteIds})`);
  const where = conds.length > 0 ? and(...conds) : undefined;
  const [rows, [totalRow], codes, catalog] = await Promise.all([
    db
      .select()
      .from(c)
      .where(where)
      .orderBy(asc(c.counterpartyName), sql`${c.contractDate} desc nulls last`, asc(c.id))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ n: count() }).from(c).where(where),
    siteCodesById(db),
    readCatalogInfo(db),
  ]);
  return {
    items: rows.map((r) => toContractSummary(r, codes)),
    total: Number(totalRow?.n ?? 0),
    importedAt: catalog.importedAt,
  };
}
