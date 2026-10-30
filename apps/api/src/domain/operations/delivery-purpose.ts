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

import { and, eq } from 'drizzle-orm';
import {
  DeliveryPurposeSchema,
  deliveryRecipientKind,
  reconcileDocumentPurpose,
  reconcileDeliveryPurpose,
  type DocumentRecipientState,
  type DeliveryPurpose,
} from '@matcheck/contracts';
import { deliveries, deliverySources } from '../../db/schema.js';

export type RecipientPair = { contractorId: string | null; recipientMolId: string | null };
export type GeneralRecipient = RecipientPair & { purpose: DeliveryPurpose | null };

/** Зовётся только после блокировки deliveries: порядок блокировок всегда одинаков. */
export async function reconcileLinkedDocumentPurposes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  deliveryId: string,
  previous: GeneralRecipient,
  next: GeneralRecipient,
): Promise<void> {
  if (
    deliveryRecipientKind(previous) === deliveryRecipientKind(next) &&
    previous.purpose === next.purpose
  )
    return;
  const rows: (typeof deliverySources.$inferSelect)[] = await tx
    .select()
    .from(deliverySources)
    .where(eq(deliverySources.deliveryId, deliveryId))
    .orderBy(deliverySources.sourceDocumentId)
    .for('update');
  for (const row of rows) {
    const before: DocumentRecipientState = {
      ownRecipient: row.ownRecipient,
      contractorId: row.contractorId,
      recipientMolId: row.recipientMolId,
      ownPurpose: row.ownPurpose,
      purpose: DeliveryPurposeSchema.nullable().parse(row.purpose),
    };
    const after = reconcileDocumentPurpose(previous, next, before, before);
    if (after.ownPurpose !== before.ownPurpose || after.purpose !== before.purpose) {
      await tx
        .update(deliverySources)
        .set({ ownPurpose: after.ownPurpose, purpose: after.purpose })
        .where(
          and(
            eq(deliverySources.deliveryId, deliveryId),
            eq(deliverySources.sourceDocumentId, row.sourceDocumentId),
          ),
        );
    }
  }
}

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
  chosenPurpose?: DeliveryPurpose,
): Promise<{ purpose: string | null } | undefined> {
  const [row] = await tx
    .select({
      contractorId: deliveries.contractorId,
      recipientMolId: deliveries.recipientMolId,
      purpose: deliveries.purpose,
      recipientsPerDocument: deliveries.recipientsPerDocument,
    })
    .from(deliveries)
    .where(eq(deliveries.id, deliveryId))
    .for('update');
  if (!row) return undefined;
  const cur = currentPurpose(row.purpose);
  if ('raw' in cur && chosenPurpose === undefined) return { purpose: cur.raw };
  const previousPurpose = 'raw' in cur ? null : cur.known;
  const nextPurpose =
    chosenPurpose ??
    reconcileDeliveryPurpose(
      deliveryRecipientKind(row),
      deliveryRecipientKind(next),
      previousPurpose,
    );
  if (row.recipientsPerDocument) {
    await reconcileLinkedDocumentPurposes(
      tx,
      deliveryId,
      {
        contractorId: row.contractorId,
        recipientMolId: row.recipientMolId,
        purpose: previousPurpose,
      },
      { ...next, purpose: nextPurpose },
    );
  }
  return {
    purpose: nextPurpose,
  };
}
