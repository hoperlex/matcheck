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

/**
 * Эффективная налоговая ставка документа из шапочных totalSum/vatSum:
 *   rate = vatSum / (totalSum − vatSum) × 100
 *
 * Используется как fallback в `row_qty_price`, когда LLM не извлекла
 * vatRate по конкретной строке (графа 7 формы УПД часто визуально
 * совпадает у всех строк, и LLM иногда заполняет её только на одной).
 * Возвращает null, если данных шапки не хватает или они некорректны.
 */
function effectiveDocVatRate(
  totalSum: number | null | undefined,
  vatSum: number | null | undefined,
): number | null {
  if (totalSum == null || vatSum == null) return null;
  if (vatSum <= 0) return 0;
  const base = totalSum - vatSum;
  if (base <= 0) return null;
  return (vatSum / base) * 100;
}

export function validateUpdTotals(parsed: UpdLikeForValidation): UpdValidation {
  const checks: UpdCheck[] = [];
  const items = parsed.items;
  const rowCount = items.length;
  const totalsTolerance = Math.max(ROW_TOLERANCE, rowCount * ROW_TOLERANCE);
  const docVatRate = effectiveDocVatRate(parsed.totalSum, parsed.vatSum);

  // 1) Σ items.sum vs totalSum.
  //
  // База сравнения — С НДС. После промпта v6 (миграция 0060):
  //   - item.sum  = графа 9 формы УПД «Стоимость с налогом — всего» по строке;
  //   - totalSum  = графа 9 итоговой строки «Всего к оплате» (с НДС).
  // То есть и слагаемые, и шапочный итог — на одной налоговой базе,
  // приводить ничего не надо. Раньше items.sum были «без НДС» (графа 5),
  // и валидатор вычитал vatSum из totalSum, чтобы сверять на «без НДС»;
  // после v6 такая компенсация стабильно даёт false-positive на любом УПД
  // с НДС > 0 (см. рапорт пользователя: 1 065 688.20 vs 1 300 139.60 =
  // ровно vatSum). XML-парсер также давно отдаёт items.sum «с НДС», так
  // что новая логика симметрична для обоих источников.
  {
    const totalSum = parsed.totalSum ?? null;
    if (totalSum == null) {
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
      const expected = round2(totalSum);
      const actual = sumNullable(items.map((i) => i.sum ?? null));
      const diff = round2(Math.abs(expected - actual));
      checks.push({
        name: 'sum_total',
        scope: 'document',
        expected,
        actual,
        diff,
        tolerance: totalsTolerance,
        ok: diff <= totalsTolerance,
      });
    }
  }

  // 2) Σ items.vatSum vs vatSum (документа).
  //
  // PDF-флоу больше не извлекает vatSum по позициям (см. UpdPdfItemSchema:
  // поля убраны намеренно, чтобы LLM сосредоточилась на qty/price/sum).
  // В этом случае все items.vatSum пусты, sumNullable даёт 0, и сравнение
  // с шапочным vatSum > 0 всегда давало false-positive. Скипаем check,
  // когда нечего сравнивать. Для XML-флоу items.vatSum по-прежнему
  // заполняется парсером, и check работает как раньше.
  {
    const expected = parsed.vatSum ?? null;
    const hasAnyItemVat = items.some((i) => i.vatSum != null);
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
    } else if (!hasAnyItemVat) {
      checks.push({
        name: 'vat_total',
        scope: 'document',
        expected: round2(expected),
        actual: null,
        diff: null,
        tolerance: totalsTolerance,
        ok: true,
        skipReason: 'no_actual',
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

  // 4) Построчно: qty × price ≈ sum / (1 + vatRate/100).
  //
  // После промпта v7 (миграция 0061) price берётся строго из графы 4
  // формы УПД («Цена за единицу измерения», БЕЗ НДС), а sum — из графы 9
  // (С НДС). Базы разные, поэтому qty × price нельзя сравнивать с sum
  // напрямую — нужно сначала привести sum к базе «без НДС»:
  //   expectedBase = sum × 100 / (100 + vatRate)
  // Если vatRate не извлечён (XML без ставки или строка «Без НДС» с
  // vatRate = null) — считаем, что НДС нет и sum = база без НДС.
  //
  // Tolerance — max(1₽, 0.1% от expectedBase). Причина: поставщики
  // печатают цену округлённой до 2 знаков (например, 65.4918 → 65.49),
  // а сумму строки считают по неокруглённой. Жёсткий tolerance в копейку
  // давал false-positive почти на каждом реальном УПД. Расхождения
  // «реальной» ошибки (перепутаны колонки, qty распознано как код
  // товара) — в десятки раз больше суммы, чувствительность сохраняется.
  items.forEach((it, idx) => {
    const row = idx + 1;
    const qty = it.qty ?? null;
    const price = it.price ?? null;
    const sum = it.sum ?? null;
    const vatRate = it.vatRate ?? null;
    // qty отсутствует (null) ИЛИ равен 0 — строка без количества (услуга:
    // доставка, погрузка; в графе 3 формы УПД прочерк). Сверка qty × price
    // для неё бессмысленна: 0 × price = 0 никогда не сойдётся с ненулевой
    // базой из графы 5/9 → давало ложный «Расхождения в суммах». Товарные
    // строки всегда имеют qty > 0, поэтому реальные ошибки не маскируются;
    // общий итог по документу проверяют sum_total/vat_total.
    if (qty == null || qty === 0 || price == null || sum == null) {
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
    // Если LLM не извлекла vatRate по конкретной строке, берём
    // эффективную ставку всего документа из шапки. Это покрывает
    // типовой случай «УПД с одним НДС на все строки».
    const effectiveRate = vatRate ?? docVatRate;
    const baseFromSum =
      effectiveRate != null && effectiveRate > 0
        ? round2((sum * 100) / (100 + effectiveRate))
        : round2(sum);
    const actual = round2(qty * price);
    const diff = round2(Math.abs(baseFromSum - actual));
    const tolerance = round2(Math.max(1, Math.abs(baseFromSum) * 0.001));
    checks.push({
      name: 'row_qty_price',
      scope: { row },
      expected: baseFromSum,
      actual,
      diff,
      tolerance,
      ok: diff <= tolerance,
    });
  });

  // 5) Построчно: vatSum ≈ sum × vatRate / (100 + vatRate).
  //
  // sum после промпта v6 — С НДС (графа 9), поэтому НДС извлекается как
  // sum × rate / (100 + rate), а не sum × rate / 100 (последнее работает
  // только когда sum — база «без НДС»). Например, sum=1056 с НДС 20% →
  // vatSum = 1056 × 20 / 120 = 176; формула «× rate / 100» давала бы
  // 211.20 и стабильный false-positive.
  items.forEach((it, idx) => {
    const row = idx + 1;
    const sum = it.sum ?? null;
    const vatRate = it.vatRate ?? null;
    const vatSum = it.vatSum ?? null;
    const computeActual = (s: number, r: number): number =>
      round2((s * r) / (100 + r));
    if (sum == null || vatRate == null || vatSum == null) {
      checks.push({
        name: 'row_vat_rate',
        scope: { row },
        expected: vatSum,
        actual: sum != null && vatRate != null ? computeActual(sum, vatRate) : null,
        diff: null,
        tolerance: ROW_TOLERANCE,
        ok: true,
        skipReason: vatSum == null ? 'no_expected' : 'no_actual',
      });
      return;
    }
    const actual = computeActual(sum, vatRate);
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
