// Вычисление watermark опроса почтового ящика.
//
// Watermark (`mail_accounts.last_uid`) — граница, ниже которой письма считаются
// обработанными: следующий проход берёт только `uid > last_uid`. Ошибка здесь
// стоит дорого — сдвинули лишнего, и письмо с УПД не вернётся уже никогда.
//
// Правило: watermark двигается по НЕПРЕРЫВНОМУ ПРЕФИКСУ терминальных записей,
// а не по максимальному терминальному UID. Если письмо 10 сорвалось, а 11
// обработалось успешно, watermark обязан остаться на 9: иначе десятое выпадет
// из выборки навсегда. Ценой повторной обработки одиннадцатого (её гасит дедуп
// по `message_hash`) не теряем ни одного письма.
//
// Тот же принцип уже применён в приёме заявок (domain/jobs/mail-requests.ts).

import type { MailReceiptStatus } from '@matcheck/contracts';

/** Сколько раз пробуем забрать письмо, прежде чем считать попытку исчерпанной. */
export const RECEIPT_MAX_ATTEMPTS = 5;

export type ReceiptState = {
  uid: number;
  status: MailReceiptStatus;
  attempts: number;
};

/**
 * Терминальна ли запись — то есть можно ли перестать возвращаться к этому UID.
 *
 * `fetch_failed` и `parse_failed` терминальны ТОЛЬКО после исчерпания попыток:
 * пока попытки остались, письмо ещё будет перечитано, и watermark его
 * перешагивать нельзя.
 */
export function isTerminal(receipt: ReceiptState, maxAttempts = RECEIPT_MAX_ATTEMPTS): boolean {
  switch (receipt.status) {
    case 'parsed':
    case 'skipped_by_size':
    case 'vanished':
      return true;
    case 'fetch_failed':
    case 'parse_failed':
      return receipt.attempts >= maxAttempts;
    case 'fetching':
      return false;
    default:
      return false;
  }
}

/**
 * Новое значение watermark по записям текущего прохода.
 *
 * Возвращает максимальный UID непрерывного терминального префикса, но никогда
 * не меньше текущего значения — watermark не откатывается назад даже если
 * сервер отдал старые письма.
 */
export function computeWatermark(
  current: number,
  receipts: readonly ReceiptState[],
  maxAttempts = RECEIPT_MAX_ATTEMPTS,
): number {
  const ordered = [...receipts].sort((a, b) => a.uid - b.uid);
  let watermark = current;
  for (const receipt of ordered) {
    // Пропускаем всё, что уже под watermark: повторная выдача старых писем
    // сервером не должна ни двигать границу, ни ломать префикс.
    if (receipt.uid <= watermark) continue;
    if (!isTerminal(receipt, maxAttempts)) break;
    watermark = receipt.uid;
  }
  return watermark;
}

/**
 * Смена UIDVALIDITY означает, что прежние UID больше не действительны: сервер
 * перенумеровал ящик. Продолжать с прежним watermark нельзя — либо пропустим
 * письма, либо будем перечитывать чужие.
 */
export function needsWatermarkReset(
  storedUidValidity: number | null,
  serverUidValidity: number,
): boolean {
  return storedUidValidity !== null && storedUidValidity !== serverUidValidity;
}
