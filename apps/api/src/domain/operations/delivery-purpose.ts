// Признак приёмки при записи получателя.
//
// Правило одно (reconcileDeliveryPurpose в контракте): получатель стал МОЛ —
// «Свои силы»; у подрядчика «Свои силы» не бывает. Запись получателя идёт
// разными путями — upsert (веб и планшет), парная приёмка перемещения, — а
// признак ставится отдельным PATCH. Чтобы их пересечение не оставило
// «подрядчик + Свои силы», каждый путь работает по одной схеме: заблокировать
// строку приёмки, посчитать признак по ЗАБЛОКИРОВАННЫМ значениям, записать.
//
// CHECK в базе на эту пару намеренно нет: путь записи получателя, который
// здесь не учтён, отдал бы планшету 500 на upsert и встал бы в его очереди.

import { eq } from 'drizzle-orm';
import {
  DeliveryPurposeSchema,
  deliveryRecipientKind,
  reconcileDeliveryPurpose,
  type DeliveryPurpose,
} from '@matcheck/contracts';
import { deliveries } from '../../db/schema.js';

export type RecipientPair = { contractorId: string | null; recipientMolId: string | null };

/** Признак новой приёмки: до неё получателя не было. */
export function purposeOnInsert(next: RecipientPair): DeliveryPurpose | null {
  return reconcileDeliveryPurpose(null, deliveryRecipientKind(next), null);
}

/** Текущее значение колонки; неизвестное (CHECK его не пустит) — как есть. */
function currentPurpose(raw: string | null): { known: DeliveryPurpose | null } | { raw: string } {
  if (raw == null) return { known: null };
  const parsed = DeliveryPurposeSchema.safeParse(raw);
  return parsed.success ? { known: parsed.data } : { raw };
}

/**
 * Блокирует строку приёмки (FOR UPDATE) и возвращает признак, который должен
 * лечь вместе с новым получателем. Вызывать первым оператором транзакции,
 * которая затем пишет получателя: конкурентная правка признака дождётся
 * блокировки и проверит его уже против нового получателя.
 *
 * undefined — строки нет; вызывающий сам решает, что это значит.
 */
export async function lockPurposeForRecipientWrite(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  deliveryId: string,
  next: RecipientPair,
): Promise<{ purpose: string | null } | undefined> {
  const [row] = await tx
    .select({
      contractorId: deliveries.contractorId,
      recipientMolId: deliveries.recipientMolId,
      purpose: deliveries.purpose,
    })
    .from(deliveries)
    .where(eq(deliveries.id, deliveryId))
    .for('update');
  if (!row) return undefined;
  const cur = currentPurpose(row.purpose);
  if ('raw' in cur) return { purpose: cur.raw };
  return {
    purpose: reconcileDeliveryPurpose(
      deliveryRecipientKind(row),
      deliveryRecipientKind(next),
      cur.known,
    ),
  };
}
