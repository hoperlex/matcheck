// Операции, в которых уже участвует машина: приёмки и отгрузки по её
// документам, привязки УПД из ЭДО и занятия машины (claim).
//
// Одна проверка на всех, кто меняет машину целиком: перенос объекта, слияние,
// разъединение, снятие объединений скриптом. Разъедься они — перенос отказал
// бы, а слияние пропустило бы машину, которую инспектор уже принял.
//
// Приёмки, помеченные на удаление, тоже считаются: пометку снимают, и приёмка
// возвращается с прежним составом документов.

import { inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  deliveries,
  deliveryEdoMatches,
  deliverySources,
  operationGroupClaims,
  shipmentSources,
} from '../../db/schema.js';
import { lockMachineHead, machineRootIdsOf } from './machine-lock.js';

export type MachineOperations = {
  /** Номера приёмок (display_id), где есть документы машины — для сообщения. */
  deliveryNumbers: number[];
  /** Сколько приёмок связано с документами машины. */
  deliveries: number;
  /** Привязки УПД из ЭДО к документам машины. */
  edoMatches: number;
  /** Отгрузки по документам машины. */
  shipments: number;
  /** Занятия машины протоколом claim. */
  claims: number;
};

export function hasMachineOperations(ops: MachineOperations): boolean {
  return ops.deliveries > 0 || ops.edoMatches > 0 || ops.shipments > 0 || ops.claims > 0;
}

/**
 * Операции по документам `documentIds` и занятия машин `headIds`.
 *
 * Читать под замком машины: иначе между проверкой и записью планшет успеет
 * создать приёмку.
 */
export async function machineOperations(
  tx: Db,
  documentIds: string[],
  headIds: string[],
): Promise<MachineOperations> {
  const linkedDeliveries = documentIds.length
    ? await tx
        .selectDistinct({ displayId: deliveries.displayId })
        .from(deliverySources)
        .innerJoin(deliveries, sql`${deliveries.id} = ${deliverySources.deliveryId}`)
        .where(inArray(deliverySources.sourceDocumentId, documentIds))
    : [];
  const [{ count: edoMatches } = { count: 0 }] = documentIds.length
    ? await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(deliveryEdoMatches)
        .where(inArray(deliveryEdoMatches.sourceDocumentId, documentIds))
    : [];
  const [{ count: shipments } = { count: 0 }] = documentIds.length
    ? await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(shipmentSources)
        .where(inArray(shipmentSources.sourceDocumentId, documentIds))
    : [];
  const [{ count: claims } = { count: 0 }] = headIds.length
    ? await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(operationGroupClaims)
        .where(inArray(operationGroupClaims.groupId, headIds))
    : [];
  const deliveryNumbers = linkedDeliveries.map((r) => Number(r.displayId)).sort((a, b) => a - b);
  return {
    deliveryNumbers,
    deliveries: deliveryNumbers.length,
    edoMatches,
    shipments,
    claims,
  };
}

/**
 * Состояние машины пакета ПОД ЗАМКОМ — для повторной отправки с /uploads.
 *
 * Берёт замок машины первым действием (machine-lock.ts) и смотрит:
 *   * `merged` — отправка входит в объединённую машину (голова или участник):
 *     перезапуск её поколения снёс бы документы части машины;
 *   * `busy` — по документам машины уже есть операция или claim: дозагрузка
 *     добавила бы документ в машину, которую инспектор уже принял.
 *
 * Решение о перезапуске или дозагрузке принимается раньше, без блокировок,
 * поэтому здесь — свежая перепроверка в той же транзакции, что и сама запись:
 * между ними менеджер мог объединить машину, а планшет — принять её.
 */
export async function machineGuardForBundle(
  tx: Db,
  bundleId: string,
): Promise<{ merged: boolean; busy: boolean }> {
  const head = await lockMachineHead(tx, { bundleId });
  if (!head.headId) return { merged: false, busy: false };
  const roots = await machineRootIdsOf(tx, head.headId);
  const docs = await tx.execute<{ id: string }>(sql`
    select d.id
      from source_documents d
      join source_bundles b on b.id = d.bundle_id
     where coalesce(b.parent_bundle_id, b.id) in (${sql.join(
       roots.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
  `);
  const ops = await machineOperations(
    tx,
    [...docs].map((r) => r.id),
    [head.headId],
  );
  return { merged: roots.length > 1, busy: hasMachineOperations(ops) };
}
