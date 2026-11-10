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
  const inn = digits(ctx.supplierInn);
  if (!inn || !ctx.inns.has(inn)) return false;
  return (
    TORG12_PROMPT_PARSE_MODES.has(ctx.parseMode) &&
    !ctx.secondPassJob &&
    !ctx.segmentRepairJob &&
    ctx.jobGeneration === 0
  );
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
