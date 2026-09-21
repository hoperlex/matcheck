/**
 * Продвижение курсора по ленте событий Диадока.
 *
 * Правило одно и оно жёсткое: курсор сдвигается до последнего НЕПРЕРЫВНО
 * терминального события, а на первом нетерминальном обход страницы
 * прекращается. Соблазн «взять последнее успешное» велик, но он означает
 * потерю: если третье событие из пяти не забралось, а курсор встал на пятое,
 * к третьему не вернётся никто и никогда — ни ошибки, ни следа, документа
 * просто нет в портале.
 *
 * «Взять максимум IndexKey» тоже нельзя: это непрозрачный ключ Диадока, а не
 * наш возрастающий счётчик, и сравнивать его как число или строку — гадание.
 * Единственный порядок, которому можно верить, — порядок ответа.
 *
 * Отдельно: терминальность определяет ТРАНСПОРТ вложения (забрали и сохранили),
 * а не его дальнейшая судьба. Вложение, ждущее включения разбора, для курсора
 * терминально — иначе первый же неформализованный файл застопорил бы ящик
 * навсегда, и следующие за ним обычные УПД не импортировались бы.
 */

/** Статусы транспорта, после которых к вложению возвращаться незачем. */
const TERMINAL_TRANSPORT = new Set([
  'stored',
  'skipped',
  'too_large',
  'encrypted',
  'vanished',
]);

export type ReceiptState = {
  transportStatus: string;
  attempts: number;
};

export type EventState = {
  eventId: string;
  indexKey: string;
  receipts: readonly ReceiptState[];
};

export const EDO_RECEIPT_MAX_ATTEMPTS = 5;

/**
 * Терминально ли вложение.
 *
 * `failed` считается терминальным только после исчерпания попыток: до этого
 * сбой мог быть случайным, и возврат к нему — весь смысл журнала.
 */
export function isReceiptTerminal(
  receipt: ReceiptState,
  maxAttempts = EDO_RECEIPT_MAX_ATTEMPTS,
): boolean {
  if (TERMINAL_TRANSPORT.has(receipt.transportStatus)) return true;
  return receipt.transportStatus === 'failed' && receipt.attempts >= maxAttempts;
}

/**
 * Событие терминально, когда терминальны все его вложения.
 *
 * Событие без вложений терминально сразу: брать в нём нечего — это служебный
 * патч, исходящее сообщение или уведомление о статусе.
 */
export function isEventTerminal(
  event: EventState,
  maxAttempts = EDO_RECEIPT_MAX_ATTEMPTS,
): boolean {
  return event.receipts.every((r) => isReceiptTerminal(r, maxAttempts));
}

/**
 * Куда сдвинуть курсор после обработки страницы.
 *
 * Возвращает прежнее значение, если первое же событие не доведено до конца, —
 * тогда следующий проход начнёт с него же.
 */
export function advanceCursor(
  current: string | null,
  events: readonly EventState[],
  maxAttempts = EDO_RECEIPT_MAX_ATTEMPTS,
): string | null {
  let cursor = current;
  for (const event of events) {
    if (!isEventTerminal(event, maxAttempts)) break;
    cursor = event.indexKey;
  }
  return cursor;
}

/**
 * Сколько событий страницы можно считать пройденными.
 *
 * Нужно вызывающему, чтобы понять, стоит ли запрашивать следующую страницу:
 * если обход упёрся в середину, продолжать нет смысла — сперва надо добрать
 * застрявшее.
 */
export function terminalPrefixLength(
  events: readonly EventState[],
  maxAttempts = EDO_RECEIPT_MAX_ATTEMPTS,
): number {
  let count = 0;
  for (const event of events) {
    if (!isEventTerminal(event, maxAttempts)) break;
    count += 1;
  }
  return count;
}
