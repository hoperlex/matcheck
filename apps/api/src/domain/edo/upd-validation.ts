import type { UpdCheck, UpdValidation } from '@matcheck/contracts';

// Duck-typed вход: подходит и для UpdPdfParsed (LLM/локальный PDF-парсер),
// и для UpdParsed (XML). Поля с одинаковыми именами — qty, price, sum,
// vatRate, vatSum, totalSum, vatSum (на документе) — везде хранятся как
// number | null. itemsCount пока есть только в UpdPdfParsed.
export type UpdLikeForValidation = {
  totalSum?: number | null;
  vatSum?: number | null;
  itemsCount?: number | null;
  items: ReadonlyArray<{
    qty?: number | null;
    price?: number | null;
    sum?: number | null;
    vatRate?: number | null;
    vatSum?: number | null;
  }>;
};

const ROW_TOLERANCE = 0.01;

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function sumNullable(values: ReadonlyArray<number | null | undefined>): number {
  let acc = 0;
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) acc += v;
  }
  return round2(acc);
}

export function validateUpdTotals(parsed: UpdLikeForValidation): UpdValidation {
  const checks: UpdCheck[] = [];
  const items = parsed.items;
  const rowCount = items.length;
  const totalsTolerance = Math.max(ROW_TOLERANCE, rowCount * ROW_TOLERANCE);

  // 1) Σ items.sum vs totalSum.
  {
    const expected = parsed.totalSum ?? null;
    if (expected == null) {
      checks.push({
        name: 'sum_total',
        scope: 'document',
        expected: null,
        actual: null,
        diff: null,
        tolerance: totalsTolerance,
        ok: true,
        skipReason: 'no_expected',
      });
    } else {
      const actual = sumNullable(items.map((i) => i.sum ?? null));
      const diff = round2(Math.abs(expected - actual));
      checks.push({
        name: 'sum_total',
        scope: 'document',
        expected: round2(expected),
        actual,
        diff,
        tolerance: totalsTolerance,
        ok: diff <= totalsTolerance,
      });
    }
  }

  // 2) Σ items.vatSum vs vatSum (документа).
  {
    const expected = parsed.vatSum ?? null;
    if (expected == null) {
      checks.push({
        name: 'vat_total',
        scope: 'document',
        expected: null,
        actual: null,
        diff: null,
        tolerance: totalsTolerance,
        ok: true,
        skipReason: 'no_expected',
      });
    } else {
      const actual = sumNullable(items.map((i) => i.vatSum ?? null));
      const diff = round2(Math.abs(expected - actual));
      checks.push({
        name: 'vat_total',
        scope: 'document',
        expected: round2(expected),
        actual,
        diff,
        tolerance: totalsTolerance,
        ok: diff <= totalsTolerance,
      });
    }
  }

  // 3) Кол-во позиций («Всего наименований» в шапке) vs items.length.
  {
    const expected = parsed.itemsCount ?? null;
    if (expected == null) {
      checks.push({
        name: 'items_count',
        scope: 'document',
        expected: null,
        actual: rowCount,
        diff: null,
        tolerance: 0,
        ok: true,
        skipReason: 'no_expected',
      });
    } else {
      const diff = Math.abs(expected - rowCount);
      checks.push({
        name: 'items_count',
        scope: 'document',
        expected,
        actual: rowCount,
        diff,
        tolerance: 0,
        ok: diff === 0,
      });
    }
  }

  // 4) Построчно: qty × price ≈ sum.
  items.forEach((it, idx) => {
    const row = idx + 1;
    const qty = it.qty ?? null;
    const price = it.price ?? null;
    const sum = it.sum ?? null;
    if (qty == null || price == null || sum == null) {
      checks.push({
        name: 'row_qty_price',
        scope: { row },
        expected: sum,
        actual: qty != null && price != null ? round2(qty * price) : null,
        diff: null,
        tolerance: ROW_TOLERANCE,
        ok: true,
        skipReason: sum == null ? 'no_expected' : 'no_actual',
      });
      return;
    }
    const actual = round2(qty * price);
    const diff = round2(Math.abs(sum - actual));
    checks.push({
      name: 'row_qty_price',
      scope: { row },
      expected: round2(sum),
      actual,
      diff,
      tolerance: ROW_TOLERANCE,
      ok: diff <= ROW_TOLERANCE,
    });
  });

  // 5) Построчно: sum × vatRate / 100 ≈ vatSum.
  items.forEach((it, idx) => {
    const row = idx + 1;
    const sum = it.sum ?? null;
    const vatRate = it.vatRate ?? null;
    const vatSum = it.vatSum ?? null;
    if (sum == null || vatRate == null || vatSum == null) {
      checks.push({
        name: 'row_vat_rate',
        scope: { row },
        expected: vatSum,
        actual: sum != null && vatRate != null ? round2((sum * vatRate) / 100) : null,
        diff: null,
        tolerance: ROW_TOLERANCE,
        ok: true,
        skipReason: vatSum == null ? 'no_expected' : 'no_actual',
      });
      return;
    }
    const actual = round2((sum * vatRate) / 100);
    const diff = round2(Math.abs(vatSum - actual));
    checks.push({
      name: 'row_vat_rate',
      scope: { row },
      expected: round2(vatSum),
      actual,
      diff,
      tolerance: ROW_TOLERANCE,
      ok: diff <= ROW_TOLERANCE,
    });
  });

  const hasMismatch = checks.some((c) => !c.ok);
  return {
    hasMismatch,
    checkedAt: new Date().toISOString(),
    checks,
  };
}
