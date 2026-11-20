// «Одна машина — одна приёмка» при создании приёмки.
//
// Две половины, потому что занятие (operation_group_claims) ссылается на
// приёмку внешним ключом: вставить его можно только ПОСЛЕ шапки.
//   1. prepareMachineClaim — ПЕРВЫМ действием транзакции: замок машины, затем
//      проверки. Порядок проверок важен: «машина уже занята» раньше «состав
//      изменился» — офлайн-планшету со старой формой нужно услышать, что машину
//      оформили, а не что надо перепроверить состав машины, которую ему уже не
//      оформить.
//   2. commitMachineClaim — после вставки шапки: занятие машины. PK
//      (вид, машина) — страховка: второй такой INSERT невозможен физически.
//
// Где действует. Защищённая область — объект в GROUP_CLAIM_SITES или
// объединённая машина (её безопасность держится только на протоколе). Вне
// неё — прежний путь без единой новой проверки.
//
// Кто как проходит.
//   * Клиент без group_claim_v1 (старая сборка, старая вкладка портала) —
//     426 client_outdated: typed-конфликты он не поймёт, а молча создать
//     вторую приёмку нельзя. Старое приложение замораживает такую мутацию с
//     целыми данными; новая сборка её размораживает и отправляет заново.
//   * Планшет (мобильный клиент) — полные проверки: занятость, groupId и
//     ревизия формы, полнота состава.
//   * Портал — только занятость: менеджер может оформить приёмку и по части
//     машины, но не вторую на уже занятую машину.

import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { GroupConflict } from '@matcheck/contracts';
import type { Db } from '../../db/client.js';
import {
  deliveries,
  deliverySources,
  operationGroupClaimEvents,
  operationGroupClaims,
} from '../../db/schema.js';
import { HttpError } from '../../lib/http-error.js';
import { lockMachine, resolveHead } from '../sourceDocuments/machine-lock.js';
import {
  compareWithComposition,
  resolveGroupComposition,
} from '../sourceDocuments/group-composition.js';
import { clientSupportsGroupClaim, groupClaimEnabledForSite } from './claim-scope.js';

/** Typed-отказ протокола — маршрут отдаёт его телом 409 как есть. */
export class GroupConflictError extends Error {
  constructor(readonly conflict: GroupConflict) {
    super(conflict.error);
    this.name = 'GroupConflictError';
  }
}

/** Клиент не понимает протокол, а объект защищён — пусть обновится. */
export class ClientOutdatedError extends HttpError {
  constructor() {
    super(
      426,
      'Обновите приложение: на этом объекте работает защита от повторного оформления машины',
    );
    this.name = 'client_outdated';
  }
}

export type MachineClaimContext = {
  capabilities: Set<string>;
  /** Мобильный клиент — полные проверки; портал — только занятость. */
  mobile: boolean;
  actorUserId: string | null;
};

export type PreparedClaim = { headId: string; groupRevision: number | null };

/** Объединена ли машина головы (есть участники). */
async function isMergedHead(tx: Db, headId: string): Promise<boolean> {
  const rows = await tx.execute<{ yes: boolean }>(sql`
    select exists (select 1 from machine_merges where target_root_id = ${headId}::uuid) as yes
  `);
  return [...rows][0]?.yes === true;
}

/**
 * Проверки до шапки приёмки. null — область не защищена или у документов нет
 * машины: прежний путь, занятия не будет.
 *
 * Вызывать ПЕРВЫМ действием транзакции создания: берёт замок машины.
 */
export async function prepareMachineClaim(
  tx: Db,
  args: {
    operationId: string;
    documentIds: string[];
    siteId: string | null;
    clientGroupId?: string | null;
    clientGroupRevision?: number | null;
    ctx: MachineClaimContext;
  },
): Promise<PreparedClaim | null> {
  const first = args.documentIds[0];
  if (!first) return null;
  // Защищённость — до блокировок (чтение без захвата): вне области ничего не
  // блокируем, чтобы прежний путь остался ровно прежним.
  const head = await resolveHead(tx, { documentId: first });
  const merged = head ? await isMergedHead(tx, head) : false;
  if (!groupClaimEnabledForSite(args.siteId) && !merged) return null;
  if (!clientSupportsGroupClaim(args.ctx.capabilities)) throw new ClientOutdatedError();

  // Замок машины — голова, участники, дети, документы. Между проверкой и
  // вставкой занятия состав машины не изменится, а второй создатель ждёт здесь.
  await lockMachine(tx, first);

  const resolved = await resolveGroupComposition(tx, {
    documentIds: args.documentIds,
    siteId: args.siteId,
    direction: 'inbound',
  });
  if ('error' in resolved) {
    const err = resolved.error;
    throw new GroupConflictError(
      err.kind === 'duplicate_documents'
        ? { error: 'group_incomplete', groupId: null, extraDocumentIds: err.documentIds }
        : err.kind === 'multiple_groups'
          ? { error: 'group_incomplete', groupId: null }
          : { error: 'group_changed', groupId: null },
    );
  }
  const { composition } = resolved;
  // Документы машины не образуют (одиночный, ручной внос) — прежний путь.
  if (!composition.groupId) return null;

  // 1) Занята ли машина: claim чужой операции или живая приёмка по её
  //    документам (созданная порталом, старой сборкой или до включения).
  const [claim] = await tx
    .select({
      deliveryId: operationGroupClaims.deliveryId,
      createdAt: operationGroupClaims.createdAt,
    })
    .from(operationGroupClaims)
    .where(
      and(
        eq(operationGroupClaims.operationKind, 'delivery'),
        eq(operationGroupClaims.groupId, composition.groupId),
      ),
    );
  if (claim && claim.deliveryId !== args.operationId) {
    throw new GroupConflictError({
      error: 'group_claimed',
      groupId: composition.groupId,
      groupRevision: composition.groupRevision ?? null,
      claimedByOperationId: claim.deliveryId,
      claimedAt: claim.createdAt.toISOString(),
    });
  }
  const machineDocIds = await machineDocumentIds(tx, composition.groupId);
  const [live] = machineDocIds.length
    ? await tx
        .select({ id: deliveries.id, createdAt: deliveries.createdAt })
        .from(deliverySources)
        .innerJoin(deliveries, eq(deliveries.id, deliverySources.deliveryId))
        .where(
          and(
            inArray(deliverySources.sourceDocumentId, machineDocIds),
            isNull(deliveries.pendingDeletionAt),
            ne(deliveries.id, args.operationId),
          ),
        )
        .limit(1)
    : [];
  if (live) {
    throw new GroupConflictError({
      error: 'group_claimed',
      groupId: composition.groupId,
      groupRevision: composition.groupRevision ?? null,
      claimedByOperationId: live.id,
      claimedAt: live.createdAt.toISOString(),
    });
  }

  // 2) Планшет: форма открыта по той же машине и той же ревизии, состав полный.
  //    Нет groupId/ревизии — это мутация, созданная старой сборкой и отправленная
  //    уже обновлённым приложением: снимок устарел, пусть перепроверит.
  if (args.ctx.mobile) {
    if (
      !args.clientGroupId ||
      args.clientGroupRevision == null ||
      args.clientGroupId !== composition.groupId ||
      args.clientGroupRevision !== composition.groupRevision
    ) {
      throw new GroupConflictError({
        error: 'group_changed',
        groupId: composition.groupId,
        groupRevision: composition.groupRevision ?? null,
        expectedDocumentIds: composition.documentIds,
      });
    }
    const mismatch = compareWithComposition(args.documentIds, composition);
    if (mismatch && mismatch.kind === 'incomplete_group') {
      throw new GroupConflictError({
        error: 'group_incomplete',
        groupId: composition.groupId,
        groupRevision: composition.groupRevision ?? null,
        expectedDocumentIds: composition.documentIds,
        missingDocumentIds: mismatch.missing,
        extraDocumentIds: mismatch.extra,
      });
    }
  }
  return { headId: composition.groupId, groupRevision: composition.groupRevision ?? null };
}

/** Документы машины головы — все, включая технические. */
async function machineDocumentIds(tx: Db, headId: string): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    select d.id
      from (
        select ${headId}::uuid as rid
        union all
        select member_root_id from machine_merges where target_root_id = ${headId}::uuid
      ) mr
      join source_bundles b on coalesce(b.parent_bundle_id, b.id) = mr.rid
      join source_documents d on d.bundle_id = b.id
  `);
  return [...rows].map((r) => r.id);
}

/**
 * Занятие машины — после вставки шапки приёмки (внешний ключ). Повтор той же
 * пары (машина, приёмка) — успех: планшет переотправляет мутацию после обрыва.
 */
export async function commitMachineClaim(
  tx: Db,
  args: {
    headId: string;
    deliveryId: string;
    actorUserId: string | null;
    groupRevision: number | null;
  },
): Promise<void> {
  const inserted = await tx
    .insert(operationGroupClaims)
    .values({
      operationKind: 'delivery',
      groupId: args.headId,
      deliveryId: args.deliveryId,
      shipmentId: null,
      createdByUserId: args.actorUserId,
    })
    .onConflictDoNothing()
    .returning({ groupId: operationGroupClaims.groupId });
  if (inserted.length > 0) {
    await tx.insert(operationGroupClaimEvents).values({
      operationKind: 'delivery',
      groupId: args.headId,
      operationId: args.deliveryId,
      event: 'create',
      actorUserId: args.actorUserId,
    });
    return;
  }
  const [holder] = await tx
    .select({
      deliveryId: operationGroupClaims.deliveryId,
      createdAt: operationGroupClaims.createdAt,
    })
    .from(operationGroupClaims)
    .where(
      and(
        eq(operationGroupClaims.operationKind, 'delivery'),
        eq(operationGroupClaims.groupId, args.headId),
      ),
    );
  if (holder?.deliveryId === args.deliveryId) return;
  throw new GroupConflictError({
    error: 'group_claimed',
    groupId: args.headId,
    groupRevision: args.groupRevision,
    claimedByOperationId: holder?.deliveryId ?? null,
    claimedAt: holder?.createdAt ? holder.createdAt.toISOString() : null,
  });
}

/**
 * Привязка документа машины к приёмке с портала (link-source). В защищённой
 * области машина, уже занятая ДРУГОЙ приёмкой, не получает вторую молча:
 * 409 group_claimed, а осознанное исключение — флаг allowSecondOperation из
 * окна подтверждения и событие override в журнале claim'ов.
 *
 * Вызывать ПЕРВЫМ действием транзакции привязки (берёт замок машины).
 * Возвращает занимающую приёмку или null (свободна / область не защищена).
 */
export async function lockAndCheckMachineForLink(
  tx: Db,
  args: {
    documentId: string;
    deliveryId: string;
    siteId: string | null;
    allowSecondOperation: boolean;
    actorUserId: string | null;
  },
): Promise<{ occupiedBy: { id: string; displayId: number } } | null> {
  const head = await resolveHead(tx, { documentId: args.documentId });
  if (!head) return null;
  const merged = await isMergedHead(tx, head);
  if (!groupClaimEnabledForSite(args.siteId) && !merged) return null;
  const lock = await lockMachine(tx, args.documentId);
  if (!lock?.machineRootId) return null;
  const machineDocIds = lock.docs.map((d) => d.id);
  const [other] = await tx
    .select({ id: deliveries.id, displayId: deliveries.displayId })
    .from(deliverySources)
    .innerJoin(deliveries, eq(deliveries.id, deliverySources.deliveryId))
    .where(
      and(
        inArray(deliverySources.sourceDocumentId, machineDocIds),
        isNull(deliveries.pendingDeletionAt),
        ne(deliveries.id, args.deliveryId),
      ),
    )
    .limit(1);
  if (!other) return null;
  if (!args.allowSecondOperation) {
    return { occupiedBy: { id: other.id, displayId: Number(other.displayId) } };
  }
  await tx.insert(operationGroupClaimEvents).values({
    operationKind: 'delivery',
    groupId: lock.machineRootId,
    operationId: args.deliveryId,
    event: 'override',
    actorUserId: args.actorUserId,
    reason: `manual_link: машина уже в приёмке ${other.displayId}`,
  });
  return null;
}
