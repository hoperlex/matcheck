// Предподсчёт денежных сумм по позициям приёмки/отгрузки на сервере.
//
// ВАЖНО: формулы дословно повторяют клиентские deliveryItemsTotal /
// deliveryItemsVatSum (apps/web DeliveriesHistory.tsx) и их зеркала в
// ShipmentsHistory.tsx. Числа обязаны совпадать бит-в-бит: считаем из тех же
// строковых полей (price/qtyActual/qtyPlanned/vatSum), в том же порядке
// позиций (по lineNo), через Number(). Правки формулы — синхронно с клиентом.

type SumItem = {
  price: string | null;
  qtyActual: string | null;
  qtyPlanned: string | null;
  vatSum: string | null;
};

// Σ qty × price по позициям, где price задан. qty берём из qtyActual, иначе
// qtyPlanned. Если ни у одной позиции нет цены — null (UI показывает «—»,
// а не 0).
export function computeItemsTotal(items: SumItem[]): number | null {
  if (!items.length) return null;
  let sum = 0;
  let hasAny = false;
  for (const it of items) {
    const price = it.price !== null && it.price !== '' ? Number(it.price) : null;
    if (price === null || !Number.isFinite(price)) continue;
    const qtyRaw = it.qtyActual ?? it.qtyPlanned;
    const qty = qtyRaw !== null && qtyRaw !== '' ? Number(qtyRaw) : null;
    if (qty === null || !Number.isFinite(qty)) continue;
    sum += qty * price;
    hasAny = true;
  }
  return hasAny ? sum : null;
}

// Σ vatSum по позициям, где сумма НДС задана. null — если ни у одной нет.
export function computeItemsVatSum(items: SumItem[]): number | null {
  if (!items.length) return null;
  let sum = 0;
  let hasAny = false;
  for (const it of items) {
    if (it.vatSum === null || it.vatSum === '') continue;
    const v = Number(it.vatSum);
    if (!Number.isFinite(v)) continue;
    sum += v;
    hasAny = true;
  }
  return hasAny ? sum : null;
}
