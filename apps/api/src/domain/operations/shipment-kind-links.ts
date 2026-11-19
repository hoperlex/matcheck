// Согласованность вида отгрузки с получателем и объектом «Куда».
//
// Зовут upsert отгрузки (ранний ответ по запросу и, при keepReceiver, повторно
// под блокировкой строки) и PATCH /shipments/:id/recipient. CHECK в базе
// (shipments_kind_links_chk) дал бы грубую ошибку — клиенту отдаём понятную.

import type { ShipmentKind } from '@matcheck/contracts';

/**
 * Результат проверки согласованности kind ↔ receiver/destSite.
 * `code='receiver_required'` нужен mobile, чтобы отличить «документ
 * не дозаполнен — попросить менеджера» от «клиент послал мусор».
 * Остальные ошибки — обычные `invalid_kind_links` (400).
 */
export type KindLinksError = {
  code: 'receiver_required' | 'invalid_kind_links';
  message: string;
};

export type KindLinksInput = {
  kind: ShipmentKind;
  siteId: string;
  receiverCounterpartyId?: string | null;
  receiverMolId?: string | null;
  destSiteId?: string | null;
  sourceDocumentIds?: readonly string[] | null;
};

/** HTTP-код ответа на нарушение: «не дозаполнено» — 422, остальное — 400. */
export function kindLinksStatus(err: KindLinksError): 400 | 422 {
  return err.code === 'receiver_required' ? 422 : 400;
}

/**
 * Нарушение, найденное под блокировкой строки в транзакции upsert — маршрут
 * отвечает тем же кодом, что и ранняя проверка, транзакция откатывается.
 */
export class ShipmentKindLinksError extends Error {
  constructor(readonly detail: KindLinksError) {
    super(detail.message);
    this.name = 'ShipmentKindLinksError';
  }
}

export function validateKindLinks(input: KindLinksInput): KindLinksError | null {
  const { kind, receiverCounterpartyId, receiverMolId, destSiteId, siteId, sourceDocumentIds } =
    input;
  // Получатель указан XOR через counterparty или МОЛ (двух одновременно — нельзя).
  const hasContractorReceiver = Boolean(receiverCounterpartyId);
  const hasMolReceiver = Boolean(receiverMolId);
  const hasAnyReceiver = hasContractorReceiver || hasMolReceiver;
  const hasBothReceivers = hasContractorReceiver && hasMolReceiver;
  const bad = (message: string): KindLinksError => ({ code: 'invalid_kind_links', message });
  const noReceiver = (message: string): KindLinksError => ({
    code: 'receiver_required',
    message,
  });
  // Empty-draft = отгрузка без привязанной УПД (создана инспектором через
  // «Создать отгрузку» на мобиле). У таких отгрузок получатель может быть
  // не указан — менеджер дозaпoлнит на портале. Конфликт с DB-CHECK
  // shipments_kind_links_chk решается тем, что для contractor допускается
  // запись без receiver (CHECK не запрещает оба NULL).
  const isEmptyDraft = !sourceDocumentIds || sourceDocumentIds.length === 0;

  if (kind === 'contractor') {
    if (hasBothReceivers) return bad('Укажите получателя одним способом: подрядчик или МОЛ');
    if (!hasAnyReceiver && !isEmptyDraft) {
      return noReceiver('Для отгрузки нужен получатель (подрядчик или МОЛ)');
    }
    if (destSiteId) return bad('destSiteId допустим только для перемещения');
    return null;
  }
  if (kind === 'return') {
    if (hasMolReceiver) return bad('Возврат поставщику оформляется только на контрагента');
    if (!hasContractorReceiver) return noReceiver('Для возврата нужен получатель-поставщик');
    if (destSiteId) return bad('destSiteId допустим только для перемещения');
    return null;
  }
  if (kind === 'transfer') {
    if (!destSiteId) return bad('Для перемещения нужен объект-получатель');
    if (destSiteId === siteId) return bad('Объект-получатель не может совпадать с источником');
    if (hasBothReceivers) return bad('Укажите получателя одним способом: подрядчик или МОЛ');
    if (!hasAnyReceiver)
      return noReceiver('Для перемещения нужен получатель на новом объекте (подрядчик или МОЛ)');
    return null;
  }
  // writeoff
  if (hasAnyReceiver || destSiteId) return bad('Для списания получатель не указывается');
  return null;
}
