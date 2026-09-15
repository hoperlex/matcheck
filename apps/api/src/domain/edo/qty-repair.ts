import { okeiCodeForUnit } from '@matcheck/contracts';
import type { UpdPdfParsed } from '@matcheck/contracts';
import { validateUpdTotals } from './upd-validation.js';

/**
 * Восстановление количества строки из её же арифметики.
 *
 * Зачем. Модель регулярно читает количество не из графы 3: то код ОКЕИ из
 * графы 2 («796 шт»), то номер графы из служебной строки разметки («1б» на
 * скане выглядит как 16 — так испорчен УПД УТ-480, где 57,000 приехали как 16).
 * Цену она при этом нередко вычисляет от уже неверного количества, и строка
 * расходится с собственной стоимостью.
 *
 * Чего это правило НЕ умеет и уметь не может. Арифметика не отличает ошибку в
 * количестве от ошибки в цене. Контрпример: в бланке «32,4 м³ × 100 ₽», база
 * 3 240 ₽, модель вернула цену 324 ₽ — тогда база/цена = 10, ровное целое, и
 * «восстановление» заменило бы ВЕРНЫЕ 32,4 на неверные 10. Никакой допуск от
 * этого не спасает, потому что числа самосогласованы.
 *
 * Отсюда устройство модуля: наблюдение и применение — РАЗНЫЕ вещи.
 *   * `detectQtyRepairs` считает кандидатов всегда и ничего не меняет. Это
 *     материал для анализа, в том числе по случаям, которые править нельзя;
 *   * `applyQtyRepairs` меняет количество только у кандидатов, прошедших
 *     дополнительные условия: целое исходное количество и класс из явного
 *     разрешённого списка.
 *
 * Автоправка здесь — эвристика с остаточным риском, а не восстановление
 * истины: ошибку в цене при количестве, совпавшем с кодом своей единицы, она
 * не отличает в принципе. Поэтому список разрешённых пар пуст до тех пор, пока
 * накопленные в shadow срабатывания не сверены со сканами.
 */

export type QtyRepairMode = 'off' | 'shadow' | 'on';

/** Версия правила: пишется в след, чтобы старые записи читались однозначно. */
export const QTY_REPAIR_RULE_VERSION = 1;

/**
 * Класс кандидата — чем объясняется неверное количество.
 *
 * `unit_code_as_qty` — количество точно равно коду ОКЕИ СВОЕЙ единицы; это
 * единственный класс, для которого улика указывает на количество, а не на
 * цену. `unexplained` — арифметика восстановима, но причина неизвестна: сюда
 * попадает и класс УПД УТ-480 (qty = 16 из разметки заголовка), потому что
 * «16» ничем не отличается от настоящих 16 штук.
 */
export type QtyRepairClass = 'unit_code_as_qty' | 'unexplained';

export type QtyRepairCandidate = {
  /** Номер строки, как в validation.scope.row (1-based). */
  row: number;
  kind: QtyRepairClass;
  qtyFrom: number;
  qtyTo: number;
  price: number;
  sum: number;
  /** Стоимость строки без налога, от которой считалось количество. */
  base: number;
  unit: string | null;
  okeiCode: number | null;
  /** Разрешено ли применять. false — кандидат только для наблюдения. */
  applicable: boolean;
  /** Почему не применён (для следа и отчётов). */
  blockedBy?: 'fractional_qty' | 'class_not_allowed' | 'operation_trace';
};

/**
 * Пары «единица → код ОКЕИ», для которых автоправка разрешена.
 *
 * ПУСТО НАМЕРЕННО. Совпадение количества с кодом — подозрение, а не
 * доказательство: таблица ОКЕИ содержит и мелкие коды, которые сами по себе
 * законные количества (6 м, 55 м², 112 л, 113 м³, 163 г, 166 кг, 168 т).
 * Контрпример: «6 м × 100 ₽», сумма с НДС 22 % = 732 ₽, модель вернула цену
 * 200 ₽ — база 600, 600/200 = 3, количество 6 совпало с кодом «м», все условия
 * выполнены, и верные 6 метров заменились бы тройкой.
 *
 * Пара добавляется сюда ТОЛЬКО после того, как все накопленные в shadow
 * срабатывания по ней сверены со сканами и порчи среди них нет. Пока список
 * пуст, режим `on` не применяет ничего — и это правильное поведение по
 * умолчанию, а не недоделка.
 */
export const ALLOWED_UNIT_CODE_PAIRS: ReadonlyArray<{ unit: string; code: number }> = [];

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Насколько восстановленное количество должно быть близко к целому. */
const INTEGER_EPSILON = 0.002;

/** Ниже этого порога разница со старым количеством — шум округления. */
const MIN_QTY_DELTA = 0.01;

function isAllowedPair(unit: string | null, code: number | null): boolean {
  if (unit == null || code == null) return false;
  if (okeiCodeForUnit(unit) !== code) return false;
  // Сравнение идёт по нормализованной единице, а не по строке: в бланках
  // пишут и «шт», и «шт.», и «ШТ».
  return ALLOWED_UNIT_CODE_PAIRS.some((p) => p.code === code && okeiCodeForUnit(p.unit) === code);
}

type DocCheckState = { ok: boolean; skipped: boolean };

function checkState(
  checks: ReturnType<typeof validateUpdTotals>['checks'],
  name: string,
  row: number | null,
): DocCheckState | null {
  const found = checks.find((c) => {
    if (c.name !== name) return false;
    if (row == null) return c.scope === 'document';
    return c.scope !== 'document' && c.scope.row === row;
  });
  if (!found) return null;
  return { ok: found.ok, skipped: found.skipReason != null };
}

export type DetectQtyRepairsOptions = {
  /**
   * Переписывали ли МЫ построчный НДС (`normalizeLineVatAgainstHeader`).
   *
   * Если да — сходимость `row_vat_rate` подтверждает наш же расчёт, а не
   * чтение с документа, и опираться на неё как на признак достоверной суммы
   * нельзя. Такой документ кандидатов не даёт вовсе.
   */
  lineVatRewritten: boolean;
};

/**
 * Кандидаты на восстановление количества. Ничего не меняет.
 *
 * Условия намеренно опираются на достоверность ИМЕННО суммы строки: только
 * тогда деление на цену вообще имеет смысл.
 */
export function detectQtyRepairs(
  parsed: UpdPdfParsed,
  opts: DetectQtyRepairsOptions,
): QtyRepairCandidate[] {
  // Наш собственный пересчёт НДС делает строку самосогласованной: сверять её
  // после этого — значит проверять себя.
  if (opts.lineVatRewritten) return [];

  const items = parsed.items ?? [];
  if (items.length === 0) return [];
  if (parsed.totalSum == null || !Number.isFinite(parsed.totalSum)) return [];

  const validation = validateUpdTotals({
    totalSum: parsed.totalSum ?? null,
    vatSum: parsed.vatSum ?? null,
    itemsCount: parsed.itemsCount ?? null,
    items: items.map((i) => ({
      rowNo: i.rowNo ?? null,
      qty: i.qty ?? null,
      unit: i.unit ?? null,
      price: i.price ?? null,
      sum: i.sum ?? null,
      vatRate: i.vatRate ?? null,
      vatSum: i.vatSum ?? null,
    })),
  });

  // Итог документа обязан быть прочитан и сойтись со строками. Пропущенная
  // проверка (skipReason) успехом НЕ считается: при отсутствующем итоге
  // валидатор кладёт ok: true, и без этого условия документ без шапки
  // выглядел бы достоверным.
  const sumTotal = checkState(validation.checks, 'sum_total', null);
  if (!sumTotal || !sumTotal.ok || sumTotal.skipped) return [];

  const out: QtyRepairCandidate[] = [];
  items.forEach((item, idx) => {
    const row = idx + 1;
    const qty = item.qty ?? null;
    const price = item.price ?? null;
    const sum = item.sum ?? null;
    if (qty == null || price == null || sum == null) return;
    if (!Number.isFinite(qty) || !Number.isFinite(price) || !Number.isFinite(sum)) return;
    if (price <= 0 || qty <= 0) return;

    // Цена с третьим знаком — след деления: так выглядит цена, вычисленная
    // моделью от неверного количества (15 480,625 = 247 690 / 16). Это НЕ
    // доказательство правильности двузначной цены, только отсев заведомо
    // вычисленной.
    if (round2(price) !== price) return;

    // Налог строки должен быть ПРОЧИТАН и сойтись: он и подтверждает, что
    // сумма строки достоверна. Пропуск проверки успехом не считается.
    if (item.vatSum == null || item.vatRate == null) return;
    const vatRow = checkState(validation.checks, 'row_vat_rate', row);
    if (!vatRow || !vatRow.ok || vatRow.skipped) return;

    const qtyPrice = validation.checks.find(
      (c) => c.name === 'row_qty_price' && c.scope !== 'document' && c.scope.row === row,
    );
    if (!qtyPrice || qtyPrice.ok || qtyPrice.skipReason != null) return;
    const base = qtyPrice.expected;
    if (base == null || !Number.isFinite(base) || base <= 0) return;

    const qtyRec = base / price;
    if (!Number.isFinite(qtyRec)) return;
    const qtyTo = Math.round(qtyRec);
    if (Math.abs(qtyRec - qtyTo) > INTEGER_EPSILON) return;
    if (qtyTo < 1) return;
    if (Math.abs(qtyTo - qty) <= MIN_QTY_DELTA) return;

    // После подстановки строка обязана сойтись — иначе мы меняем одно
    // расхождение на другое.
    if (Math.abs(round2(qtyTo * price) - base) > qtyPrice.tolerance) return;

    const unit = item.unit ?? null;
    const okeiCode = okeiCodeForUnit(unit);
    const kind: QtyRepairClass =
      okeiCode != null && qty === okeiCode ? 'unit_code_as_qty' : 'unexplained';

    // Дробное количество не правим никогда: именно на нём срабатывает
    // контрпример с ошибочной ценой (32,4 м³ → 10).
    const blockedBy: QtyRepairCandidate['blockedBy'] | undefined = !Number.isInteger(qty)
      ? 'fractional_qty'
      : kind !== 'unit_code_as_qty' || !isAllowedPair(unit, okeiCode)
        ? 'class_not_allowed'
        : undefined;

    out.push({
      row,
      kind,
      qtyFrom: qty,
      qtyTo,
      price,
      sum,
      base,
      unit,
      okeiCode,
      applicable: blockedBy === undefined,
      ...(blockedBy ? { blockedBy } : {}),
    });
  });

  return out;
}

/**
 * Применяет только те кандидаты, которым это разрешено.
 *
 * Возвращает ТОТ ЖЕ объект, если применять нечего, — по образцу
 * `normalizeLineVatAgainstHeader`: вызывающему удобно отличать «правило
 * сработало» от «ничего не изменилось» сравнением ссылок.
 */
export function applyQtyRepairs(
  parsed: UpdPdfParsed,
  candidates: ReadonlyArray<QtyRepairCandidate>,
): { parsed: UpdPdfParsed; applied: QtyRepairCandidate[] } {
  const applied = candidates.filter((c) => c.applicable);
  if (applied.length === 0) return { parsed, applied: [] };
  const byRow = new Map(applied.map((c) => [c.row, c]));
  return {
    parsed: {
      ...parsed,
      items: parsed.items.map((item, idx) => {
        const c = byRow.get(idx + 1);
        return c ? { ...item, qty: c.qtyTo } : item;
      }),
    },
    applied,
  };
}

/** Состояние записи следа. */
export type QtyRepairState = 'observed' | 'applied' | 'reverted';

export type QtyRepairEntry = {
  state: QtyRepairState;
  row: number;
  /**
   * Идентификатор строки в БД (`source_document_items.id`), если он уже
   * известен. У фото-снимка строки своих идентификаторов не имеют, там
   * остаётся номер позиции.
   */
  itemId?: string | null;
  kind: QtyRepairClass;
  qtyFrom: number;
  qtyTo: number;
  price: number;
  sum: number;
  base: number;
  unit: string | null;
  okeiCode: number | null;
  blockedBy?: QtyRepairCandidate['blockedBy'];
  /** Проставляется вручную после сверки со сканом. */
  verifiedAgainstScan?: boolean;
  revertedAt?: string;
};

/**
 * След правила в служебной колонке.
 *
 * Версия результата разбора (`generation`/`docVersion`) обязательна: без неё
 * сохранённый след после повторного распознавания относился бы к НОВЫМ
 * числам, и откат вернул бы количество, которого в этом разборе не было.
 */
export type QtyRepairTrace = {
  ruleVersion: number;
  mode: QtyRepairMode;
  detectedAt: string;
  /** `dispatch_generation` документа; у фото поля нет — null. */
  generation: number | null;
  /** `version` документа или `updated_at` снимка фото в ISO. */
  docVersion: number | string | null;
  entries: QtyRepairEntry[];
};

/**
 * Собирает след: применённые кандидаты помечаются `applied`, остальные —
 * `observed`. Режим `on` не означает, что применён каждый кандидат: дробные и
 * неразрешённые классы остаются наблюдением, и откат их не трогает.
 */
export function buildQtyRepairTrace(args: {
  mode: QtyRepairMode;
  candidates: ReadonlyArray<QtyRepairCandidate>;
  appliedRows: ReadonlySet<number>;
  generation: number | null;
  docVersion: number | string | null;
  itemIdByRow?: ReadonlyMap<number, string>;
}): QtyRepairTrace | null {
  if (args.candidates.length === 0) return null;
  return {
    ruleVersion: QTY_REPAIR_RULE_VERSION,
    mode: args.mode,
    detectedAt: new Date().toISOString(),
    generation: args.generation,
    docVersion: args.docVersion,
    entries: args.candidates.map((c) => ({
      state: args.appliedRows.has(c.row) ? ('applied' as const) : ('observed' as const),
      row: c.row,
      ...(args.itemIdByRow?.has(c.row) ? { itemId: args.itemIdByRow.get(c.row)! } : {}),
      kind: c.kind,
      qtyFrom: c.qtyFrom,
      qtyTo: c.qtyTo,
      price: c.price,
      sum: c.sum,
      base: c.base,
      unit: c.unit,
      okeiCode: c.okeiCode,
      ...(c.blockedBy ? { blockedBy: c.blockedBy } : {}),
    })),
  };
}
