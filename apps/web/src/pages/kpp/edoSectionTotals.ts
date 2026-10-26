import { formatMoneyRu } from '../../shared/utils/formatRu';
import { computeVatSum, toNum } from './itemMoney';
import type { EdoItemsResponse } from './useDeliveryEdoItems';

/**
 * Сводки блока с УПД из ЭДО: «ЭДО: …» и «Факт: …».
 *
 * Без вердикта «совпало/расходится»: цена со скана округлена до копеек, и на
 * больших количествах разница в рублях — не улика. Две суммы стоят рядом, а
 * неизвестное видно явно — не считается нулём и не прячется в итоге.
 */

/** Сумма по известным слагаемым и число неизвестных. value null — известных нет. */
export type PartialSum = { value: number | null; missing: number };

function add(total: PartialSum, part: number | null): PartialSum {
  if (part === null) return { ...total, missing: total.missing + 1 };
  return { value: (total.value ?? 0) + part, missing: total.missing };
}

const EMPTY: PartialSum = { value: null, missing: 0 };

export type FactRow = {
  qtyActual: string | null;
  qtyPlanned: string | null;
  price: string | null;
  vatRate: string | null;
  vatSum: string | null;
};

/**
 * Факт приёмки. Правило то же, что у сохранения (`buildPatch` в KppPage): без
 * НДС — Σ qty × price, НДС — пересчитанный, а если пересчитать нечем — тот,
 * что лежит в строке.
 */
export function factTotals(rows: readonly FactRow[]): {
  count: number;
  exVat: PartialSum;
  vat: PartialSum;
} {
  let exVat = EMPTY;
  let vat = EMPTY;
  for (const row of rows) {
    const qty = toNum(row.qtyActual) ?? toNum(row.qtyPlanned);
    const price = toNum(row.price);
    exVat = add(exVat, qty !== null && price !== null ? qty * price : null);
    vat = add(vat, computeVatSum(row) ?? toNum(row.vatSum));
  }
  return { count: rows.length, exVat, vat };
}

/** УПД из ЭДО блока — по итогам документов, только готовые. */
export function edoTotals(documents: readonly EdoItemsResponse[]): {
  count: number;
  exVat: PartialSum;
  vat: PartialSum;
} {
  let exVat = EMPTY;
  let vat = EMPTY;
  let count = 0;
  for (const document of documents) {
    count += document.items.length;
    exVat = add(exVat, document.totals?.totalExVat ?? null);
    vat = add(vat, document.totals?.vatSum ?? null);
  }
  return { count, exVat, vat };
}

/** «у 1 строки», «у 3 строк», «у 21 строки». */
function rowsGenitive(n: number): string {
  return n % 10 === 1 && n % 100 !== 11 ? 'строки' : 'строк';
}

/**
 * «58 763,11 ₽», «58 763,11 ₽ (у 2 строк нет цены)» или «—».
 * `what` — чего не хватает: «цены», «НДС», «итога без НДС».
 */
export function formatPartialSum(sum: PartialSum, what: string, of: 'rows' | 'documents'): string {
  if (sum.value === null) return '—';
  const money = formatMoneyRu(sum.value);
  if (sum.missing === 0) return money;
  const whom = of === 'rows' ? `${sum.missing} ${rowsGenitive(sum.missing)}` : `${sum.missing} УПД`;
  return `${money} (у ${whom} нет ${what})`;
}
