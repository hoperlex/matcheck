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
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
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
    // Названия организаций сравниваются ПО СМЫСЛУ, тем же правилом, что и в
    // бою (normalizeOrgName). Через str() одно и то же юрлицо в написании
    // «ООО ЛИФТФИТ» и «ООО "ЛИФТФИТ"» расходилось на кавычках — и это
    // засчитывалось РЕГРЕССОМ критического поля, то есть блокировало выкат
    // версии, которая ничего не сломала. Кавычки в ответе модели пляшут от
    // прогона к прогону, поэтому такой гейт не пропустил бы ни одну версию.
    'supplier.name': normalizeOrgName(p.supplier?.name) || '∅',
    'recipient.inn': str(p.recipient?.inn),
    'recipient.kpp': str(p.recipient?.kpp),
    'recipient.name': normalizeOrgName(p.recipient?.name) || '∅',
    'consignee.inn': str(p.consignee?.inn),
    'consignee.kpp': str(p.consignee?.kpp),
    'consignee.name': normalizeOrgName(p.consignee?.name) || '∅',
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
   * Изменения, которые действительно решают судьбу документа.
   *
   * Остальное — оценочные поля: масса и объём единицы товара, категория
   * («стекло» → «прочее»), уверенность модели. Они шевелятся от ЛЮБОЙ правки
   * промпта, эталона у них нет и быть не может (это оценка, а не то, что
   * напечатано в бланке), а блокировали выкат наравне с ценой. Видеть их в
   * отчёте полезно, запрещать из-за них исправление цены — нет.
   */
  changedCritical: string[];
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

/**
 * Совпало ли изменившееся поле с ЭТАЛОНОМ.
 *
 * Ключевое различение всего сравнения. Отчёт видит, что поле изменилось, но не
 * знает, в какую сторону: `price: 76032 → 6846.72` и `price: 6846.72 → 76032`
 * для diff-а одинаковы. Эталон это знает — на скане 1697 в бланке напечатано
 * 6 846,72, и новая версия прочитала верно. Считать такое регрессом — значит
 * запрещать ровно то исправление, ради которого версия и делалась.
 *
 * Работает только там, где разметка есть. Неразмеченное поле остаётся в списке
 * изменений: мы не знаем, как правильно, и решает человек.
 */
/** Худший из двух вердиктов базы: дефект «через раз» — это дефект базы. */
function worstVerdict(a: ExpectationVerdict, b: ExpectationVerdict): ExpectationVerdict {
  const rank = (v: ExpectationVerdict): number =>
    v.status === 'mismatch' ? 3 : v.status === 'filled_from_text' ? 2 : v.status === 'ok' ? 1 : 0;
  return rank(b) > rank(a) ? b : a;
}

export function confirmedByExpectation(
  key: string,
  parsed: UpdPdfParsed,
  expected: ExpectedDocument | undefined,
): boolean {
  if (!expected) return false;

  if (key === 'totalSum' || key === 'vatSum') {
    if (!(key in expected)) return false;
    return sameMoney(expected[key] ?? null, parsed[key] ?? null, SCALE.money);
  }

  // Позиция ищется по номеру из графы 1 — тому же ключу, по которому сверяются
  // деньги. Индексная форма (`items[0]`) сюда не подходит: при потерянной
  // строке индексы едут, и «подтверждением» стала бы чужая позиция.
  const match = /^items\[row(\d+)]\.(qty|price|sum|vatSum)$/.exec(key);
  if (!match) return false;
  const rowNo = Number(match[1]);
  const field = match[2] as 'qty' | 'price' | 'sum' | 'vatSum';

  const want = (expected.items ?? []).find((i) => i.rowNo === rowNo);
  if (!want || !(field in want)) return false;

  const rows = parsed.items.filter((i) => i.rowNo === rowNo);
  if (rows.length !== 1) return false;

  const scale = field === 'qty' ? SCALE.qty : field === 'price' ? SCALE.price : SCALE.money;
  return sameMoney(want[field] ?? null, rows[0]![field] ?? null, scale);
}

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
  const changed = diffKeys(sa1, sb).filter(
    (k) =>
      !unstableSet.has(k) &&
      !isConsigneeKey(k) &&
      // Поле, совпавшее с эталоном, изменилось В ПРАВИЛЬНУЮ сторону.
      !confirmedByExpectation(k, args.b, args.expected),
  );

  const bucketA = confidenceBucket(args.a1.confidence);
  const bucketB = confidenceBucket(args.b.confidence);

  return {
    label: args.label,
    unstable,
    unstableCritical: unstable.filter(isCriticalKey),
    changed,
    changedCritical: changed.filter(isCriticalKey),
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
    baseExpectation: worstVerdict(
      checkConsigneeAgainstExpectation(
        { label: args.label, parsed: args.a1, consigneeFromModel: args.consigneeFromModel },
        args.expected,
        args.hasConsignee,
      ),
      // Второй прогон базы обязателен: на сканах модель подставляет ИНН
      // покупателя через раз. Считая базу по одному прогону, мы объявляли бы
      // «новым» дефект, который у неё просто дрожит.
      checkConsigneeAgainstExpectation(
        { label: args.label, parsed: args.a2, consigneeFromModel: args.consigneeFromModel },
        args.expected,
        args.hasConsignee,
      ),
    ),
    baseMoneyMismatches: [
      ...checkMoneyAgainstExpectation(args.a1, args.expected),
      ...checkMoneyAgainstExpectation(args.a2, args.expected),
    ],
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

  // Блокируют только КРИТИЧЕСКИЕ изменения: номер, дата, стороны, состав и
  // деньги позиций. Оценочные поля (масса, объём, категория, уверенность)
  // шевелятся от любой правки текста промпта, эталона у них нет, и запрет
  // из-за них означал бы «никаких новых версий никогда».
  const regressed = input.comparisons.filter((c) => c.changedCritical.length > 0);
  if (regressed.length > 0) {
    blockers.push(`регрессии критических полей: ${regressed.length}`);
  }

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

/**
 * Целочисленный аргумент командной строки со строгой проверкой.
 *
 * Молчаливая интерпретация мусора здесь стоит денег: `--limit abc` давал
 * `Number('abc')` = NaN, проверка `Number.isFinite(NaN)` возвращала false, и
 * `slice(0, undefined)` прогонял ВЕСЬ корпус вместо подмножества — опечатка в
 * команде оборачивалась примерно 180 вызовами модели вместо 15. Поэтому здесь
 * бросается ошибка, а не подставляется значение по умолчанию.
 */
export function parseIntArg(raw: string | null | undefined, flag: string, fallback: number): number {
  if (raw == null) return fallback;
  // Пустая строка отдельной проверкой: Number('') равен НУЛЮ, а не NaN,
  // поэтому `--limit ""` прошло бы валидацию и дало пустое окно — прогон без
  // единого документа, который гейт объявил бы «нет разобранных документов»
  // только на выходе, потратив время впустую.
  if (raw.trim() === '') {
    throw new Error(`${flag}: ожидается целое число ≥ 0, получено пустое значение`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${flag}: ожидается целое число ≥ 0, получено «${raw}»`);
  }
  return value;
}

/**
 * Окно прогона: часть корпуса, которую берёт этот запуск.
 *
 * Отдельная функция, а не `slice` по месту: границы окна — то, чем части
 * стыкуются между собой, и ошибка здесь тихо оставляет кусок корпуса
 * непроверенным.
 */
export function windowOf<T>(items: readonly T[], offset: number, limit: number): T[] {
  return items.slice(offset, offset + limit);
}

export type CoverageWindow = { offset: number; taken: number };

/**
 * Насколько части покрыли корпус.
 *
 * Пропуск и пересечение — разные болезни: первое означает непроверенные
 * документы (и потому блокирует вывод «регрессий нет»), второе лишь раздувает
 * статистику повтором одного файла.
 */
export function coverageOf(
  windows: readonly CoverageWindow[],
  selected: number,
): { covered: number; overlaps: number; missing: number[] } {
  const seen = new Set<number>();
  let overlaps = 0;
  for (const w of windows) {
    for (let i = w.offset; i < w.offset + w.taken; i += 1) {
      if (seen.has(i)) overlaps += 1;
      seen.add(i);
    }
  }
  const missing: number[] = [];
  for (let i = 0; i < selected; i += 1) if (!seen.has(i)) missing.push(i);
  return { covered: seen.size, overlaps, missing };
}

/**
 * Поля отчёта, без которых прогон невоспроизводим.
 *
 * Список существует потому, что отчёт читается ПОЗЖЕ и другим человеком.
 * Отсутствие хеша промпта или модели вызова не мешает файлу выглядеть
 * полноценным, но делает вывод «регрессий нет» непроверяемым: неизвестно, какие
 * версии сравнивали и одной ли моделью. Поэтому агрегатор такой файл отвергает,
 * а не сводит молча.
 */
const REQUIRED_REPORT_PATHS = [
  'formatVersion',
  'docKind',
  'window.offset',
  'window.taken',
  'window.selected',
  'corpus.manifestSha256',
  'prompts.base.id',
  'prompts.base.sha256',
  'prompts.fresh.id',
  'prompts.fresh.sha256',
  'git',
  'calls',
  'failures',
  'comparisons',
] as const;

function atPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, value);
}

/** Какие обязательные поля отчёта отсутствуют. Пустой массив — отчёт пригоден. */
export function missingReportFields(report: unknown): string[] {
  return REQUIRED_REPORT_PATHS.filter((path) => atPath(report, path) === undefined);
}

/** Вызов модели, как он записан в журнале (llm_calls). */
export type AbCallRecord = {
  promptId: string | null;
  model: string | null;
};

/**
 * Промпты, которые обслуживали БОЛЕЕ ОДНОЙ модели.
 *
 * Это условие достоверности всего сравнения, а не мелочь отчёта. Текстовый путь
 * при ошибке молча переходит к следующему провайдеру, а vision берёт того, кто
 * помечен основным. Если половина вызовов одной версии ушла к другой модели,
 * разница в отчёте объясняется моделью, а не текстом промпта, — и вывод «новая
 * версия лучше» недоказуем.
 *
 * Возвращает карту «промпт → модели», чтобы вызывающий мог назвать версию по
 * имени: сам идентификатор пользователю ничего не говорит.
 */
export function mixedModelPrompts(calls: readonly AbCallRecord[]): Map<string, string[]> {
  const byPrompt = new Map<string, Set<string>>();
  for (const call of calls) {
    if (!call.promptId || !call.model) continue;
    const set = byPrompt.get(call.promptId) ?? new Set<string>();
    set.add(call.model);
    byPrompt.set(call.promptId, set);
  }
  const mixed = new Map<string, string[]>();
  for (const [promptId, models] of byPrompt) {
    if (models.size > 1) mixed.set(promptId, [...models].sort());
  }
  return mixed;
}

/** Минимум из отчёта, по которому решается, об одном ли прогоне идёт речь. */
export type AbReportIdentity = {
  docKind: string;
  prompts: {
    base: { name: string; sha256: string };
    fresh: { name: string; sha256: string };
  };
  corpus: { manifestSha256: string };
  git: { sha: string | null };
};

/**
 * Отпечаток условий прогона.
 *
 * Разложен по частям, а не свёрнут в строку: когда части не сходятся, надо
 * сразу видеть, ЧТО именно разошлось — вид прогона, версия промпта, эталон или
 * код. Сообщение «что-то не совпало» заставляет перепроверять всё подряд.
 */
export function reportIdentity(r: AbReportIdentity): Record<string, string> {
  return {
    'вид прогона': r.docKind,
    'базовый промпт': `${r.prompts.base.name} (${r.prompts.base.sha256.slice(0, 12)})`,
    'новый промпт': `${r.prompts.fresh.name} (${r.prompts.fresh.sha256.slice(0, 12)})`,
    эталон: r.corpus.manifestSha256.slice(0, 12),
    'код (git)': r.git.sha ?? 'неизвестен',
  };
}

/**
 * Чем одна часть отличается от другой. Пусто — части можно сводить.
 *
 * Сводить несовместимые части опаснее, чем не сводить вовсе: получился бы
 * внешне полноценный отчёт, в котором половина документов проверена одной
 * версией промпта, а половина — другой.
 */
export function identityDiff(a: AbReportIdentity, b: AbReportIdentity): string[] {
  const left = reportIdentity(a);
  const right = reportIdentity(b);
  return Object.keys(left)
    .filter((k) => left[k] !== right[k])
    .map((k) => `${k}: «${left[k]}» против «${right[k]}»`);
}

/**
 * Сохранение отчёта, которое не теряет результат из-за прав на каталог.
 *
 * Прогон стоит денег и времени: двадцать семь вызовов модели за одно окно.
 * Уронить его на последнем шаге из-за EACCES — значит выбросить всю работу,
 * что однажды и случилось: каталог отчётов создан пользователем matcheck, а
 * контейнер работает под node. Поэтому при отказе пробуем запасной путь и в
 * любом случае объясняем, что чинить.
 */
export async function writeReportSafely(
  outPath: string,
  report: unknown,
  log: (line: string) => void,
): Promise<void> {
  const body = `${JSON.stringify(report, null, 2)}\n`;
  try {
    await writeFile(outPath, body, 'utf8');
    log(`отчёт сохранён: ${resolve(outPath)}`);
    return;
  } catch (err) {
    const code = (err as { code?: string }).code ?? '';
    log(`не удалось записать ${outPath}${code ? ` (${code})` : ''}`);
    if (code === 'EACCES') {
      log('  каталог принадлежит другому пользователю — на сервере поможет:');
      log(`  chmod 777 ${dirname(resolve(outPath))}`);
    }
  }
  // Запасной путь во временном каталоге: он доступен на запись всегда.
  const fallback = join(tmpdir(), basename(outPath));
  try {
    await writeFile(fallback, body, 'utf8');
    log(`отчёт сохранён во ВРЕМЕННЫЙ файл: ${fallback}`);
    log('  заберите его оттуда — при перезапуске контейнера он пропадёт.');
  } catch {
    log('запасной путь тоже недоступен — отчёт НЕ сохранён, результат окна потерян.');
  }
}
