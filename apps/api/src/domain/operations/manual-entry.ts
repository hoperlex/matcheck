/**
 * «Ручной внос» / «Ручной вынос» — операция без машины одним этапом.
 *
 * Планшет (форма «Ручной внос/вынос») создаёт запись сразу в confirmed_mol, без
 * госномера и УПД, и пишет первой строкой комментария ровно «Ручной внос» /
 * «Ручной вынос». Портал (с 0153) создаёт такую запись с явным `isManual: true`.
 *
 * Флаг ставится ТОЛЬКО при создании записи и потом не меняется: комментарий
 * портал может переписать, а планшет и старая очередь мутаций поля не знают.
 *
 * «Создано сразу в confirmed_mol» само по себе ручной записью НЕ является:
 * обычная приёмка, оба этапа которой прошли офлайн, тоже приходит одним
 * запросом в confirmed_mol (на бою таких 131 на 18.11). Поэтому подпись
 * планшета — маркер в комментарии И допустимый вид записи.
 *
 * Чистые функции, без БД. Тест — test/manual-entry.test.ts.
 */

export type ManualEntryKind = 'delivery' | 'shipment';

export const MANUAL_ENTRY_MARKER: Record<ManualEntryKind, string> = {
  delivery: 'Ручной внос',
  shipment: 'Ручной вынос',
};

/** Поля запроса на создание, от которых зависит допустимость ручной записи. */
export interface ManualEntryInput {
  statusCode: string;
  vehiclePlate?: string | null;
  sourceDocumentIds?: readonly string[] | null;
  inTransit?: boolean | null;
  comment?: string | null;
  /** Только у отгрузок. */
  kind?: string | null;
  /** Явный флаг клиента (портал). Отсутствует у планшета и старых клиентов. */
  isManual?: boolean;
}

/** Первая строка комментария без хвостовых пробелов и `\r`. */
export function firstCommentLine(comment: string | null | undefined): string {
  if (!comment) return '';
  const nl = comment.indexOf('\n');
  return (nl === -1 ? comment : comment.slice(0, nl)).trimEnd();
}

/**
 * Почему запись НЕ может быть ручной; null — может. Текст — для ответа 400
 * порталу, поэтому по-русски и про то, что поправить.
 */
export function manualEntryViolation(
  kind: ManualEntryKind,
  input: ManualEntryInput,
): string | null {
  const noun = kind === 'delivery' ? 'Ручной внос' : 'Ручной вынос';
  if (input.statusCode !== 'confirmed_mol') {
    return `${noun} создаётся сразу подтверждённым МОЛ`;
  }
  if (input.vehiclePlate && input.vehiclePlate.trim() !== '') {
    return `${noun} оформляется без госномера`;
  }
  if (input.sourceDocumentIds && input.sourceDocumentIds.length > 0) {
    return `${noun} создаётся без документов — привяжите их после сохранения`;
  }
  if (input.inTransit) {
    return `${noun} не может быть транзитом`;
  }
  if (kind === 'shipment' && input.kind === 'transfer') {
    return 'Ручной вынос не может быть перемещением — оформите отгрузку с машиной';
  }
  return null;
}

export type ManualEntryDecision =
  | { ok: true; isManual: boolean }
  /** Явный `isManual: true` для записи, которая ручной быть не может. */
  | { ok: false; message: string };

/**
 * Решение при создании записи.
 *  - явный `isManual: true` → допустимо ? true : отказ (портал покажет текст);
 *  - явный `isManual: false` → false;
 *  - поля нет (планшет, старые клиенты) → маркер в первой строке комментария
 *    И допустимый вид → true, иначе false. Без отказа: 4xx на запрос планшета
 *    заблокировал бы его очередь мутаций.
 */
export function decideManualOnCreate(
  kind: ManualEntryKind,
  input: ManualEntryInput,
): ManualEntryDecision {
  const violation = manualEntryViolation(kind, input);
  if (input.isManual === true) {
    return violation ? { ok: false, message: violation } : { ok: true, isManual: true };
  }
  if (input.isManual === false) return { ok: true, isManual: false };
  const marked = firstCommentLine(input.comment) === MANUAL_ENTRY_MARKER[kind];
  return { ok: true, isManual: marked && violation === null };
}

/** Явный `isManual: true` у недопустимой записи — ответ 400 `invalid_manual_entry`. */
export class InvalidManualEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidManualEntryError';
  }
}

/** Перевод ручной отгрузки в перемещение — 422 `manual_transfer_forbidden`. */
export const MANUAL_TRANSFER_FORBIDDEN_MESSAGE =
  'Ручной вынос не может быть перемещением — оформите отгрузку с машиной';
