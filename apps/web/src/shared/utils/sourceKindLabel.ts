import type { OperationSourceDocument } from '@matcheck/contracts';

/** Вид документа-источника: тот же union, что в контракте (SourceKindSchema). */
type SourceKind = OperationSourceDocument['kind'];

/**
 * Человеческое название вида документа.
 *
 * Раньше это правило жило тремя копиями тернарника (истории приёмок и отгрузок,
 * список «Документы»), и карточка приёмки вовсе печатала «УПД» для чего угодно —
 * накладная в шапке была подписана неверно. Тексты сохранены прежними: «ТН» и
 * прочие сокращения ввели бы четвёртый диалект в интерфейсе.
 */
export function sourceKindLabel(kind: SourceKind): string {
  switch (kind) {
    case 'upd':
      return 'УПД';
    case 'transport_waybill':
    case 'os2_transfer':
      return 'Накладная';
    case 'request':
      return 'Заявка';
  }
}
