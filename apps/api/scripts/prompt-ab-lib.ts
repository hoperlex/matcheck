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
// Общий с боевым кодом (party-directory-guard): сравнение названий сторон
// должно быть одним правилом, иначе гейт сверки разойдётся с воркером.
import { normalizeOrgName } from '../src/domain/sourceDocuments/org-name.js';

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
  // Ключ позиции — либо индекс (`items[0]`), либо номер из графы 1
  // (`items[row1]`), см. snapshotOf. Без второй формы критические поля
  // перестали бы считаться критическими ровно на тех документах, где номера
  // распознались, то есть на самых проверяемых.
  return /^items\[(?:\d+|row\d+)]\.(nameRaw|qty|price|sum)$/.test(key);
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
  //
  // Ключ строки — НОМЕР ИЗ ГРАФЫ 1, когда он есть и уникален. По индексу
  // массива сравнение ломается от перестановки строк: модель вернула те же
  // позиции в другом порядке — и весь снимок «разошёлся», хотя разбор верный.
  // Когда номеров нет (старые промпты, текстовый путь) или они повторяются,
  // остаётся индекс: сравнивать всё равно надо, просто без этой страховки.
  const rowNos = p.items.map((it) => it.rowNo ?? null);
  const uniqueRowNos =
    rowNos.every((n) => n != null) && new Set(rowNos).size === rowNos.length;
  const keyOf = (i: number) => (uniqueRowNos ? `row${rowNos[i]}` : `${i}`);
  p.items.forEach((it, index) => {
    const i = keyOf(index);
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

/**
 * Эталон одной позиции: только то, что действительно проверено по бумаге.
 *
 * Разница между `null` и отсутствующим полем принципиальна:
 *   * `null`  — «в бланке этой графы нет» (документ без цен). Это проверяемое
 *               утверждение: модель не должна ничего туда подставлять;
 *   * поля нет — «мы не размечали». Сверка молчит.
 * Без такого различения неразмеченный документ засчитывался бы как эталонный
 * ноль, и любая подставленная цена выглядела бы регрессией.
 */
export type ExpectedItem = {
  /** Номер позиции из графы 1 — по нему позиция и находится в разборе. */
  rowNo: number;
  qty?: number | null;
  price?: number | null;
  sum?: number | null;
  vatSum?: number | null;
};

/** Эталон одного логического документа из манифеста. */
export type ExpectedDocument = {
  docNumber: string;
  consignee: { name: string; inn: string | null; kpp: string | null };
  /** Итоги документа. Отсутствуют — не размечены, сверка пропускается. */
  totalSum?: number | null;
  vatSum?: number | null;
  /** Позиции. Размечать можно частично: сверяются только перечисленные. */
  items?: ExpectedItem[];
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

/** Только цифры — ИНН/КПП в ответах приходят и с пробелами, и с дефисами. */
function digits(v: string | null | undefined): string {
  return (v ?? '').replace(/\D/g, '');
}

export function checkConsigneeAgainstExpectation(
  unit: ParsedUnit,
  expected: ExpectedDocument | undefined,
  /**
   * false — в документе графа 4 пуста (напечатана только подпись). Это тоже
   * проверяемое утверждение: модель не должна выдумывать сторону там, где её
   * нет, и не должна возвращать вместо значения саму подпись графы.
   */
  hasConsignee?: boolean | null,
): ExpectationVerdict {
  const gotName = unit.parsed.consignee?.name ?? null;

  if (hasConsignee === false) {
    if (!gotName) return { status: 'ok' };
    return {
      status: 'mismatch',
      detail: `графа 4 в документе пуста, но модель вернула «${gotName}»`,
    };
  }

  if (!expected) return { status: 'no_expectation' };
  const got = gotName;
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

  // Реквизиты сверяются В ОБЕ СТОРОНЫ, включая эталонный null.
  //
  // Прежняя версия проверяла ИНН только при непустом ожидании
  // (`if (wantInn && …)`), а КПП не проверяла вовсе — и пропускала ровно тот
  // дефект, ради которого всё это писалось: в графе 4 реквизитов нет (эталон
  // null), а модель подставляет туда ИНН и КПП покупателя. Такой прогон
  // отчитывался «грузополучатель распознан», хотя документ получал чужие
  // реквизиты и связывался с чужой организацией.
  for (const field of ['inn', 'kpp'] as const) {
    const wantValue = expected.consignee[field];
    const gotValue = unit.parsed.consignee?.[field] ?? null;
    if (digits(wantValue) === digits(gotValue)) continue;
    const label = field === 'inn' ? 'ИНН' : 'КПП';
    return {
      status: 'mismatch',
      detail: wantValue
        ? `${label}: ожидался ${wantValue}, получен ${gotValue ?? '∅'}`
        : // Самый частый случай: в документе реквизита нет, а модель его
          // выдумала — почти всегда скопировав у покупателя.
          `${label} не напечатан в графе 4, но модель вернула ${gotValue ?? '∅'}`,
    };
  }

  return { status: 'ok' };
}

/** Расхождение разбора с эталоном по деньгам. */
export type MoneyMismatch = { where: string; detail: string };

/** Сравнение с точностью хранения: 12.10 и 12.1 — одно и то же значение. */
function sameMoney(want: number | null, got: number | null | undefined, scale: number): boolean {
  return num(want, scale) === num(got ?? null, scale);
}

/**
 * Сверка денег с ЭТАЛОНОМ, а не между прогонами.
 *
 * Сравнение двух версий промпта между собой ловит изменения, но не ошибки:
 * если обе версии одинаково перенесли количество в графу суммы, диффа нет и
 * прогон выглядит успешным. Поэтому цены, суммы и итоги сверяются с тем, что
 * напечатано в бумаге.
 *
 * Позиции ищутся ПО НОМЕРУ ИЗ ГРАФЫ 1, а не по индексу массива: индекс едет от
 * любой потерянной или задвоенной строки — ровно от того, что и надо ловить.
 * Номер, которого в разборе нет, — тоже расхождение: позиция потеряна.
 */
export function checkMoneyAgainstExpectation(
  parsed: UpdPdfParsed,
  expected: ExpectedDocument | undefined,
): MoneyMismatch[] {
  if (!expected) return [];
  const out: MoneyMismatch[] = [];

  if ('totalSum' in expected && !sameMoney(expected.totalSum ?? null, parsed.totalSum, SCALE.money)) {
    out.push({
      where: 'итог документа',
      detail: `ожидалось ${num(expected.totalSum ?? null, SCALE.money)}, получено ${num(parsed.totalSum, SCALE.money)}`,
    });
  }
  if ('vatSum' in expected && !sameMoney(expected.vatSum ?? null, parsed.vatSum, SCALE.money)) {
    out.push({
      where: 'НДС документа',
      detail: `ожидалось ${num(expected.vatSum ?? null, SCALE.money)}, получено ${num(parsed.vatSum, SCALE.money)}`,
    });
  }

  for (const want of expected.items ?? []) {
    const matches = parsed.items.filter((it) => it.rowNo === want.rowNo);
    if (matches.length === 0) {
      out.push({ where: `строка ${want.rowNo}`, detail: 'позиции с таким номером в разборе нет' });
      continue;
    }
    if (matches.length > 1) {
      out.push({ where: `строка ${want.rowNo}`, detail: `номер задвоен: ${matches.length} позиций` });
      continue;
    }
    const got = matches[0]!;
    const fields = [
      ['qty', SCALE.qty, 'количество'],
      ['price', SCALE.price, 'цена'],
      ['sum', SCALE.money, 'сумма'],
      ['vatSum', SCALE.money, 'НДС'],
    ] as const;
    for (const [field, scale, label] of fields) {
      if (!(field in want)) continue;
      const wantValue = want[field] ?? null;
      const gotValue = got[field] ?? null;
      if (sameMoney(wantValue, gotValue, scale)) continue;
      out.push({
        where: `строка ${want.rowNo}`,
        detail:
          wantValue == null
            ? `${label} в бумаге не напечатана, а модель вернула ${num(gotValue, scale)}`
            : `${label}: ожидалось ${num(wantValue, scale)}, получено ${num(gotValue, scale)}`,
      });
    }
  }

  return out;
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
  /** Расхождения по деньгам с эталоном (пусто — либо всё сошлось, либо не размечено). */
  moneyMismatches: MoneyMismatch[];
  /**
   * Что именно изменилось: поле, было, стало.
   *
   * Без значений отчёт называет поле, но не отвечает на главный вопрос —
   * улучшение это или регресс. `itemsCount: ∅ → 1` на бланке, где напечатано
   * «Всего наименований: 1», и `qty: 22 → 221` выглядят в списке одинаково,
   * а означают противоположное.
   */
  changedDetails: Array<{ key: string; from: string; to: string }>;
  /**
   * Те же расхождения с эталоном у БАЗОВОЙ версии.
   *
   * Нужны, чтобы отделить «новая версия сломала» от «сломано и было». Второе
   * блокировать нельзя: часть дефектов промптом не лечится вовсе — запрет
   * подставлять ИНН покупателя в графу 4 написан ещё в v13, а модель его
   * игнорирует. Без этого разделения гейт запрещал бы любую новую версию,
   * пока не вылечен старый дефект, то есть навсегда.
   */
  baseExpectation: ExpectationVerdict;
  baseMoneyMismatches: MoneyMismatch[];
};

export function compareUnit(args: {
  label: string;
  a1: UpdPdfParsed;
  a2: UpdPdfParsed;
  b: UpdPdfParsed;
  consigneeFromModel: boolean;
  expected: ExpectedDocument | undefined;
  /** false — графа 4 в документе пуста (см. checkConsigneeAgainstExpectation). */
  hasConsignee?: boolean | null;
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
    changedDetails: changed.map((key) => ({
      key,
      from: sa1[key] ?? '∅',
      to: sb[key] ?? '∅',
    })),
    confidenceShift: bucketA === bucketB ? null : `${bucketA} → ${bucketB}`,
    expectation: checkConsigneeAgainstExpectation(
      { label: args.label, parsed: args.b, consigneeFromModel: args.consigneeFromModel },
      args.expected,
      args.hasConsignee,
    ),
    moneyMismatches: checkMoneyAgainstExpectation(args.b, args.expected),
    baseExpectation: checkConsigneeAgainstExpectation(
      { label: args.label, parsed: args.a1, consigneeFromModel: args.consigneeFromModel },
      args.expected,
      args.hasConsignee,
    ),
    baseMoneyMismatches: checkMoneyAgainstExpectation(args.a1, args.expected),
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
/**
 * Расхождения по деньгам, которых у базовой версии не было.
 *
 * Ключ — «где» плюс «что»: одна и та же строка может разойтись и по цене, и по
 * количеству, и лечиться эти случаи будут по-разному.
 */
export function newMoneyMismatches(c: UnitComparison): MoneyMismatch[] {
  const was = new Set(c.baseMoneyMismatches.map((m) => `${m.where}|${m.detail}`));
  return c.moneyMismatches.filter((m) => !was.has(`${m.where}|${m.detail}`));
}

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

  // Блокируют только НОВЫЕ расхождения — те, которых у базовой версии не было.
  // Унаследованные остаются в отчёте (их видно отдельной строкой), но не
  // запрещают выкат: они существуют и сейчас, на активном промпте, и держать
  // из-за них улучшение — значит не выпустить его никогда.
  const mismatch = input.comparisons.filter(
    (c) => c.expectation.status === 'mismatch' && c.baseExpectation.status !== 'mismatch',
  );
  if (mismatch.length > 0) blockers.push(`НОВОЕ расхождение с эталоном: ${mismatch.length}`);

  // Деньги считаются отдельно: «обе версии ошиблись одинаково» не даёт диффа
  // между прогонами и без сверки с эталоном прошло бы как успех.
  const money = input.comparisons.filter((c) => newMoneyMismatches(c).length > 0);
  if (money.length > 0) {
    const rows = money.reduce((acc, c) => acc + newMoneyMismatches(c).length, 0);
    blockers.push(`НОВОЕ расхождение сумм с эталоном: ${money.length} док. / ${rows} полей`);
  }

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
