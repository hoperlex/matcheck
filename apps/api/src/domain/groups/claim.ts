// Инвариант «одна машина — одна операция».
//
// Проверки видимости для этого недостаточно, и это главное, что нужно понимать
// про модуль. Два планшета могут одновременно увидеть машину свободной, оба
// пройти любую проверку в коде и оба создать приёмку: между чтением и записью
// нет ничего, что бы их развело. Гарантию даёт СУБД — первичный ключ
// (operation_kind, group_id) в operation_group_claims: второй INSERT просто не
// проходит. Поэтому здесь нет «проверить, потом вставить»: вставка И ЕСТЬ
// проверка.
//
// Порядок блокировок фиксирован: корневой пакет → операция → связи. Он должен
// совпадать у всех, кто трогает группу (воркер, повторный разбор, ручной
// разбор), иначе claim заблокирует корень и увидит состав, который прямо сейчас
// меняется другой транзакцией.
//
// Клиент без capability сюда не попадает вовсе: старая сборка не понимает
// typed-конфликтов, и любой 4xx превращается у неё в потерянную работу
// инспектора.

import { and, eq, sql } from 'drizzle-orm';
import type { GroupConflict } from '@matcheck/contracts';
import type { Db } from '../../db/client.js';
import { operationGroupClaimEvents, operationGroupClaims, sourceBundles } from '../../db/schema.js';
import {
  compareWithComposition,
  resolveGroupComposition,
} from '../sourceDocuments/group-composition.js';
import { clientSupportsGroups, groupModeEnabledForSite } from './group-mode.js';

export type OperationKind = 'delivery' | 'shipment';

export type ClaimOutcome =
  /** Групповых ограничений нет либо claim успешно занят этой операцией. */
  | { ok: true }
  /** Операцию проводить нельзя; ответ уже готов для клиента. */
  | { conflict: GroupConflict };

export type EnforceClaimArgs = {
  operationKind: OperationKind;
  operationId: string;
  documentIds: string[];
  siteId: string | null;
  direction: 'inbound' | 'outbound';
  capabilities: Set<string>;
  /** OCC-токены клиента; сервер им не доверяет, а лишь сверяет со своими. */
  clientGroupId?: string | null;
  clientGroupRevision?: number | null;
  actorUserId?: string | null;
};

/**
 * Проводит операцию через групповые проверки и занимает машину.
 *
 * Вызывать ВНУТРИ транзакции операции, до записи связей: отказ обязан
 * откатывать всё, иначе останется приёмка без claim — то есть ровно та дыра,
 * ради которой claim и вводится.
 */
export async function enforceGroupClaim(tx: Db, args: EnforceClaimArgs): Promise<ClaimOutcome> {
  // Старая сборка и выключенный режим — прежний путь целиком.
  if (!clientSupportsGroups(args.capabilities)) return { ok: true };
  if (!groupModeEnabledForSite(args.siteId)) return { ok: true };

  const resolved = await resolveGroupComposition(tx, {
    documentIds: args.documentIds,
    siteId: args.siteId,
    direction: args.direction,
  });

  if ('error' in resolved) {
    const err = resolved.error;
    if (err.kind === 'duplicate_documents') {
      return {
        conflict: {
          error: 'group_incomplete',
          groupId: null,
          extraDocumentIds: err.documentIds,
        },
      };
    }
    if (err.kind === 'multiple_groups') {
      // Документы двух разных машин в одной операции: состав заведомо не тот,
      // и какую именно машину занимать — неизвестно.
      return { conflict: { error: 'group_incomplete', groupId: null } };
    }
    return { conflict: { error: 'group_changed', groupId: null } };
  }

  const { composition } = resolved;
  // Группы нет — одиночный документ, ручной внос, legacy-сборка. Самый частый
  // случай, и он обязан идти прежним путём без claim.
  if (!composition.groupId) return { ok: true };

  // Блокируем корень до сверки: между чтением состава и вставкой claim воркер
  // не должен успеть добавить в машину документ.
  await tx.execute(sql`
    select id from ${sourceBundles} where id = ${composition.groupId}::uuid for update
  `);

  // Машина не готова целиком: предикат видимости не пропустил ни одного
  // документа, значит на планшете её сейчас нет вовсе.
  if (composition.documentIds.length === 0) {
    return {
      conflict: {
        error: 'source_documents_not_ready',
        groupId: composition.groupId,
        groupRevision: composition.groupRevision ?? null,
      },
    };
  }

  // Клиент умеет группы, но прислал догрупповой запрос: он работает с
  // представлением, в котором эта машина ещё не была машиной.
  if (!args.clientGroupId || args.clientGroupRevision == null) {
    return {
      conflict: {
        error: 'group_changed',
        groupId: composition.groupId,
        groupRevision: composition.groupRevision ?? null,
        expectedDocumentIds: composition.documentIds,
      },
    };
  }
  if (args.clientGroupId !== composition.groupId) {
    return {
      conflict: {
        error: 'group_changed',
        groupId: composition.groupId,
        groupRevision: composition.groupRevision ?? null,
        expectedDocumentIds: composition.documentIds,
      },
    };
  }
  // Ревизия ловит то, чего не ловит сравнение множества id: состав тот же, а
  // позиции или реквизиты изменились. Инспектор не должен подтверждать
  // материалы, которых он не видел.
  if (args.clientGroupRevision !== composition.groupRevision) {
    return {
      conflict: {
        error: 'group_changed',
        groupId: composition.groupId,
        groupRevision: composition.groupRevision ?? null,
        expectedDocumentIds: composition.documentIds,
      },
    };
  }

  const mismatch = compareWithComposition(args.documentIds, composition);
  if (mismatch && mismatch.kind === 'incomplete_group') {
    return {
      conflict: {
        error: 'group_incomplete',
        groupId: composition.groupId,
        groupRevision: composition.groupRevision ?? null,
        expectedDocumentIds: composition.documentIds,
        missingDocumentIds: mismatch.missing,
        extraDocumentIds: mismatch.extra,
      },
    };
  }

  return claimGroup(tx, {
    operationKind: args.operationKind,
    operationId: args.operationId,
    groupId: composition.groupId,
    groupRevision: composition.groupRevision ?? null,
    actorUserId: args.actorUserId ?? null,
  });
}

/**
 * Занимает машину под операцию.
 *
 * `onConflictDoNothing` вместо предварительной проверки — единственный способ
 * выиграть гонку двух планшетов: проверка «свободна ли» и вставка обязаны быть
 * одним действием.
 *
 * Повтор той же пары (машина, операция) — успех, а не конфликт: планшет
 * переотправляет мутацию после обрыва связи, и второй ответ обязан совпасть с
 * первым.
 */
async function claimGroup(
  tx: Db,
  args: {
    operationKind: OperationKind;
    operationId: string;
    groupId: string;
    groupRevision: number | null;
    actorUserId: string | null;
  },
): Promise<ClaimOutcome> {
  const inserted = await tx
    .insert(operationGroupClaims)
    .values({
      operationKind: args.operationKind,
      groupId: args.groupId,
      deliveryId: args.operationKind === 'delivery' ? args.operationId : null,
      shipmentId: args.operationKind === 'shipment' ? args.operationId : null,
      createdByUserId: args.actorUserId,
    })
    .onConflictDoNothing()
    .returning({ groupId: operationGroupClaims.groupId });

  if (inserted.length > 0) {
    await tx.insert(operationGroupClaimEvents).values({
      operationKind: args.operationKind,
      groupId: args.groupId,
      operationId: args.operationId,
      event: 'create',
      actorUserId: args.actorUserId,
    });
    return { ok: true };
  }

  // Не вставилось — машина занята. Кем именно, решает всё: своей же операцией
  // (повтор мутации) или чужой (реальный конфликт двух планшетов).
  const [existing] = await tx
    .select({
      deliveryId: operationGroupClaims.deliveryId,
      shipmentId: operationGroupClaims.shipmentId,
      createdAt: operationGroupClaims.createdAt,
    })
    .from(operationGroupClaims)
    .where(
      and(
        eq(operationGroupClaims.operationKind, args.operationKind),
        eq(operationGroupClaims.groupId, args.groupId),
      ),
    );

  const holder =
    args.operationKind === 'delivery' ? (existing?.deliveryId ?? null) : (existing?.shipmentId ?? null);
  if (holder === args.operationId) return { ok: true };

  return {
    conflict: {
      error: 'group_claimed',
      groupId: args.groupId,
      groupRevision: args.groupRevision,
      claimedByOperationId: holder,
      claimedAt: existing?.createdAt ? existing.createdAt.toISOString() : null,
    },
  };
}

/**
 * Освобождает машину и оставляет след в аудите.
 *
 * Событие пишется ДО удаления активной строки: каскад от удаления операции или
 * пакета снёс бы claim молча, и вопрос «кто и когда освободил машину» остался
 * бы без ответа ровно тогда, когда его задают.
 */
export async function releaseGroupClaim(
  tx: Db,
  args: {
    operationKind: OperationKind;
    operationId: string;
    actorUserId?: string | null;
    reason?: string;
  },
): Promise<void> {
  const idColumn =
    args.operationKind === 'delivery'
      ? operationGroupClaims.deliveryId
      : operationGroupClaims.shipmentId;

  const [held] = await tx
    .select({ groupId: operationGroupClaims.groupId })
    .from(operationGroupClaims)
    .where(and(eq(operationGroupClaims.operationKind, args.operationKind), eq(idColumn, args.operationId)));
  if (!held) return;

  await tx.insert(operationGroupClaimEvents).values({
    operationKind: args.operationKind,
    groupId: held.groupId,
    operationId: args.operationId,
    event: 'release',
    actorUserId: args.actorUserId ?? null,
    reason: args.reason ?? null,
  });
  await tx
    .delete(operationGroupClaims)
    .where(and(eq(operationGroupClaims.operationKind, args.operationKind), eq(idColumn, args.operationId)));
}
