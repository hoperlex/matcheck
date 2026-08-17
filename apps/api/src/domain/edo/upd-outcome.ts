// Готов ли распознанный УПД к приёмке — одно правило на все входы.
//
// Инспектор работает только с документами в статусе `parsed`: остальные видит
// менеджер на портале. Раньше условие «готов» жило в трёх местах — в воркере
// после разбора, в ручной правке карточки и, неявно, в сравнении результатов
// повторного прохода, — и они разъехались. Отсюда модуль: правило одно,
// вызывают его все.
//
// Что изменилось по существу. Прежнее условие требовало ПОЛНОСТЬЮ распознанный
// документ: номер, дату, сумму, позиции и сошедшиеся до копейки суммы. На
// практике оно держало на портале документы, по которым приёмку провести можно:
// список материалов есть, номер есть, а шапочная сумма не пропечаталась на
// фотографии. Теперь решают две вещи — номер и ПОЛНЫЙ список материалов.
//
// Слово «полный» здесь не фигура речи. Документ, у которого распознали три
// строки из двенадцати, приедет инспектору как полная поставка, и недостача
// вскроется в лучшем случае на приёмке. Поэтому неполнота списка — отказ, а не
// предупреждение, и отличается она от денежных расхождений: те означают
// «цифры спорные», а эта — «материалов не хватает».

import type { UpdValidation } from '@matcheck/contracts';

/** Копейки: и построчно, и в итоге — тем же правилом, что в валидаторе. */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * Стоимость строки С НАЛОГОМ.
 *
 * `sum` (графа 9 формы УПД) — уже с налогом, и это первый источник. Если его
 * нет, считаем из цены: `price` — цена за единицу БЕЗ НДС (графа 4), поэтому
 * простое `qty × price` занизило бы строку ровно на величину налога.
 *
 * `null` означает «строку посчитать нечем»: нет ни суммы, ни пары
 * количество+цена, либо ставка неизвестна и признать её нулевой нельзя.
 */
export function rowTotalWithVat(item: {
  qty?: number | null;
  price?: number | null;
  sum?: number | null;
  vatRate?: number | null;
}): number | null {
  if (item.sum != null && Number.isFinite(item.sum)) return round2(item.sum);

  const { qty, price, vatRate } = item;
  if (qty == null || price == null) return null;
  if (!Number.isFinite(qty) || !Number.isFinite(price)) return null;
  // Ставка обязана быть известна. Молча подставить ноль — значит занизить итог
  // на 20 % и выдать это за прочитанное из документа.
  if (vatRate == null || !Number.isFinite(vatRate)) return null;

  return round2(round2(qty * price) * (1 + vatRate / 100));
}

/**
 * Итог документа, посчитанный по строкам.
 *
 * Возвращает `null`, если хотя бы одна строка невычислима: частичная сумма
 * опаснее пустой — она выглядит достоверной и молча занижает поставку.
 */
export function synthesizeTotalSum(
  items: ReadonlyArray<{
    qty?: number | null;
    price?: number | null;
    sum?: number | null;
    vatRate?: number | null;
  }>,
): number | null {
  if (items.length === 0) return null;
  let acc = 0;
  for (const item of items) {
    const row = rowTotalWithVat(item);
    if (row == null) return null;
    acc += row;
  }
  return round2(acc);
}

/**
 * Считается ли список материалов неполным.
 *
 * Опора — проверка `items_count` валидатора: она сверяет «Всего наименований»
 * из шапки с числом распознанных строк. Когда счётчика в документе нет,
 * проверка помечена `skipReason: 'no_expected'` и остаётся `ok` — сверять
 * нечем, и список считается полным. Иначе почти ни одна фотография и ни один
 * скан не прошли бы: счётчик печатают далеко не всегда.
 */
export function hasIncompleteItemList(validation: UpdValidation): boolean {
  const check = validation.checks.find((c) => c.name === 'items_count');
  return check != null && !check.ok;
}

/**
 * Денежное расхождение: итоги, построчная арифметика, НДС.
 *
 * Отделено от неполноты списка намеренно. Расхождение на копейки — повод
 * показать менеджеру предупреждение, но не повод останавливать приёмку;
 * недостающие строки — повод остановить.
 */
export function hasMoneyMismatch(validation: UpdValidation): boolean {
  return validation.checks.some((c) => !c.ok && c.name !== 'items_count');
}

export type UpdParseOutcome = {
  status: 'parsed' | 'needs_resolution';
  parseErrorCode: 'partial_parse' | 'validation_mismatch' | null;
  parseErrorDetails: Record<string, unknown> | null;
  /**
   * Итог документа: прочитанный из шапки либо посчитанный по строкам.
   * `null` допустим — CHECK `source_upd_required` с миграции 0107 требует при
   * `parsed` только номер.
   */
  totalSum: number | null;
  /** Итог посчитан нами, а не прочитан из документа. */
  totalSumSynthesized: boolean;
};

/**
 * Что делать с распознанным документом.
 *
 * @param parsed результат распознавания (уже нормализованный).
 * @param validation сверка сумм ПО ЭТОМУ ЖЕ результату. Вызывающий обязан
 *   пересчитать её после синтеза итога — иначе в карточке останется
 *   предупреждение, посчитанное по пустой сумме.
 */
export function deriveUpdParseOutcome(
  parsed: {
    // Duck-typed, как и вход валидатора: сюда приходит и свежий результат
    // распознавания, и строки, поднятые из БД при ручной правке. Общее у них —
    // только то, что нужно правилу.
    items: ReadonlyArray<{
      qty?: number | null;
      price?: number | null;
      sum?: number | null;
      vatRate?: number | null;
    }>;
    docNumber?: string | null;
    totalSum?: number | null;
    confidence?: number | null;
    itemsCount?: number | null;
  },
  validation: UpdValidation,
  opts: { confidence?: number; parsedViaVision?: boolean } = {},
): UpdParseOutcome {
  const noItems = parsed.items.length === 0;
  const noNumber = parsed.docNumber == null || parsed.docNumber.trim() === '';
  const incompleteList = hasIncompleteItemList(validation);

  const synthesized = parsed.totalSum == null ? synthesizeTotalSum(parsed.items) : null;
  const totalSum = parsed.totalSum ?? synthesized;

  if (noItems || noNumber || incompleteList) {
    return {
      status: 'needs_resolution',
      parseErrorCode: 'partial_parse',
      parseErrorDetails: {
        missing: [
          noNumber ? 'docNumber' : null,
          noItems ? 'items' : null,
          incompleteList ? 'itemsIncomplete' : null,
        ].filter(Boolean) as string[],
        // Сколько строк ждали и сколько получили — первое, что спросит
        // менеджер, увидев «распознано частично».
        ...(incompleteList
          ? { itemsExpected: parsed.itemsCount ?? null, itemsParsed: parsed.items.length }
          : {}),
        confidence: opts.confidence ?? parsed.confidence ?? null,
        parsedViaVision: opts.parsedViaVision ?? false,
      },
      totalSum,
      totalSumSynthesized: parsed.totalSum == null && synthesized != null,
    };
  }

  const moneyMismatch = hasMoneyMismatch(validation);
  return {
    status: 'parsed',
    parseErrorCode: moneyMismatch ? 'validation_mismatch' : null,
    parseErrorDetails: moneyMismatch
      ? {
          failedChecks: validation.checks
            .filter((c) => !c.ok)
            .map((c) => ({
              name: c.name,
              scope: c.scope,
              expected: c.expected,
              actual: c.actual,
              diff: c.diff,
            })),
          ...(parsed.totalSum == null && synthesized != null
            ? { totalSumSynthesized: true }
            : {}),
        }
      : parsed.totalSum == null && synthesized != null
        ? { totalSumSynthesized: true }
        : null,
    totalSum,
    totalSumSynthesized: parsed.totalSum == null && synthesized != null,
  };
}
