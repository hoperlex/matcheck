import type { UpdPdfParsed } from '@matcheck/contracts';
import type { ParseMode } from './parse-mode.js';

/**
 * Промпт с разделом ТОРГ-12 — только для накладных поставщиков из списка
 * (TORG12_PROMPT).
 *
 * Зачем узко. Активный промпт УПД общий для всего потока, и замена его версией
 * с разделом ТОРГ-12 задела бы каждый документ: проверить это можно только
 * выборкой, а выборка — не весь поток. Поэтому активный промпт не меняется, а
 * переразбирается лишь документ, в результате которого ИНН поставщика из
 * списка (сегодня это РОКВУЛ, 5012093506: его модель читает надёжно на всех
 * накладных). Для любого другого документа правило возвращает false на первом
 * же условии — второго вызова модели нет.
 */

export type Torg12PromptMode = 'off' | 'shadow' | 'on';

/**
 * Режимы разбора, в которых работает правило: картинка, PDF-скан и склеенные
 * листы пакета. Это ровно пути накладных РОКВУЛ на бою. Текстовый PDF, Excel,
 * форма М-15 и второй проход сюда не входят.
 */
const TORG12_PROMPT_PARSE_MODES: ReadonlySet<ParseMode> = new Set<ParseMode>([
  'image_vision',
  'vision_pdf',
  'segment_vision',
]);

/** Только цифры: ИНН в ответе модели бывает с пробелами и дефисами. */
function digits(v: string | null | undefined): string {
  return (v ?? '').replace(/\D/g, '');
}

/** Список ИНН из env: через запятую, пробелы и пустые элементы отбрасываются. */
export function parseSupplierInns(raw: string | null | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((v) => digits(v))
      .filter((v) => v.length > 0),
  );
}

/** Есть ли ИНН (только цифры) в списке. Пустой ИНН — нет. */
export function innInList(inn: string | null | undefined, inns: ReadonlySet<string>): boolean {
  const v = digits(inn);
  return v !== '' && inns.has(v);
}

export type Torg12PromptContext = {
  mode: Torg12PromptMode;
  parseMode: ParseMode;
  /** Второй проход картинкой. */
  secondPassJob: boolean;
  /** Автоповтор сегмента: он сравнивает кандидата со снимком из БД. */
  segmentRepairJob: boolean;
  /**
   * Поколение задания; ручной повтор поднимает его выше нуля. Там правило
   * количества ТОРГ-12 не применяется, и разбор v18 оставил бы количество
   * пустым — то есть нулём в приёмке. Поэтому только первичный разбор.
   */
  jobGeneration: number;
  /** ИНН поставщика из результата обычного разбора. */
  supplierInn: string | null | undefined;
  inns: ReadonlySet<string>;
};

/** Переразбирать ли документ промптом ТОРГ-12. */
export function torg12PromptApplies(ctx: Torg12PromptContext): boolean {
  if (ctx.mode === 'off') return false;
  if (ctx.inns.size === 0) return false;
  if (!innInList(ctx.supplierInn, ctx.inns)) return false;
  return (
    TORG12_PROMPT_PARSE_MODES.has(ctx.parseMode) &&
    !ctx.secondPassJob &&
    !ctx.segmentRepairJob &&
    ctx.jobGeneration === 0
  );
}

/** Что именно обнулило clearTorg12Money — для следа. */
export type Torg12MoneyCleared = Array<{
  /** Номер строки 1-based (порядок items) или null для полей документа. */
  row: number | null;
  field: 'price' | 'sum' | 'vatRate' | 'vatSum' | 'totalSum';
  value: number;
}>;

const ITEM_MONEY_FIELDS = ['price', 'sum', 'vatRate', 'vatSum'] as const;

/**
 * Деньги из ТОРГ-12 поставщика, который цен в ней не печатает
 * (TORG12_PROMPT_NO_PRICE_INNS).
 *
 * Зачем. У накладной РОКВУЛ денежные графы 11–15 пусты структурно — цену
 * ставит дилер в своём УПД. Модель же на части снимков сдвигает массы на одну
 * графу вправо: массу брутто отдаёт как нетто, а массу нетто — как сумму
 * (иногда ×1000: «2 592,000» кг → 2 592 000 ₽). По равенству «сумма = масса»
 * это не ловится — масса нетто тоже взята не та. Количество сдвиг не задевает:
 * его считает TORG12_QTY из граф 7 и 8.
 *
 * Обнуляет денежные поля строк и документа и ставит pricing = 'absent'.
 * Остальное (номер, стороны, наименования, графы 7/8) не трогает.
 */
export function clearTorg12Money(parsed: UpdPdfParsed): {
  parsed: UpdPdfParsed;
  cleared: Torg12MoneyCleared;
} {
  const cleared: Torg12MoneyCleared = [];
  const items = parsed.items.map((item, index) => {
    const next = { ...item };
    for (const field of ITEM_MONEY_FIELDS) {
      const value = item[field];
      if (value != null) {
        cleared.push({ row: index + 1, field, value });
        next[field] = null;
      }
    }
    return next;
  });
  if (parsed.totalSum != null) {
    cleared.push({ row: null, field: 'totalSum', value: parsed.totalSum });
  }
  if (parsed.vatSum != null) {
    cleared.push({ row: null, field: 'vatSum', value: parsed.vatSum });
  }
  return {
    parsed: { ...parsed, items, totalSum: null, vatSum: null, pricing: 'absent' },
    cleared,
  };
}

/** Сводка разбора для следа: чтобы сравнить две версии, не храня ответы целиком. */
export type Torg12PromptSummary = {
  docNumber: string | null;
  docDate: string | null;
  items: number;
  /** Первые строки: наименование, единица, количество и графы 7/8. */
  rows: Array<{
    rowNo: number | null;
    nameRaw: string | null;
    unit: string | null;
    qty: number | null;
    qtyPerPlace: number | null;
    places: number | null;
  }>;
  totalSum: number | null;
  confidence: number | null;
};

export function summarizeForTrace(parsed: UpdPdfParsed): Torg12PromptSummary {
  return {
    docNumber: parsed.docNumber ?? null,
    docDate: parsed.docDate ? String(parsed.docDate) : null,
    items: parsed.items.length,
    rows: parsed.items.slice(0, 5).map((it) => ({
      rowNo: it.rowNo ?? null,
      nameRaw: it.nameRaw ?? null,
      unit: it.unit ?? null,
      qty: it.qty ?? null,
      qtyPerPlace: it.qtyPerPlace ?? null,
      places: it.places ?? null,
    })),
    totalSum: parsed.totalSum ?? null,
    confidence: parsed.confidence ?? null,
  };
}
