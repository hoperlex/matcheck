/**
 * Чистая часть сверки версий промпта: снимок разбора, диффы и оценка гейта.
 *
 * Вынесена из upd-prompt-ab.ts, чтобы сам критерий «можно активировать» был
 * покрыт тестами. Гейт, который никем не проверен, — это не гейт: ошибка в нём
 * не видна вообще никак, а цена ошибки — включённый промпт, который портит
 * распознавание на всём потоке документов.
 *
 * Здесь нет ни БД, ни сети, ни файловой системы.
 */
import type { UpdPdfParsed } from '@matcheck/contracts';

/** Нормализованный снимок разбора: то, что сравнивается между прогонами. */
export type Snapshot = Record<string, string>;

/**
 * Точность сравнения ДОЛЖНА совпадать с точностью хранения, иначе сверка
 * «зелёная» там, где в БД поедут значения:
 *   source_document_items.qty / price / volume_m3 — numeric(_, 4)
 *   source_document_items.mass_kg                 — numeric(_, 3)
 *   суммы и НДС                                   — numeric(_, 2)
 *   source_documents.llm_confidence               — numeric(4, 3)
 */
export const SCALE = {
  qty: 4,
  price: 4,
  volumeM3: 4,
  massKg: 3,
  money: 2,
  confidence: 3,
} as const;

export function num(v: number | null | undefined, scale: number): string {
  if (v == null) return '∅';
  const f = 10 ** scale;
  return (Math.round(v * f) / f).toFixed(scale);
}

export function str(v: string | null | undefined): string {
  if (v == null) return '∅';
  return v.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Пороги confidence — это развилки маршрута документа, а не отчётное число:
 *   < 0.5  — документ признаётся слабым, заказывается второй проход
 *            (weakParseReasons, worker.ts);
 *   >= 0.6 — включается дедупликация и автоподстановка подрядчика
 *            (MIN_DEDUP_CONFIDENCE, worker.ts).
 * Промпт может сдвинуть confidence, не тронув ни одного видимого поля, — и
 * документы поедут другим путём. Поэтому переходы отслеживаются отдельно.
 */
export const CONFIDENCE_THRESHOLDS = [0.5, 0.6] as const;

export function confidenceBucket(v: number | null | undefined): string {
  if (v == null) return '∅';
  if (v < 0.5) return '<0.5';
  if (v < 0.6) return '0.5–0.6';
  return '≥0.6';
}

/**
 * Поля, расхождение которых между двумя прогонами ОДНОЙ версии промпта — не
 * «шум модели», а стоп-сигнал. Раньше всё нестабильное в A/A молча исключалось
 * из критерия, включая номер документа и позиции: если база сама себе не
 * воспроизводится по номеру, сравнивать её с новой версией бессмысленно.
 */
export function isCriticalKey(key: string): boolean {
  if (['docNumber', 'docDate', 'items.length', 'totalSum', 'vatSum'].includes(key)) return true;
  if (key.startsWith('recipient.') || key.startsWith('supplier.')) return true;
  return /^items\[\d+]\.(nameRaw|qty|price|sum)$/.test(key);
}

/** Ключи снимка, относящиеся к добавляемому полю (им меняться разрешено). */
export function isConsigneeKey(key: string): boolean {
  return key.startsWith('consignee.');
}

export function snapshotOf(p: UpdPdfParsed): Snapshot {
  const s: Snapshot = {
    docNumber: str(p.docNumber),
    docDate: str(p.docDate),
    totalSum: num(p.totalSum, SCALE.money),
    vatSum: num(p.vatSum, SCALE.money),
    itemsCount: p.itemsCount == null ? '∅' : String(p.itemsCount),
    confidence: num(p.confidence, SCALE.confidence),
    confidenceBucket: confidenceBucket(p.confidence),
    'supplier.inn': str(p.supplier?.inn),
    'supplier.kpp': str(p.supplier?.kpp),
    'supplier.name': str(p.supplier?.name),
    'recipient.inn': str(p.recipient?.inn),
    'recipient.kpp': str(p.recipient?.kpp),
    'recipient.name': str(p.recipient?.name),
    'consignee.inn': str(p.consignee?.inn),
    'consignee.kpp': str(p.consignee?.kpp),
    'consignee.name': str(p.consignee?.name),
    'items.length': String(p.items.length),
  };
  // Позиции целиком, а не только их количество: перепутанные цена и сумма или
  // съехавшее наименование при равной длине массива иначе прошли бы незаметно.
  p.items.forEach((it, i) => {
    s[`items[${i}].nameRaw`] = str(it.nameRaw);
    s[`items[${i}].qty`] = num(it.qty, SCALE.qty);
    s[`items[${i}].unit`] = str(it.unit);
    s[`items[${i}].price`] = num(it.price, SCALE.price);
    s[`items[${i}].sum`] = num(it.sum, SCALE.money);
    s[`items[${i}].vatRate`] = num(it.vatRate, SCALE.money);
    s[`items[${i}].vatSum`] = num(it.vatSum, SCALE.money);
    // Объём и масса участвуют в прогнозе загрузки транспорта, groupName — в
    // группировке позиций на портале. Промпт их задевает так же легко.
    s[`items[${i}].volumeM3`] = num(it.volumeM3, SCALE.volumeM3);
    s[`items[${i}].massKg`] = num(it.massKg, SCALE.massKg);
    s[`items[${i}].volumeConfidence`] = str(it.volumeConfidence);
    s[`items[${i}].groupName`] = str(it.groupName);
  });
  return s;
}

export function diffKeys(a: Snapshot, b: Snapshot): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    if ((a[k] ?? '∅') !== (b[k] ?? '∅')) out.push(k);
  }
  return out.sort();
}

/** Эталон одного логического документа из манифеста. */
export type ExpectedDocument = {
  docNumber: string;
  consignee: { name: string; inn: string | null; kpp: string | null };
};

/** Разбор одного логического документа (для multi_upd — одного субдокумента). */
export type ParsedUnit = {
  /** Чем помечен в отчёте: имя файла или «файл#номер». */
  label: string;
  parsed: UpdPdfParsed;
  /**
   * Пришёл ли грузополучатель ОТ МОДЕЛИ. false — дозаполнен регулярками
   * (fillPartiesFromText): такой результат не доказывает работу промпта, ведь
   * регулярки работают и на старой версии.
   */
  consigneeFromModel: boolean;
};

export type ExpectationVerdict =
  | { status: 'ok' }
  | { status: 'no_expectation' }
  | { status: 'mismatch'; detail: string }
  | { status: 'filled_from_text'; detail: string };

/** Сравнение имени организации: регистр, кавычки и пробелы не считаются. */
export function normalizeOrgName(v: string | null | undefined): string {
  if (!v) return '';
  return v
    .replace(/[«»"'']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function checkConsigneeAgainstExpectation(
  unit: ParsedUnit,
  expected: ExpectedDocument | undefined,
): ExpectationVerdict {
  if (!expected) return { status: 'no_expectation' };
  const got = unit.parsed.consignee?.name ?? null;
  const want = expected.consignee.name;

  if (normalizeOrgName(got) !== normalizeOrgName(want)) {
    return { status: 'mismatch', detail: `ожидалось «${want}», получено «${got ?? '∅'}»` };
  }
  if (!unit.consigneeFromModel) {
    return {
      status: 'filled_from_text',
      detail: `«${want}» дозаполнен регулярками, а не моделью — промпт этого не доказывает`,
    };
  }
  const wantInn = expected.consignee.inn;
  if (wantInn && (unit.parsed.consignee?.inn ?? null) !== wantInn) {
    return {
      status: 'mismatch',
      detail: `ИНН: ожидался ${wantInn}, получен ${unit.parsed.consignee?.inn ?? '∅'}`,
    };
  }
  return { status: 'ok' };
}

/** Сопоставление разбора с эталоном: по номеру документа, индекс — запасной. */
export function matchExpectation(
  parsed: UpdPdfParsed,
  index: number,
  expectations: ExpectedDocument[] | undefined,
): ExpectedDocument | undefined {
  if (!expectations?.length) return undefined;
  const byNumber = expectations.find(
    (e) => str(e.docNumber) === str(parsed.docNumber) && str(parsed.docNumber) !== '∅',
  );
  // Порядок сегментов может поехать, номер документа — нет; индекс остаётся
  // только на случай, когда номер не распознался вовсе.
  return byNumber ?? expectations[index];
}

export type UnitComparison = {
  label: string;
  /** Ключи, разошедшиеся между двумя прогонами базовой версии. */
  unstable: string[];
  /** Нестабильные ключи, которые считаются критическими → блокер. */
  unstableCritical: string[];
  /** Стабильные ключи, изменившиеся у новой версии (кроме consignee). */
  changed: string[];
  /** Перешёл ли confidence через порог 0.5 / 0.6. */
  confidenceShift: string | null;
  expectation: ExpectationVerdict;
};

export function compareUnit(args: {
  label: string;
  a1: UpdPdfParsed;
  a2: UpdPdfParsed;
  b: UpdPdfParsed;
  consigneeFromModel: boolean;
  expected: ExpectedDocument | undefined;
}): UnitComparison {
  const sa1 = snapshotOf(args.a1);
  const sa2 = snapshotOf(args.a2);
  const sb = snapshotOf(args.b);

  const unstable = diffKeys(sa1, sa2);
  const unstableSet = new Set(unstable);
  const changed = diffKeys(sa1, sb).filter((k) => !unstableSet.has(k) && !isConsigneeKey(k));

  const bucketA = confidenceBucket(args.a1.confidence);
  const bucketB = confidenceBucket(args.b.confidence);

  return {
    label: args.label,
    unstable,
    unstableCritical: unstable.filter(isCriticalKey),
    changed,
    confidenceShift: bucketA === bucketB ? null : `${bucketA} → ${bucketB}`,
    expectation: checkConsigneeAgainstExpectation(
      { label: args.label, parsed: args.b, consigneeFromModel: args.consigneeFromModel },
      args.expected,
    ),
  };
}

export type GateInput = {
  checkedUnits: number;
  failures: { file: string; error: string }[];
  comparisons: UnitComparison[];
};

/**
 * Итог сверки. Пусто — активировать можно; иначе перечислены причины, по
 * которым нельзя.
 */
export function evaluateGate(input: GateInput): string[] {
  const blockers: string[] = [];

  if (input.checkedUnits === 0) {
    // Пустой прогон не должен выглядеть успешным: «регрессий нет» на нуле
    // документов — самый простой способ активировать непроверенный промпт.
    blockers.push('нет разобранных документов');
  }
  if (input.failures.length > 0) {
    blockers.push(`не разобрались файлы: ${input.failures.length}`);
  }

  const regressed = input.comparisons.filter((c) => c.changed.length > 0);
  if (regressed.length > 0) blockers.push(`регрессии стабильных полей: ${regressed.length}`);

  const unstableCritical = input.comparisons.filter((c) => c.unstableCritical.length > 0);
  if (unstableCritical.length > 0) {
    blockers.push(`нестабильные критические поля в A/A: ${unstableCritical.length}`);
  }

  const shifted = input.comparisons.filter((c) => c.confidenceShift);
  if (shifted.length > 0) blockers.push(`confidence пересёк порог: ${shifted.length}`);

  const mismatch = input.comparisons.filter((c) => c.expectation.status === 'mismatch');
  if (mismatch.length > 0) blockers.push(`расхождение с эталоном: ${mismatch.length}`);

  const fromText = input.comparisons.filter((c) => c.expectation.status === 'filled_from_text');
  if (fromText.length > 0) {
    blockers.push(`грузополучатель от регулярок, а не от модели: ${fromText.length}`);
  }

  const noExpectation = input.comparisons.filter((c) => c.expectation.status === 'no_expectation');
  if (noExpectation.length === input.comparisons.length && input.comparisons.length > 0) {
    blockers.push('ни у одного документа нет эталона в манифесте (сверять не с чем)');
  }

  return blockers;
}
