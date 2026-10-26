/**
 * Деньги позиции приёмки — общие для формы (KppPage) и сводки блока с УПД из
 * ЭДО: сводка обязана считать НДС тем же правилом, что уйдёт в сохранение
 * (`buildPatch`), иначе число в заголовке разойдётся с сохранённым.
 */

export function toNum(v: string | null): number | null {
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function computeVatSum(it: {
  qtyActual: string | null;
  qtyPlanned: string | null;
  price: string | null;
  vatRate: string | null;
}): number | null {
  const qty = toNum(it.qtyActual) ?? toNum(it.qtyPlanned);
  const price = toNum(it.price);
  const rate = toNum(it.vatRate);
  if (qty === null || price === null || rate === null) return null;
  return (qty * price * rate) / 100;
}
