/**
 * Фильтр по типу документа: что видит пользователь и что уходит на сервер.
 *
 * «Накладная» на экране — это две формы сразу: ТН (transport_waybill) и ОС-2
 * (os2_transfer); в списке они и подписаны одинаково. В адрес и в запрос
 * кладём серверные типы через запятую (`kind=upd,transport_waybill,…`) —
 * так старые ссылки вида `kind=upd` продолжают работать.
 */
import { SourceKindSchema } from '@matcheck/contracts';
import type { FilterOption } from '../ui/ColumnFilterWindow';

type ServerKind = (typeof SourceKindSchema.options)[number];

const UI_TO_SERVER: Record<string, readonly ServerKind[]> = {
  upd: ['upd'],
  waybill: ['transport_waybill', 'os2_transfer'],
  request: ['request'],
};

/** Варианты окна фильтра «Тип» — в порядке, в котором их привыкли видеть. */
export const KIND_FILTER_OPTIONS: readonly FilterOption[] = [
  { value: 'upd', label: 'УПД' },
  { value: 'waybill', label: 'Накладная' },
  { value: 'request', label: 'Заявка' },
];

/** Значение `kind` из адреса → проверенный список серверных типов. */
export function parseKindParam(param: string | null): ServerKind[] {
  if (!param) return [];
  const known = new Set<string>(SourceKindSchema.options);
  const kinds = param
    .split(',')
    .map((k) => k.trim())
    .filter((k): k is ServerKind => known.has(k));
  return [...new Set(kinds)];
}

/** Серверные типы → выбранные варианты окна (ТН или ОС-2 → «Накладная»). */
export function kindsToFilterValues(kinds: readonly string[]): string[] {
  return Object.entries(UI_TO_SERVER)
    .filter(([, server]) => server.some((k) => kinds.includes(k)))
    .map(([ui]) => ui);
}

/** Выбранные варианты окна → значение `kind` для адреса; null — фильтр снят. */
export function filterValuesToKindParam(values: readonly string[]): string | null {
  const kinds = values.flatMap((v) => UI_TO_SERVER[v] ?? []);
  return kinds.length > 0 ? kinds.join(',') : null;
}
