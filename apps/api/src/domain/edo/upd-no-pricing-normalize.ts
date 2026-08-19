import type { UpdPdfParsed } from '@matcheck/contracts';

/**
 * Доопределяет нулевую стоимость только по явному ответу новой версии промпта.
 * Флаг выключен по умолчанию, а старые ответы без pricing проходят побайтово
 * прежним путём. `absent` тоже недостаточно само по себе: в структуре не должно
 * быть ни одной цены/суммы, иначе это противоречивый ответ модели.
 */
export function normalizeUpdNoPricingTotals(parsed: UpdPdfParsed, enabled: boolean): UpdPdfParsed {
  if (!enabled || parsed.pricing !== 'absent') return parsed;
  if (parsed.totalSum != null || parsed.vatSum != null) return parsed;
  if (parsed.items.length === 0) return parsed;
  const noValuation = parsed.items.every(
    (item) => item.price == null && item.sum == null && item.vatSum == null,
  );
  if (!noValuation) return parsed;
  return { ...parsed, totalSum: 0, vatSum: 0 };
}
