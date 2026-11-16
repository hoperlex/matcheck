/**
 * Группы приёмок: рейсы одной поставки (одна УПД — 2–3 машины), миграция 0149.
 *
 * Группа нужна порталу: строки стоят рядом под скобкой, а одна УПД из ЭДО
 * привязывается ко всем приёмкам группы разом. Планшет о группах не знает:
 * ни один путь здесь не трогает строки `deliveries` (version/updated_at), а
 * `/sync` таблиц групп не читает.
 *
 * Инварианты держит этот модуль, и только он пишет в таблицы групп:
 *   - приёмка не больше чем в одной группе (PK `delivery_id`);
 *   - все члены стоят на `delivery_groups.site_id` — вступление проверяет,
 *     upsert со сменой объекта выводит приёмку (`detachDeliveries`);
 *   - член — только живая приёмка: пометка на удаление выводит из группы,
 *     восстановление не возвращает. Поэтому лимит считает всех, а состав,
 *     который видит человек, совпадает с составом в базе;
 *   - в группе не меньше двух членов: каждый путь, уменьшающий группу,
 *     распускает её в той же транзакции (`dissolveUnderfilled`);
 *   - не больше `DELIVERY_GROUP_MAX` членов.
 *
 * Порядок блокировок на всех путях: строки `deliveries` (по возрастанию id) →
 * строки `delivery_groups` (по возрастанию id) → участники. Пути «группа, потом
 * приёмка» нет. Роспуск берёт только группу: удаление строки участника не
 * блокирует `deliveries` (FK с дочерней стороны).
 */
import { and, asc, desc, eq, inArray, sql as drSql } from 'drizzle-orm';
import {
  DELIVERY_GROUP_MAX,
  type DeliveryGroupError,
  type DeliveryGroupSummary,
} from '@matcheck/contracts';
import type { Db } from '../../db/client.js';
import {
  deliveries,
  deliveryEdoMatches,
  deliveryGroupMembers,
  deliveryGroups,
  statuses,
} from '../../db/schema.js';

type Exec = Pick<Db, 'execute' | 'select' | 'insert' | 'delete'>;
/** Только чтение (и FOR SHARE) — для путей, которым писать не нужно. */
type Reader = Pick<Db, 'select'>;

export type DeliveryRef = { deliveryId: string; displayId: number };

/**
 * Состав разошёлся с ожидаемым посреди транзакции (вставилось меньше
 * участников). Бросается, чтобы откатить уже созданную группу; маршрут
 * отвечает 409 `group_changed`.
 */
export class DeliveryGroupChangedError extends Error {
  constructor() {
    super('delivery group changed');
    this.name = 'DeliveryGroupChangedError';
  }
}

type LockedDelivery = {
  id: string;
  displayId: number;
  siteId: string;
  pendingDeletionAt: Date | null;
  sourceShipmentId: string | null;
  statusCode: string | null;
};

const refOf = (row: { id: string; displayId: number }): DeliveryRef => ({
  deliveryId: row.id,
  displayId: row.displayId,
});
const byDisplayDesc = (a: DeliveryRef, b: DeliveryRef) => b.displayId - a.displayId;

/** Строки приёмок под `FOR UPDATE`, по возрастанию id — общий первый шаг. */
async function lockDeliveries(tx: Exec, ids: readonly string[]): Promise<LockedDelivery[]> {
  if (!ids.length) return [];
  return tx
    .select({
      id: deliveries.id,
      displayId: deliveries.displayId,
      siteId: deliveries.siteId,
      pendingDeletionAt: deliveries.pendingDeletionAt,
      sourceShipmentId: deliveries.sourceShipmentId,
      statusCode: drSql<
        string | null
      >`(select ${statuses.code} from ${statuses} where ${statuses.id} = ${deliveries.statusId})`,
    })
    .from(deliveries)
    .where(inArray(deliveries.id, [...ids]))
    .orderBy(asc(deliveries.id))
    .for('update');
}

/** Членство приёмок: deliveryId → groupId. */
async function membershipOf(tx: Reader, ids: readonly string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await tx
    .select({ deliveryId: deliveryGroupMembers.deliveryId, groupId: deliveryGroupMembers.groupId })
    .from(deliveryGroupMembers)
    .where(inArray(deliveryGroupMembers.deliveryId, [...ids]));
  return new Map(rows.map((r) => [r.deliveryId, r.groupId]));
}

/** Группы под `FOR UPDATE` по возрастанию id; возвращает найденные. */
async function lockGroups(
  tx: Exec,
  groupIds: readonly string[],
): Promise<Array<{ id: string; siteId: string }>> {
  if (!groupIds.length) return [];
  return tx
    .select({ id: deliveryGroups.id, siteId: deliveryGroups.siteId })
    .from(deliveryGroups)
    .where(inArray(deliveryGroups.id, [...new Set(groupIds)]))
    .orderBy(asc(deliveryGroups.id))
    .for('update');
}

/** Участники группы с номерами — по убыванию номера. */
async function groupMembers(tx: Reader, groupId: string): Promise<DeliveryRef[]> {
  const rows = await tx
    .select({ id: deliveries.id, displayId: deliveries.displayId })
    .from(deliveryGroupMembers)
    .innerJoin(deliveries, eq(deliveries.id, deliveryGroupMembers.deliveryId))
    .where(eq(deliveryGroupMembers.groupId, groupId))
    .orderBy(desc(deliveries.displayId));
  return rows.map(refOf);
}

/**
 * Распустить группы, где осталось меньше двух участников. Группы должны быть
 * уже заблокированы вызывающим (или будут заблокированы здесь — порядок тот
 * же). Возвращает распущенные группы и приёмки, которые из-за роспуска
 * перестали быть в группе (для событий).
 */
export async function dissolveUnderfilled(
  tx: Exec,
  groupIds: readonly string[],
): Promise<{ dissolvedGroupIds: string[]; releasedDeliveryIds: string[] }> {
  const locked = await lockGroups(tx, groupIds);
  if (!locked.length) return { dissolvedGroupIds: [], releasedDeliveryIds: [] };
  const counts = await tx
    .select({
      groupId: deliveryGroupMembers.groupId,
      deliveryId: deliveryGroupMembers.deliveryId,
    })
    .from(deliveryGroupMembers)
    .where(
      inArray(
        deliveryGroupMembers.groupId,
        locked.map((g) => g.id),
      ),
    );
  const membersOf = new Map<string, string[]>();
  for (const row of counts) {
    const list = membersOf.get(row.groupId) ?? [];
    list.push(row.deliveryId);
    membersOf.set(row.groupId, list);
  }
  const underfilled = locked.map((g) => g.id).filter((id) => (membersOf.get(id)?.length ?? 0) < 2);
  if (!underfilled.length) return { dissolvedGroupIds: [], releasedDeliveryIds: [] };
  await tx.delete(deliveryGroups).where(inArray(deliveryGroups.id, underfilled));
  return {
    dissolvedGroupIds: underfilled,
    releasedDeliveryIds: underfilled.flatMap((id) => membersOf.get(id) ?? []),
  };
}

// ------------------------------------------------------------ сбор группы

export type ComposeInput = {
  userId: string | null;
  groupId?: string;
  expectedMemberIds?: readonly string[];
  add: readonly string[];
  remove: readonly string[];
};

export type ComposeResult =
  | {
      status: 'ok';
      groupId: string | null;
      siteId: string;
      members: DeliveryRef[];
      added: DeliveryRef[];
      removed: DeliveryRef[];
      dissolved: boolean;
      /** Приёмки, чья группа изменилась, — для событий. */
      touched: string[];
    }
  | { status: DeliveryGroupError; deliveries: DeliveryRef[] };

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && new Set([...a, ...b]).size === a.length;

/**
 * Создать группу или применить к ней добавления и удаления — одной операцией,
 * всё или ничего. Вызывать внутри транзакции; при `DeliveryGroupChangedError`
 * транзакцию надо откатить.
 */
export async function composeDeliveryGroup(tx: Exec, input: ComposeInput): Promise<ComposeResult> {
  const { add, remove, groupId } = input;
  const all = [...new Set([...add, ...remove])].sort();
  const rows = await lockDeliveries(tx, all);
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (all.some((id) => !byId.has(id))) return { status: 'not_found', deliveries: [] };
  const addRows = add.map((id) => byId.get(id)!);
  const failing = (predicate: (row: LockedDelivery) => boolean) =>
    addRows.filter(predicate).map(refOf);

  const drafts = failing((row) => row.statusCode === 'draft');
  if (drafts.length) return { status: 'draft', deliveries: drafts };
  const pending = failing((row) => row.pendingDeletionAt !== null);
  if (pending.length) return { status: 'pending_deletion', deliveries: pending };
  const fromShipment = failing((row) => row.sourceShipmentId !== null);
  if (fromShipment.length) return { status: 'from_shipment', deliveries: fromShipment };

  // Под блокировкой приёмок их членство уже не сменится: вступить в другую
  // группу можно только через этот же путь, а он ждёт те же строки.
  const membership = await membershipOf(tx, all);

  if (!groupId) {
    if (remove.length) return { status: 'group_changed', deliveries: [] };
    if (addRows.length < 2) return { status: 'too_few', deliveries: [] };
    const inOther = failing((row) => membership.has(row.id));
    if (inOther.length) return { status: 'in_other_group', deliveries: inOther };
    const siteId = addRows[0]!.siteId;
    const otherSite = failing((row) => row.siteId !== siteId);
    if (otherSite.length) return { status: 'other_site', deliveries: otherSite };
    if (addRows.length > DELIVERY_GROUP_MAX) return { status: 'too_many', deliveries: [] };

    const [created] = await tx
      .insert(deliveryGroups)
      .values({ siteId, createdByUserId: input.userId })
      .returning({ id: deliveryGroups.id });
    await insertMembers(tx, created!.id, addRows, input.userId);
    const members = addRows.map(refOf).sort(byDisplayDesc);
    return {
      status: 'ok',
      groupId: created!.id,
      siteId,
      members,
      added: members,
      removed: [],
      dissolved: false,
      touched: addRows.map((row) => row.id),
    };
  }

  const [group] = await lockGroups(tx, [groupId]);
  if (!group) return { status: 'group_changed', deliveries: [] };
  const current = await groupMembers(tx, groupId);
  const currentIds = current.map((m) => m.deliveryId);
  const currentSet = new Set(currentIds);
  if (input.expectedMemberIds && !sameSet(input.expectedMemberIds, currentIds))
    return { status: 'group_changed', deliveries: [] };
  if (remove.some((id) => !currentSet.has(id))) return { status: 'group_changed', deliveries: [] };
  const inOther = failing((row) => {
    const of = membership.get(row.id);
    return of !== undefined && of !== groupId;
  });
  if (inOther.length) return { status: 'in_other_group', deliveries: inOther };
  const otherSite = failing((row) => row.siteId !== group.siteId);
  if (otherSite.length) return { status: 'other_site', deliveries: otherSite };

  const toAdd = addRows.filter((row) => !currentSet.has(row.id));
  const removeSet = new Set(remove);
  const finalSize = currentIds.filter((id) => !removeSet.has(id)).length + toAdd.length;
  if (finalSize > DELIVERY_GROUP_MAX) return { status: 'too_many', deliveries: [] };

  const removed = remove.length
    ? await tx
        .delete(deliveryGroupMembers)
        .where(
          and(
            eq(deliveryGroupMembers.groupId, groupId),
            inArray(deliveryGroupMembers.deliveryId, [...remove]),
          ),
        )
        .returning({ deliveryId: deliveryGroupMembers.deliveryId })
    : [];
  await insertMembers(tx, groupId, toAdd, input.userId);

  const { dissolvedGroupIds } = await dissolveUnderfilled(tx, [groupId]);
  const dissolved = dissolvedGroupIds.length > 0;
  const removedRefs = removed.map((r) => refOf(byId.get(r.deliveryId)!)).sort(byDisplayDesc);
  const addedRefs = toAdd.map(refOf).sort(byDisplayDesc);
  const members = dissolved ? [] : await groupMembers(tx, groupId);
  return {
    status: 'ok',
    groupId: dissolved ? null : groupId,
    siteId: group.siteId,
    members,
    added: addedRefs,
    removed: removedRefs,
    dissolved,
    // Роспуск меняет группу у всех, кто в ней был: строки остальных тоже
    // перерисуются без скобки.
    touched: [...new Set([...currentIds, ...toAdd.map((row) => row.id)])],
  };
}

/** Вставка участников по возрастанию id; недовставка — откат. */
async function insertMembers(
  tx: Exec,
  groupId: string,
  rows: readonly { id: string }[],
  userId: string | null,
): Promise<void> {
  if (!rows.length) return;
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const inserted = await tx
    .insert(deliveryGroupMembers)
    .values(sorted.map((row) => ({ deliveryId: row.id, groupId, addedByUserId: userId })))
    .onConflictDoNothing()
    .returning({ deliveryId: deliveryGroupMembers.deliveryId });
  if (inserted.length !== sorted.length) throw new DeliveryGroupChangedError();
}

// --------------------------------------------------------- уход и роспуск

export type LeaveResult = {
  removed: DeliveryRef[];
  dissolvedGroupIds: string[];
  /** Приёмки, чья группа изменилась, и объект — для событий. */
  touched: Array<{ deliveryId: string; siteId: string }>;
};

/**
 * Вывести приёмки из их групп. Сначала блокируются сами приёмки: под этой
 * блокировкой их членство уже не сменится, и удаление идёт только из тех
 * групп, что заблокированы здесь же — приёмка, успевшая перейти в другую
 * группу, там и останется.
 */
export async function leaveDeliveryGroups(
  tx: Exec,
  deliveryIds: readonly string[],
): Promise<LeaveResult> {
  const rows = await lockDeliveries(tx, [...new Set(deliveryIds)].sort());
  return detachLocked(tx, rows, {});
}

/**
 * Вывести уже заблокированные вызывающим приёмки из групп — для внешних путей
 * (upsert, пометка на удаление). `onlyIfSiteNot` — upsert: выводить, только
 * если объект группы не совпадает с новым объектом приёмки.
 */
export async function detachDeliveries(
  tx: Exec,
  deliveryIds: readonly string[],
  opts: { onlyIfSiteNot?: string } = {},
): Promise<LeaveResult> {
  if (!deliveryIds.length) return { removed: [], dissolvedGroupIds: [], touched: [] };
  const rows = await tx
    .select({ id: deliveries.id, displayId: deliveries.displayId })
    .from(deliveries)
    .where(inArray(deliveries.id, [...new Set(deliveryIds)]));
  return detachLocked(tx, rows, opts);
}

async function detachLocked(
  tx: Exec,
  rows: ReadonlyArray<{ id: string; displayId: number }>,
  opts: { onlyIfSiteNot?: string },
): Promise<LeaveResult> {
  const empty: LeaveResult = { removed: [], dissolvedGroupIds: [], touched: [] };
  if (!rows.length) return empty;
  const ids = rows.map((row) => row.id);
  const membership = await membershipOf(tx, ids);
  if (!membership.size) return empty;
  const locked = (await lockGroups(tx, [...membership.values()])).filter(
    (g) => opts.onlyIfSiteNot === undefined || g.siteId !== opts.onlyIfSiteNot,
  );
  if (!locked.length) return empty;
  const lockedIds = locked.map((g) => g.id);
  const siteOf = new Map(locked.map((g) => [g.id, g.siteId]));
  // Все участники затронутых групп — их строки перерисуются (у оставшихся
  // может пропасть скобка, если группа распустится).
  const before = await tx
    .select({ deliveryId: deliveryGroupMembers.deliveryId, groupId: deliveryGroupMembers.groupId })
    .from(deliveryGroupMembers)
    .where(inArray(deliveryGroupMembers.groupId, lockedIds));
  const removed = await tx
    .delete(deliveryGroupMembers)
    .where(
      and(
        inArray(deliveryGroupMembers.deliveryId, ids),
        inArray(deliveryGroupMembers.groupId, lockedIds),
      ),
    )
    .returning({ deliveryId: deliveryGroupMembers.deliveryId });
  const { dissolvedGroupIds } = await dissolveUnderfilled(tx, lockedIds);
  const displayOf = new Map(rows.map((row) => [row.id, row.displayId]));
  return {
    removed: removed
      .map((r) => ({ deliveryId: r.deliveryId, displayId: displayOf.get(r.deliveryId)! }))
      .sort(byDisplayDesc),
    dissolvedGroupIds,
    touched: before.map((row) => ({
      deliveryId: row.deliveryId,
      siteId: siteOf.get(row.groupId)!,
    })),
  };
}

export type DissolveResult =
  | { status: 'ok'; siteId: string; removed: DeliveryRef[] }
  | { status: 'group_not_found' };

/** Распустить группу целиком. Приёмки не блокируются — только группа. */
export async function dissolveDeliveryGroup(tx: Exec, groupId: string): Promise<DissolveResult> {
  const [group] = await lockGroups(tx, [groupId]);
  if (!group) return { status: 'group_not_found' };
  const removed = await groupMembers(tx, groupId);
  await tx.delete(deliveryGroups).where(eq(deliveryGroups.id, groupId));
  return { status: 'ok', siteId: group.siteId, removed };
}

// ------------------------------------------------------------- чтение

/** Состав группы для привязки: объект и все участники по убыванию номера. */
export async function deliveryGroupComposition(
  db: Reader,
  groupId: string,
): Promise<{ siteId: string; members: DeliveryRef[] } | null> {
  const [group] = await db
    .select({ siteId: deliveryGroups.siteId })
    .from(deliveryGroups)
    .where(eq(deliveryGroups.id, groupId));
  if (!group) return null;
  return { siteId: group.siteId, members: await groupMembers(db, groupId) };
}

/**
 * Сводка группы для строк списка: deliveryId → группа. Ничего не скрывает:
 * членство показывается как есть. `withEdo` — добавить `edoLinkedCount`
 * (сколько участников уже с УПД из ЭДО), только тем, кому привязки видны.
 */
export async function loadDeliveryGroupSummaries(
  db: Reader,
  deliveryIds: readonly string[],
  opts: { withEdo: boolean },
): Promise<Map<string, DeliveryGroupSummary>> {
  const result = new Map<string, DeliveryGroupSummary>();
  const membership = await membershipOf(db, deliveryIds);
  const groupIds = [...new Set(membership.values())];
  if (!groupIds.length) return result;
  const [groupRows, memberRows] = await Promise.all([
    db
      .select({ id: deliveryGroups.id, siteId: deliveryGroups.siteId })
      .from(deliveryGroups)
      .where(inArray(deliveryGroups.id, groupIds)),
    db
      .select({
        groupId: deliveryGroupMembers.groupId,
        deliveryId: deliveries.id,
        displayId: deliveries.displayId,
        hasEdo: drSql<boolean>`exists (select 1 from ${deliveryEdoMatches} where ${deliveryEdoMatches.deliveryId} = ${deliveries.id})`,
      })
      .from(deliveryGroupMembers)
      .innerJoin(deliveries, eq(deliveries.id, deliveryGroupMembers.deliveryId))
      .where(inArray(deliveryGroupMembers.groupId, groupIds))
      .orderBy(desc(deliveries.displayId)),
  ]);
  const summaries = new Map<string, DeliveryGroupSummary>();
  for (const group of groupRows) {
    const members = memberRows.filter((row) => row.groupId === group.id);
    summaries.set(group.id, {
      id: group.id,
      siteId: group.siteId,
      members: members.map((row) => ({ deliveryId: row.deliveryId, displayId: row.displayId })),
      ...(opts.withEdo ? { edoLinkedCount: members.filter((row) => row.hasEdo).length } : {}),
    });
  }
  for (const [deliveryId, groupId] of membership) {
    const summary = summaries.get(groupId);
    if (summary) result.set(deliveryId, summary);
  }
  return result;
}

/**
 * Текущий состав группы под `FOR SHARE` — для пакетной привязки УПД. Вызывать
 * после блокировки приёмок (тот же порядок «приёмки → группа»). null — группы
 * нет.
 */
export async function lockGroupForLink(tx: Reader, groupId: string): Promise<string[] | null> {
  const [group] = await tx
    .select({ id: deliveryGroups.id })
    .from(deliveryGroups)
    .where(eq(deliveryGroups.id, groupId))
    .for('share');
  if (!group) return null;
  const rows = await tx
    .select({ deliveryId: deliveryGroupMembers.deliveryId })
    .from(deliveryGroupMembers)
    .where(eq(deliveryGroupMembers.groupId, groupId));
  return rows.map((row) => row.deliveryId);
}
