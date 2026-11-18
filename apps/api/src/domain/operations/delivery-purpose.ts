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

import { and, eq, isNull } from 'drizzle-orm';
import {
  DeliveryPurposeSchema,
  deliveryRecipientKind,
  reconcileDocumentPurpose,
  reconcileDeliveryPurpose,
  type DocumentRecipientState,
  type DeliveryPurpose,
} from '@matcheck/contracts';
import { deliveries, deliveryEdoMatches, deliverySources } from '../../db/schema.js';

export type RecipientPair = { contractorId: string | null; recipientMolId: string | null };
export type GeneralRecipient = RecipientPair & { purpose: DeliveryPurpose | null };

/** Собственные настройки документа — те же поля у скана и у УПД из ЭДО. */
export function documentStateOf(row: {
  ownRecipient: boolean;
  contractorId: string | null;
  recipientMolId: string | null;
  ownPurpose: boolean;
  purpose: string | null;
}): DocumentRecipientState {
  return {
    ownRecipient: row.ownRecipient,
    contractorId: row.contractorId,
    recipientMolId: row.recipientMolId,
    ownPurpose: row.ownPurpose,
    purpose: DeliveryPurposeSchema.nullable().parse(row.purpose),
  };
}

/**
 * Свободные УПД из ЭДО приёмки (без блока скана) под FOR UPDATE — документы
 * режима «Разные получатели» наравне с delivery_sources (0152). Брать после
 * блокировки deliveries и delivery_sources: порядок блокировок всегда
 * deliveries → delivery_sources → delivery_edo_matches.
 */
export async function lockFreeEdoMatches(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  deliveryId: string,
): Promise<(typeof deliveryEdoMatches.$inferSelect)[]> {
  return await tx
    .select()
    .from(deliveryEdoMatches)
    .where(
      and(eq(deliveryEdoMatches.deliveryId, deliveryId), isNull(deliveryEdoMatches.sectionDocumentId)),
    )
    .orderBy(deliveryEdoMatches.id)
    .for('update');
}

/**
 * Зовётся только после блокировки deliveries: порядок блокировок всегда
 * одинаков. Пересчитывает признаки всех документов режима — сканов и
 * свободных УПД из ЭДО: иначе смена общего признака (в том числе upsert
 * планшета) оставила бы УПД из ЭДО «подрядчик + Свои силы».
 */
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
    const before = documentStateOf(row);
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
  for (const row of await lockFreeEdoMatches(tx, deliveryId)) {
    const before = documentStateOf(row);
    const after = reconcileDocumentPurpose(previous, next, before, before);
    if (after.ownPurpose !== before.ownPurpose || after.purpose !== before.purpose) {
      await tx
        .update(deliveryEdoMatches)
        .set({ ownPurpose: after.ownPurpose, purpose: after.purpose })
        .where(eq(deliveryEdoMatches.id, row.id));
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
