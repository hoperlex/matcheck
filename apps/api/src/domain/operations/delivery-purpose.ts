// Признак приёмки при записи получателя.
//
// Правило одно (reconcileDeliveryPurpose в контракте): получатель стал МОЛ —
// «Свои силы»; у подрядчика «Свои силы» не бывает. Поверх него — справочник
// «Контрагенты → Объекты и вид» (nextDeliveryPurpose, миграция 0161): у
// подрядчика пустой признак заполняется видом пары подрядчик × объект при
// создании, фактической смене пары или первом подтверждении; подставленный
// признак (purpose_from_directory) следует за парой, ручной — никогда. Запись получателя идёт
// разными путями — upsert (веб и планшет), парная приёмка перемещения, — а
// признак ставится отдельным PATCH. Чтобы их пересечение не оставило
// «подрядчик + Свои силы», каждый путь работает по одной схеме: заблокировать
// строку приёмки, посчитать признак по ЗАБЛОКИРОВАННЫМ значениям, записать.
//
// CHECK в базе на эту пару намеренно нет: путь записи получателя, который
// здесь не учтён, отдал бы планшету 500 на upsert и встал бы в его очереди.

import { and, eq, isNull } from 'drizzle-orm';
import {
  allowedDeliveryPurposes,
  DeliveryPurposeSchema,
  deliveryPurposeNeedsDirectory,
  deliveryRecipientKind,
  directoryPurposeHint,
  nextDeliveryPurpose,
  reconcileDocumentPurpose,
  type DeliveryPurposeWrite,
  type DocumentRecipientState,
  type DeliveryPurpose,
} from '@matcheck/contracts';
import { deliveries, deliveryEdoMatches, deliverySources } from '../../db/schema.js';
import { directorySiteKindFor } from '../contractor-sites/purpose-hint.js';

export type RecipientPair = { contractorId: string | null; recipientMolId: string | null };
export type GeneralRecipient = RecipientPair & { purpose: DeliveryPurpose | null };

/**
 * Что пишется в получателя: новая пара или `'keep'` — получатель остаётся как
 * в строке. `'keep'` шлёт портал, когда получателя в форме не правили: он
 * сохраняется отдельным PATCH, и «Сохранить» устаревшей формы не должно
 * возвращать прежнее значение (флаг keepRecipient у upsert).
 */
export type RecipientWrite = RecipientPair | 'keep';

/**
 * Присланный признак не подходит получателю, который ляжет в строку. Маршрут
 * отвечает 422 purpose_conflicts_recipient; транзакция откатывается целиком.
 */
export class PurposeConflictsRecipientError extends Error {
  constructor() {
    super('purpose_conflicts_recipient');
    this.name = 'PurposeConflictsRecipientError';
  }
}

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

/** Признак и его источник — пишутся в строку приёмки вместе. */
export type PurposeOutcome = { purpose: DeliveryPurpose | null; fromDirectory: boolean };

/**
 * Считает признак по правилу и, только если правилу он нужен, берёт вид
 * пары подрядчик × объект из справочника (лишних запросов на upsert планшета нет).
 */
async function decidePurpose(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ex: any,
  a: Omit<DeliveryPurposeWrite, 'nextAuto'>,
  next: { contractorId: string | null; siteId: string | null },
): Promise<PurposeOutcome> {
  let nextAuto: DeliveryPurpose | null = null;
  if (deliveryPurposeNeedsDirectory(a)) {
    const found = await directorySiteKindFor(ex, next.contractorId, next.siteId);
    nextAuto = directoryPurposeHint(found?.kind ?? null).auto;
  }
  return nextDeliveryPurpose({ ...a, nextAuto });
}

/**
 * Признак новой приёмки: до неё получателя не было. Явный выбор
 * (`chosen`, upsert портала с признаком) пишется как есть.
 */
export async function purposeOnInsert(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ex: any,
  next: RecipientPair,
  siteId: string | null,
  chosen?: DeliveryPurpose,
): Promise<PurposeOutcome> {
  return decidePurpose(
    ex,
    {
      prevKind: null,
      nextKind: deliveryRecipientKind(next),
      purpose: null,
      fromDirectory: false,
      chosen,
      insert: true,
      pairChanged: false,
      firstConfirm: false,
      directoryAllowed: true,
    },
    { contractorId: next.contractorId, siteId },
  );
}

/**
 * Режим «Разные получатели»: документу дали своего получателя, а признак он
 * наследует от шапки, где его поставил справочник для ДРУГОГО получателя.
 * Такой признак документу не подходит и ушёл бы в 1С за чужую УПД — документ
 * получает собственный пустой признак (человек выберет сам).
 */
export function detachDirectoryPurpose(
  general: {
    contractorId: string | null;
    recipientMolId: string | null;
    purpose: DeliveryPurpose | null;
  },
  generalFromDirectory: boolean,
  doc: DocumentRecipientState,
): DocumentRecipientState {
  if (!generalFromDirectory || general.purpose === null) return doc;
  if (doc.ownPurpose || !doc.ownRecipient) return doc;
  if (doc.contractorId === general.contractorId && doc.recipientMolId === general.recipientMolId) {
    return doc;
  }
  return { ...doc, ownPurpose: true, purpose: null };
}

/** Текущее значение колонки; неизвестное (CHECK его не пустит) — как есть. */
function currentPurpose(raw: string | null): { known: DeliveryPurpose | null } | { raw: string } {
  if (raw == null) return { known: null };
  const parsed = DeliveryPurposeSchema.safeParse(raw);
  return parsed.success ? { known: parsed.data } : { raw };
}

/**
 * Блокирует строку приёмки (FOR UPDATE) и возвращает признак, который должен
 * лечь вместе с новым получателем, и его источник (`fromDirectory` пишется в
 * purpose_from_directory). Вызывать первым оператором транзакции,
 * которая затем пишет получателя: конкурентная правка признака дождётся
 * блокировки и проверит его уже против нового получателя.
 *
 * События справочника считаются по ЗАБЛОКИРОВАННОЙ строке: `nextSiteId` —
 * объект, который ляжет в строку (undefined — объект не пишется), `wantsConfirm`
 * — upsert подтверждает приёмку. Портал шлёт объект при каждом «Сохранить», а
 * планшет — получателя при каждом upsert: событием это становится, только если
 * значение действительно другое.
 *
 * Присланный признак (`chosenPurpose`) проверяется здесь же — по получателю,
 * который реально ляжет в строку. При `'keep'` это получатель из строки, а не
 * из запроса: предпроверка маршрута видит только запрос и при keepRecipient
 * пропустила бы «Свои силы» к сохранённому подрядчику.
 *
 * undefined — строки нет; вызывающий сам решает, что это значит.
 * `previous` / `recipient` — получатель до и после записи (для журнала).
 */
export async function lockPurposeForRecipientWrite(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  deliveryId: string,
  next: RecipientWrite,
  chosenPurpose?: DeliveryPurpose,
  opts: { nextSiteId?: string | null; wantsConfirm?: boolean } = {},
): Promise<
  | {
      purpose: string | null;
      fromDirectory: boolean;
      previous: RecipientPair;
      recipient: RecipientPair;
    }
  | undefined
> {
  const [row] = await tx
    .select({
      contractorId: deliveries.contractorId,
      recipientMolId: deliveries.recipientMolId,
      siteId: deliveries.siteId,
      purpose: deliveries.purpose,
      purposeFromDirectory: deliveries.purposeFromDirectory,
      confirmedByMolAt: deliveries.confirmedByMolAt,
      recipientsPerDocument: deliveries.recipientsPerDocument,
    })
    .from(deliveries)
    .where(eq(deliveries.id, deliveryId))
    .for('update');
  if (!row) return undefined;
  const previous: RecipientPair = {
    contractorId: row.contractorId,
    recipientMolId: row.recipientMolId,
  };
  const recipient: RecipientPair = next === 'keep' ? previous : next;
  if (
    chosenPurpose !== undefined &&
    !allowedDeliveryPurposes(deliveryRecipientKind(recipient)).includes(chosenPurpose)
  ) {
    throw new PurposeConflictsRecipientError();
  }
  const cur = currentPurpose(row.purpose);
  if ('raw' in cur && chosenPurpose === undefined) {
    return { purpose: cur.raw, fromDirectory: row.purposeFromDirectory, previous, recipient };
  }
  const previousPurpose = 'raw' in cur ? null : cur.known;
  const nextSiteId = opts.nextSiteId === undefined ? row.siteId : opts.nextSiteId;
  const decided = await decidePurpose(
    tx,
    {
      prevKind: deliveryRecipientKind(previous),
      nextKind: deliveryRecipientKind(recipient),
      purpose: previousPurpose,
      fromDirectory: row.purposeFromDirectory,
      chosen: chosenPurpose,
      insert: false,
      pairChanged:
        previous.contractorId !== recipient.contractorId ||
        previous.recipientMolId !== recipient.recipientMolId ||
        nextSiteId !== row.siteId,
      firstConfirm: opts.wantsConfirm === true && row.confirmedByMolAt === null,
      directoryAllowed: !row.recipientsPerDocument,
    },
    { contractorId: recipient.contractorId, siteId: nextSiteId },
  );
  const nextPurpose = decided.purpose;
  if (row.recipientsPerDocument) {
    await reconcileLinkedDocumentPurposes(
      tx,
      deliveryId,
      { ...previous, purpose: previousPurpose },
      { ...recipient, purpose: nextPurpose },
    );
  }
  return { purpose: nextPurpose, fromDirectory: decided.fromDirectory, previous, recipient };
}
