import type { UpdPdfParsed } from '@matcheck/contracts';
import { validateUpdTotals } from './upd-validation.js';

export type QtyScaleMode = 'off' | 'shadow' | 'on';

export const QTY_SCALE_RULE_VERSION = 1;

export type QtyScaleBlockedBy =
  | 'integer_price'
  | 'price_multiple_10'
  | 'thousand_unit'
  | 'document_total_unconfirmed'
  | 'operation_trace';

export type QtyScaleCandidate = {
  /** Индекс строки в parsed.items, 1-based. */
  row: number;
  kind: 'lost_decimal_1000';
  qtyFrom: number;
  qtyTo: number;
  price: number;
  sum: number;
  base: number;
  unit: string | null;
  applicable: boolean;
  blockedBy?: QtyScaleBlockedBy;
};

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function hasAtMostTwoDecimals(n: number): boolean {
  return Math.abs(round2(n) - n) < 1e-9;
}

function isMultipleOfTen(n: number): boolean {
  return Math.abs(n / 10 - Math.round(n / 10)) < 1e-9;
}

function isThousandUnit(unit: string | null | undefined): boolean {
  if (!unit) return false;
  const normalized = unit.toLowerCase().replace(/[.\s]/g, '');
  return normalized === 'тыс' || normalized.startsWith('тысшт');
}

type Validation = ReturnType<typeof validateUpdTotals>;

function rowCheck(validation: Validation, name: string, row: number) {
  return validation.checks.find(
    (check) => check.name === name && check.scope !== 'document' && check.scope.row === row,
  );
}

function documentCheck(validation: Validation, name: string) {
  return validation.checks.find((check) => check.name === name && check.scope === 'document');
}

/**
 * Находит только потерю десятичной запятой ровно в 1000 раз.
 *
 * Ядро правила доказывает подстановку арифметикой строки; дополнительные
 * gates исключают альтернативу «ошиблась цена/сумма». Кандидаты, прошедшие
 * арифметику, но не gates, остаются в shadow-следе с blockedBy и не меняются
 * даже в режиме on.
 */
export function detectQtyScale(parsed: UpdPdfParsed): QtyScaleCandidate[] {
  if (!parsed.items?.length) return [];

  const validation = validateUpdTotals({
    totalSum: parsed.totalSum ?? null,
    vatSum: parsed.vatSum ?? null,
    itemsCount: parsed.itemsCount ?? null,
    items: parsed.items.map((item) => ({
      rowNo: item.rowNo ?? null,
      qty: item.qty ?? null,
      unit: item.unit ?? null,
      price: item.price ?? null,
      sum: item.sum ?? null,
      vatRate: item.vatRate ?? null,
      vatSum: item.vatSum ?? null,
    })),
  });
  const sumTotal = documentCheck(validation, 'sum_total');
  const totalSum = parsed.totalSum ?? null;

  const candidates: QtyScaleCandidate[] = [];
  parsed.items.forEach((item, index) => {
    const row = index + 1;
    const qtyFrom = item.qty ?? null;
    const price = item.price ?? null;
    const sum = item.sum ?? null;
    if (qtyFrom == null || price == null || sum == null) return;
    if (![qtyFrom, price, sum].every(Number.isFinite)) return;
    if (qtyFrom < 1000 || !Number.isInteger(qtyFrom) || price <= 0 || sum <= 0) return;
    if (!hasAtMostTwoDecimals(price) || !hasAtMostTwoDecimals(sum)) return;

    // Сходящуюся строку не трогаем по построению: настоящее количество 1000
    // или 1 000 000 остаётся как есть.
    const qtyPrice = rowCheck(validation, 'row_qty_price', row);
    if (!qtyPrice || qtyPrice.ok || qtyPrice.skipReason != null) return;
    const base = qtyPrice.expected;
    if (base == null || !Number.isFinite(base) || base <= 0) return;

    const qtyTo = qtyFrom / 1000;
    const arithmeticTolerance = 0.005 * qtyTo + 0.02;
    if (Math.abs(qtyTo * price - base) > arithmeticTolerance) return;

    // Если модель действительно прочитала и ставку, и сумму НДС, они обязаны
    // сходиться в СЫРОМ ответе. Вызывающий запускает детектор до нормализации
    // НДС, поэтому правило не подтверждает само себя.
    if (item.vatRate != null && item.vatSum != null) {
      const vat = rowCheck(validation, 'row_vat_rate', row);
      if (!vat || !vat.ok || vat.skipReason != null) return;
    }

    let blockedBy: QtyScaleBlockedBy | undefined;
    if (isMultipleOfTen(price)) blockedBy = 'price_multiple_10';
    else if (Number.isInteger(price)) blockedBy = 'integer_price';
    else if (isThousandUnit(item.unit)) blockedBy = 'thousand_unit';
    else {
      const totalConfirmed = Boolean(sumTotal?.ok && sumTotal.skipReason == null);
      // Даже если сумма строк в документе распознана не полностью, текущее
      // qty×price, превышающее прочитанный итог всего документа, исключает
      // гипотезу, что количество 74000 было настоящим.
      const impossibleCurrentBase =
        totalSum != null && Number.isFinite(totalSum) && round2(qtyFrom * price) > totalSum + 1;
      if (!totalConfirmed && !impossibleCurrentBase) blockedBy = 'document_total_unconfirmed';
    }

    candidates.push({
      row,
      kind: 'lost_decimal_1000',
      qtyFrom,
      qtyTo,
      price,
      sum,
      base,
      unit: item.unit ?? null,
      applicable: blockedBy === undefined,
      ...(blockedBy ? { blockedBy } : {}),
    });
  });

  return candidates;
}

export function applyQtyScale(
  parsed: UpdPdfParsed,
  candidates: readonly QtyScaleCandidate[],
): { parsed: UpdPdfParsed; applied: QtyScaleCandidate[] } {
  const applied = candidates.filter((candidate) => candidate.applicable);
  if (applied.length === 0) return { parsed, applied: [] };
  const byRow = new Map(applied.map((candidate) => [candidate.row, candidate]));
  return {
    parsed: {
      ...parsed,
      items: parsed.items.map((item, index) => {
        const candidate = byRow.get(index + 1);
        return candidate ? { ...item, qty: candidate.qtyTo } : item;
      }),
    },
    applied,
  };
}

export type QtyScaleState = 'observed' | 'applied' | 'reverted';

export type QtyScaleEntry = Omit<QtyScaleCandidate, 'applicable'> & {
  state: QtyScaleState;
  itemId?: string | null;
  revertedAt?: string;
};

export type QtyScaleTrace = {
  ruleVersion: number;
  mode: QtyScaleMode;
  detectedAt: string;
  generation: number | null;
  docVersion: number | string | null;
  entries: QtyScaleEntry[];
};

export function buildQtyScaleTrace(args: {
  mode: QtyScaleMode;
  candidates: readonly QtyScaleCandidate[];
  appliedRows: ReadonlySet<number>;
  generation: number | null;
  docVersion: number | string | null;
}): QtyScaleTrace | null {
  if (args.candidates.length === 0) return null;
  return {
    ruleVersion: QTY_SCALE_RULE_VERSION,
    mode: args.mode,
    detectedAt: new Date().toISOString(),
    generation: args.generation,
    docVersion: args.docVersion,
    entries: args.candidates.map(({ applicable: _applicable, ...candidate }) => ({
      ...candidate,
      state: args.appliedRows.has(candidate.row) ? 'applied' : 'observed',
    })),
  };
}
