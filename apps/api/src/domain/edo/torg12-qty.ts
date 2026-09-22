import type { UpdPdfParsed } from '@matcheck/contracts';

/**
 * Количество позиции товарной накладной ТОРГ-12 — из граф бланка, а не из
 * графы «Количество (масса нетто)».
 *
 * Зачем. В ТОРГ-12 количество товара печатают не всегда: у накладной без цен
 * (отгрузочный экземпляр) в строке стоят «Количество в одном месте» (графа 7)
 * и «Количество мест, штук» (графа 8), а графа 10 названа «Количество (масса
 * нетто)» и содержит массу в килограммах. Модель честно читает графу 10 и
 * отдаёт её как qty — в приёмку едут «2886 м²» вместо 780 (боевая накладная
 * 1002004449 от 21.09.2026: 13 мест по 60 м², масса нетто 2886 кг).
 *
 * Почему умножение здесь, а не в промпте. Просить модель перемножить графы —
 * та же арифметика в промпте, которая уже проверена и ухудшает чтение колонок
 * (версии v15/v16 читали хуже v13). Модель называет напечатанное, счёт —
 * детерминированный код.
 *
 * Чего правило НЕ делает. Оно не «улучшает» количество там, где оно
 * напечатано: если qty прочитано и не совпадает с массой нетто, строка не
 * трогается вовсе — расхождение между qty и произведением граф может
 * означать и ошибку в графах, и законную частичную отгрузку.
 */

export type Torg12QtyMode = 'off' | 'shadow' | 'on';

/** Версия правила: пишется в след, чтобы старые записи читались однозначно. */
export const TORG12_QTY_RULE_VERSION = 1;

/**
 * Почему количество признано неверным.
 *
 * `qty_missing` — модель не нашла количества вовсе (в бланке его и нет);
 * `mass_as_qty` — в qty приехала масса нетто из графы 10, при том что единица
 * измерения строки не весовая.
 */
export type Torg12QtyClass = 'qty_missing' | 'mass_as_qty';

export type Torg12QtyCandidate = {
  /** Номер строки, 1-based — как в validation.scope.row. */
  row: number;
  kind: Torg12QtyClass;
  qtyFrom: number | null;
  qtyTo: number;
  qtyPerPlace: number;
  places: number;
  massNetKg: number | null;
  unit: string | null;
  /**
   * Почему кандидат остался наблюдением, хотя режим `on`.
   *
   * `operation_trace` — документ успел уехать в приёмку между решением и
   * записью: менять количество в уже принятой поставке машине нельзя.
   */
  blockedBy?: 'operation_trace';
};

/** Весовые единицы: для них графа 10 и есть количество, править нечего. */
const MASS_UNITS = new Set(['кг', 'кг.', 'килограмм', 'т', 'т.', 'тонна', 'kg']);

function isMassUnit(unit: string | null | undefined): boolean {
  if (!unit) return false;
  return MASS_UNITS.has(unit.trim().toLocaleLowerCase('ru').replace(/\s+/g, ''));
}

function round3(n: number): number {
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

/** Масса и количество совпали с точностью до копеечного шума OCR. */
function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(0.01, Math.abs(b) * 1e-6);
}

/**
 * Кандидаты на пересчёт количества. Ничего не меняет.
 *
 * Условия намеренно узкие: обе графы прочитаны, произведение положительное и
 * отличается от того, что стоит в qty. Ни строка-услуга (нет граф), ни
 * обычная УПД (полей вовсе нет) сюда не попадают.
 */
export function detectTorg12Qty(parsed: UpdPdfParsed): Torg12QtyCandidate[] {
  const items = parsed.items ?? [];
  const out: Torg12QtyCandidate[] = [];

  items.forEach((item, index) => {
    const perPlace = item.qtyPerPlace;
    const places = item.places;
    if (perPlace == null || places == null) return;
    if (!Number.isFinite(perPlace) || !Number.isFinite(places)) return;
    if (perPlace <= 0 || places <= 0) return;

    const qtyTo = round3(perPlace * places);
    if (!Number.isFinite(qtyTo) || qtyTo <= 0) return;

    const qty = item.qty ?? null;
    const massNetKg = item.massNetKg ?? null;
    const unit = item.unit ?? null;

    let kind: Torg12QtyClass | null = null;
    if (qty == null) {
      kind = 'qty_missing';
    } else if (
      massNetKg != null &&
      !isMassUnit(unit) &&
      nearlyEqual(qty, massNetKg) &&
      !nearlyEqual(qty, qtyTo)
    ) {
      // Количество совпало с массой нетто, а единица измерения не весовая —
      // это и есть чтение графы 10 вместо количества.
      kind = 'mass_as_qty';
    }
    if (kind == null) return;
    // Пересчёт, совпавший с тем, что уже стоит, — не правка.
    if (qty != null && nearlyEqual(qty, qtyTo)) return;

    out.push({
      // Номер строки берём из графы 1, когда она прочитана: по нему строка
      // находится в бланке. Порядковый индекс — запасной вариант.
      row: item.rowNo ?? index + 1,
      kind,
      qtyFrom: qty,
      qtyTo,
      qtyPerPlace: perPlace,
      places,
      massNetKg,
      unit,
    });
  });

  return out;
}

/**
 * Применяет пересчёт к позициям. Возвращает НОВЫЙ объект разбора: исходный не
 * мутируется, чтобы след мог сослаться на прежние значения.
 */
export function applyTorg12Qty(
  parsed: UpdPdfParsed,
  candidates: ReadonlyArray<Torg12QtyCandidate>,
): { parsed: UpdPdfParsed; applied: Torg12QtyCandidate[] } {
  if (candidates.length === 0) return { parsed, applied: [] };
  const items = parsed.items ?? [];
  const byRow = new Map<number, Torg12QtyCandidate>();
  for (const c of candidates) byRow.set(c.row, c);

  const applied: Torg12QtyCandidate[] = [];
  const nextItems = items.map((item, index) => {
    const row = item.rowNo ?? index + 1;
    const candidate = byRow.get(row);
    if (!candidate) return item;
    applied.push(candidate);
    return { ...item, qty: candidate.qtyTo };
  });

  return { parsed: { ...parsed, items: nextItems }, applied };
}

export type Torg12QtyEntry = Torg12QtyCandidate & {
  state: 'observed' | 'applied';
  itemId?: string;
};

export type Torg12QtyTrace = {
  ruleVersion: number;
  mode: Torg12QtyMode;
  detectedAt: string;
  /** `dispatch_generation` документа. */
  generation: number | null;
  /** `version` документа на момент правки. */
  docVersion: number | string | null;
  entries: Torg12QtyEntry[];
};

/**
 * Собирает след: применённые кандидаты помечаются `applied`, остальные —
 * `observed`. В режиме shadow применённых не бывает вовсе, и это главный
 * материал для разбора перед включением.
 */
export function buildTorg12QtyTrace(args: {
  mode: Torg12QtyMode;
  candidates: ReadonlyArray<Torg12QtyCandidate>;
  appliedRows: ReadonlySet<number>;
  generation: number | null;
  docVersion: number | string | null;
  itemIdByRow?: ReadonlyMap<number, string>;
}): Torg12QtyTrace | null {
  if (args.candidates.length === 0) return null;
  return {
    ruleVersion: TORG12_QTY_RULE_VERSION,
    mode: args.mode,
    detectedAt: new Date().toISOString(),
    generation: args.generation,
    docVersion: args.docVersion,
    entries: args.candidates.map((c) => ({
      ...c,
      state: args.appliedRows.has(c.row) ? ('applied' as const) : ('observed' as const),
      ...(args.itemIdByRow?.has(c.row) ? { itemId: args.itemIdByRow.get(c.row)! } : {}),
    })),
  };
}
