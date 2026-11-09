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
// Итог документа считается ТОЙ ЖЕ функцией, что и в бою. Повторить её правило
// здесь означало бы сверять промпт по выдуманному критерию: сравнение сказало
// бы «всё хорошо», а воркер отправил бы документ в partial_parse.
import { deriveUpdParseOutcome } from '../src/domain/edo/upd-outcome.js';
import { validateUpdTotals } from '../src/domain/edo/upd-validation.js';
// Пересчёт количества ТОРГ-12 и условие, при котором воркер его сохраняет, —
// тем же кодом, что в бою (см. simulateTorg12Qty).
import {
  applyTorg12Qty,
  detectTorg12Qty,
  torg12QtyAllowed,
} from '../src/domain/edo/torg12-qty.js';
import type { ParseMode } from '../src/domain/edo/parse-mode.js';

/**
 * Тип файла для модели по расширению — ОДНА таблица на все скрипты сверки.
 *
 * Копий было три (upd-prompt-ab, waybill-prompt-ab, corpus-manifest-build), и
 * они успели разойтись: `.jfif` — обычный JPEG с телефона — знала только одна.
 * Итог расхождения тихий: генератор манифеста такой файл пропускал, а сверка
 * помечала его как PDF и отправляла в модель заведомо неверно.
 *
 * Excel сюда не входит намеренно: его разбирает структурный парсер, промпт в
 * этом пути не участвует вовсе (см. corpus-manifest-build, где офисные типы
 * добавляются поверх этой таблицы).
 */
export const DOC_MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  // .jfif и .jpe — тот же JPEG, приходят с телефонов и из мессенджеров.
  '.jfif': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

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
  /**
   * Наименование и единица, как напечатаны. Сверяются только в целевом гейте
   * (checkAgainstExpectation): позиция, которой у базы не было вовсе, иначе
   * не отличить от выдуманной.
   */
  nameRaw?: string;
  unit?: string;
  qty?: number | null;
  price?: number | null;
  sum?: number | null;
  vatSum?: number | null;
  /**
   * Поля, которые новая версия ОБЯЗАНА исправить на этой строке.
   *
   * Гейт до этого умел только запрещать: он ловил регрессии, но версия,
   * повторившая поведение базы без единого улучшения, проходила зелёной. Для
   * промпта, который выпускают РАДИ исправления конкретного дефекта, это не
   * проверка вовсе.
   *
   * Цель адресуется тройкой «номер документа + номер строки + поле»:
   * `docNumber` берётся у объемлющего ExpectedDocument, `rowNo` — отсюда.
   * Пометка на уровне файла распалась бы на пакетах, где в одном PDF лежит
   * пятнадцать логических УПД.
   */
  mustFix?: Array<'qty' | 'price' | 'sum' | 'vatSum'>;
};

/** Эталон одного логического документа из манифеста. */
export type ExpectedDocument = {
  docNumber: string;
  /** Дата документа `YYYY-MM-DD`, как напечатана. Отсутствует — не размечена. */
  docDate?: string | null;
  /**
   * `true` — в `items` перечислены ВСЕ строки бумаги. Тогда лишняя или
   * потерянная строка — расхождение. Без пометки разметка частичная, и сверка
   * судит только о перечисленных строках.
   */
  itemsComplete?: boolean;
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

// ─── Целевой гейт: разбор против эталона, а не против базы ──────────────────
//
// Обычный гейт сравнивает новую версию с базой и любое изменение критического
// поля считает регрессом. Для версии, которую выпускают ради документа, где база
// не видит НИЧЕГО (накладная РОКВУЛ: ноль позиций, номер договора вместо номера
// документа), это запрет ровно на исправление: появление строк, новый номер и
// новая дата — всё «регресс». И обратное: если обе версии ошиблись одинаково,
// диффа нет и обычный гейт зелёный. Поэтому здесь каждая версия сверяется с
// бумагой напрямую, а отличия от базы только печатаются.

/**
 * Наименование для сравнения: то, чем модель варьирует одно и то же.
 *
 * Размер «1000х600х150» приходит то с кириллической «х», то с латинской «x»,
 * то со знаком умножения; кавычки и пробелы пляшут от прогона к прогону. Для
 * бумаги это одна строка. Нормализуются ОБЕ стороны, поэтому латинская «x» в
 * словах (FLEXI) на равенство не влияет.
 */
export function normalizeItemName(v: string | null | undefined): string {
  if (v == null) return '';
  return v
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[x×]/g, 'х')
    .replace(/["'«»„“”`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Единица для сравнения: «м²», «м2» и «м 2.» — одна и та же графа. */
export function normalizeUnit(v: string | null | undefined): string {
  return (v ?? '').toLowerCase().replace(/²/g, '2').replace(/³/g, '3').replace(/[\s.]/g, '');
}

export type ExpectationIssue = { where: string; detail: string };

/**
 * Строки разбора по номеру из графы 1.
 *
 * Когда номера не вернулись НИ У ОДНОЙ строки, номером служит порядок: строка
 * без номера в приёмке не хуже строки с номером, и валить на этом сверку
 * значило бы проверять формат ответа, а не чтение бумаги. Если номер есть хотя
 * бы у одной строки — только по номеру: тогда пропуск номера уже улика.
 */
function rowsByNo(parsed: UpdPdfParsed): (rowNo: number) => UpdPdfParsed['items'] {
  const noNumbers = parsed.items.every((it) => it.rowNo == null);
  return (rowNo) =>
    noNumbers
      ? parsed.items.filter((_, i) => i + 1 === rowNo)
      : parsed.items.filter((it) => it.rowNo === rowNo);
}

/**
 * Сверка разбора с бумагой целиком: номер, дата, итоги, состав строк, у каждой
 * строки — наименование, единица, количество и деньги.
 *
 * Проверяется только размеченное: поле, которого в эталоне нет, — «не знаем».
 * А вот `null` в эталоне — утверждение «в бланке этого нет», и значение от
 * модели там — расхождение (см. ExpectedItem). Пустой результат — совпало.
 */
export function checkAgainstExpectation(
  parsed: UpdPdfParsed,
  expected: ExpectedDocument,
): ExpectationIssue[] {
  const out: ExpectationIssue[] = [];

  if (str(parsed.docNumber) !== str(expected.docNumber)) {
    out.push({
      where: 'номер',
      detail: `ожидался «${expected.docNumber}», получен «${parsed.docNumber ?? '∅'}»`,
    });
  }
  if ('docDate' in expected) {
    const want = expected.docDate ?? null;
    const got = parsed.docDate ? String(parsed.docDate).slice(0, 10) : null;
    if (want !== got) {
      out.push({ where: 'дата', detail: `ожидалась ${want ?? '∅'}, получена ${got ?? '∅'}` });
    }
  }
  for (const [field, label] of [
    ['totalSum', 'итог документа'],
    ['vatSum', 'НДС документа'],
  ] as const) {
    if (!(field in expected)) continue;
    const want = expected[field] ?? null;
    if (!sameMoney(want, parsed[field], SCALE.money)) {
      out.push({
        where: label,
        detail: `ожидалось ${num(want, SCALE.money)}, получено ${num(parsed[field], SCALE.money)}`,
      });
    }
  }

  if (expected.itemsComplete) {
    const want = expected.items?.length ?? 0;
    if (parsed.items.length !== want) {
      out.push({
        where: 'состав',
        detail: `строк в бумаге ${want}, в разборе ${parsed.items.length}`,
      });
    }
  }

  const rowsOf = rowsByNo(parsed);
  for (const want of expected.items ?? []) {
    const where = `строка ${want.rowNo}`;
    const rows = rowsOf(want.rowNo);
    if (rows.length === 0) {
      out.push({ where, detail: 'позиции с таким номером в разборе нет' });
      continue;
    }
    if (rows.length > 1) {
      out.push({ where, detail: `номер задвоен: ${rows.length} позиций` });
      continue;
    }
    const got = rows[0]!;
    if ('nameRaw' in want && normalizeItemName(want.nameRaw) !== normalizeItemName(got.nameRaw)) {
      out.push({
        where,
        detail: `наименование: ожидалось «${want.nameRaw}», получено «${got.nameRaw ?? '∅'}»`,
      });
    }
    if ('unit' in want && normalizeUnit(want.unit) !== normalizeUnit(got.unit)) {
      out.push({ where, detail: `единица: ожидалась «${want.unit}», получена «${got.unit ?? '∅'}»` });
    }
    for (const field of ['qty', 'price', 'sum', 'vatSum'] as const) {
      if (!(field in want)) continue;
      const scale = FIELD_SCALE[field];
      const wantValue = want[field] ?? null;
      const gotValue = got[field] ?? null;
      if (sameMoney(wantValue, gotValue, scale)) continue;
      out.push({
        where,
        detail:
          wantValue == null
            ? `${FIELD_LABEL[field]} в бумаге не напечатана, а модель вернула ${num(gotValue, scale)}`
            : `${FIELD_LABEL[field]}: ожидалось ${num(wantValue, scale)}, получено ${num(gotValue, scale)}` +
              // Воркер пишет пустое количество нулём (qty ?? '0'): в приёмке
              // будет не «нет данных», а ноль штук.
              (field === 'qty' && gotValue == null ? ' (в приёмку уйдёт 0)' : ''),
      });
    }
  }

  return out;
}

/**
 * Чего не хватает эталону, чтобы целевой гейт мог на него опереться.
 *
 * Гейт «новая версия совпала с бумагой» доказывает ровно то, что размечено:
 * неразмеченная дата или не заявленный полный состав строк молча выпадают из
 * проверки. Поэтому для целевого прогона эталон обязан быть полным, а проверка
 * стоит ДО вызовов модели — платить за прогон, который ничего не докажет, не
 * за чем.
 */
export function incompleteExpectation(expected: ExpectedDocument[] | undefined): string[] {
  if (!expected?.length) return ['нет expectedDocuments'];
  const out: string[] = [];
  for (const doc of expected) {
    const at = `№ ${doc.docNumber}`;
    if (!('docDate' in doc)) out.push(`${at}: не размечена дата (docDate)`);
    if (doc.itemsComplete !== true) out.push(`${at}: не заявлен полный состав строк (itemsComplete)`);
    if (!doc.items?.length) {
      out.push(`${at}: нет ни одной строки`);
      continue;
    }
    for (const item of doc.items) {
      const missing = (['nameRaw', 'unit', 'qty', 'price', 'sum', 'vatSum'] as const).filter(
        (f) => !(f in item),
      );
      if (missing.length > 0) {
        // Деньги перечислены намеренно: для бумаги без цен это явный null, а
        // не отсутствие поля, — иначе подставленная массой «сумма» не видна.
        out.push(`${at}, строка ${item.rowNo}: не размечено ${missing.join(', ')}`);
      }
    }
  }
  return out;
}

/** Что сделало бы правило ТОРГ-12 с разбором одного документа. */
export type Torg12Simulation = {
  /** Режим разбора, которым этот путь идёт в бою (по нему решает воркер). */
  parseMode: ParseMode;
  /** Строки, где правило РАССЧИТАЛО количество (графа 7 × графа 8). */
  computed: Array<{ row: number; qtyFrom: number | null; qtyTo: number }>;
  /** СОХРАНИТ ли воркер рассчитанное — то же условие, что в бою. */
  saved: boolean;
};

/**
 * Разбор глазами воркера при `TORG12_QTY=on`: что окажется в БД после правила.
 *
 * «Правило рассчитало 780» и «воркер сохранит 780» — разные утверждения:
 * воркер применяет пересчёт только в vision-режимах и только при первичном
 * разборе (torg12QtyAllowed). Безусловное применение здесь показало бы
 * результат лучше боевого, поэтому условие берётся тем же кодом.
 *
 * Контекст — первичная загрузка (поколение 0, не повтор): именно эту
 * популяцию меняет включение. `wantSecondPass` всегда false: второй проход
 * ставится только из режима `text`, а он правилу закрыт и без того.
 * Сегментов скрипт не гоняет, поэтому и `wantSegmentRepair` false.
 */
export function simulateTorg12Qty(
  parsed: UpdPdfParsed,
  parseMode: ParseMode,
): { parsed: UpdPdfParsed; simulation: Torg12Simulation } {
  const candidates = detectTorg12Qty(parsed);
  const saved =
    candidates.length > 0 &&
    torg12QtyAllowed({
      mode: 'on',
      parseMode,
      secondPassJob: false,
      segmentRepairJob: false,
      wantSecondPass: false,
      wantSegmentRepair: false,
      jobGeneration: 0,
    });
  return {
    parsed: saved ? applyTorg12Qty(parsed, candidates).parsed : parsed,
    simulation: {
      parseMode,
      computed: candidates.map((c) => ({ row: c.row, qtyFrom: c.qtyFrom, qtyTo: c.qtyTo })),
      saved,
    },
  };
}

/** Сверка одного документа с бумагой — для целевого гейта. */
export type AbsoluteCheck = {
  /** Расхождения новой версии. Пусто — совпала с бумагой. */
  fresh: ExpectationIssue[];
  /**
   * Те же расхождения у базы (первый прогон). Справочно: показывают, что
   * исправлено, а при совпадении с `fresh` — что обе ошиблись одинаково.
   */
  base: ExpectationIssue[];
  /** Итог документа у новой версии — дойдёт ли он до «распознано». */
  freshOutcome: OutcomeSnapshot;
};

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
  /**
   * Куда поехал ИТОГ документа — то, что боевой код сделает с этим разбором.
   * Сравнение направленное: улучшение не блокирует (см. compareOutcome).
   */
  outcomeShift: OutcomeShift;
  /**
   * Целевые строки: дефекты, которые новая версия обязана исправить.
   * Пусто — у документа целей не размечено (см. checkTargets).
   */
  targets: TargetVerdict[];
  /**
   * Сверка с бумагой целиком (целевой гейт). null — эталона у документа нет.
   * Необязательное: части отчётов, снятые до появления поля, сводятся как раньше.
   */
  absolute?: AbsoluteCheck | null;
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

/**
 * Итог документа глазами БОЕВОГО кода: что воркер сделает с этим разбором.
 *
 * Зачем отдельно от снимка. Поле `itemsCount` («Всего наименований» из бланка)
 * само по себе не критично — на бланке с одной строкой переход `∅ → 1` это
 * улучшение. Но именно оно решает судьбу документа: если заявленное число не
 * сходится с извлечённым, deriveUpdParseOutcome отправляет документ в
 * `partial_parse`, и на планшет он не попадёт вовсе. Сравнивать надо результат,
 * а не промежуточное поле.
 */
export type OutcomeSnapshot = {
  status: 'parsed' | 'needs_resolution';
  parseErrorCode: string | null;
  /** Причины partial_parse: docNumber / items / itemsIncomplete. */
  missing: string[];
};

export function outcomeOf(parsed: UpdPdfParsed): OutcomeSnapshot {
  const validation = validateUpdTotals(parsed);
  const outcome = deriveUpdParseOutcome(parsed, validation);
  const details = outcome.parseErrorDetails as { missing?: unknown } | null;
  const missing = Array.isArray(details?.missing)
    ? (details.missing as unknown[]).map(String)
    : [];
  return {
    status: outcome.status,
    parseErrorCode: outcome.parseErrorCode,
    missing: [...missing].sort(),
  };
}

/** Куда поехал итог документа: в худшую сторону, в лучшую или никуда. */
export type OutcomeShift = {
  from: string;
  to: string;
  /** true — активацию блокирует. Улучшения не блокируют никогда. */
  regressed: boolean;
  detail: string | null;
};

function outcomeLabel(o: OutcomeSnapshot): string {
  const code = o.parseErrorCode ?? 'без ошибки';
  return o.missing.length ? `${o.status}/${code} (${o.missing.join(', ')})` : `${o.status}/${code}`;
}

/**
 * НАПРАВЛЕННОЕ сравнение исхода.
 *
 * Обычное сравнение снимка симметрично: любое расхождение критического ключа
 * считается регрессией (см. compareUnit). Для исхода это неверно и вредно —
 * `needs_resolution → parsed` есть ровно та победа, ради которой версию и
 * выпускают, а симметричный гейт запретил бы её наравне с поломкой.
 *
 * Поэтому здесь перечислены направления, а не различия:
 *   * parsed → needs_resolution — блокер: документ перестал доезжать;
 *   * needs_resolution → parsed — улучшение, молчим;
 *   * без ошибки → validation_mismatch — регресс: суммы разъехались;
 *   * validation_mismatch → без ошибки — улучшение;
 *   * тот же статус, но ДОБАВИЛАСЬ причина в missing — блокер. Без разбора
 *     причин «нет номера» и «список неполон» выглядят одинаково, хотя это
 *     разные болезни и лечатся по-разному.
 */
export function compareOutcome(base: OutcomeSnapshot, fresh: OutcomeSnapshot): OutcomeShift {
  const from = outcomeLabel(base);
  const to = outcomeLabel(fresh);
  const same = { from, to, regressed: false, detail: null };

  if (base.status === 'parsed' && fresh.status === 'needs_resolution') {
    return { from, to, regressed: true, detail: 'документ перестал доезжать до планшета' };
  }
  if (base.status === 'needs_resolution' && fresh.status === 'parsed') {
    return same; // улучшение
  }

  if (base.status === 'parsed' && fresh.status === 'parsed') {
    if (base.parseErrorCode == null && fresh.parseErrorCode != null) {
      return { from, to, regressed: true, detail: `появилось «${fresh.parseErrorCode}»` };
    }
    return same;
  }

  // Оба в needs_resolution: смотрим, не добавилось ли причин.
  const was = new Set(base.missing);
  const added = fresh.missing.filter((m) => !was.has(m));
  if (added.length > 0) {
    return { from, to, regressed: true, detail: `добавилась причина: ${added.join(', ')}` };
  }
  return same;
}

/**
 * Вердикт по одной целевой строке: исправила ли новая версия то, ради чего
 * выпускалась.
 */
export type TargetVerdict = {
  /** «№ 223379, строка 3, цена» — чтобы отчёт читался без сверки с манифестом. */
  where: string;
  status: 'исправлено' | 'не исправлено' | 'не воспроизвелось' | 'нестабильно' | 'не размечено';
  detail: string;
};

const FIELD_LABEL = {
  qty: 'количество',
  price: 'цена',
  sum: 'сумма',
  vatSum: 'НДС',
} as const;

const FIELD_SCALE = {
  qty: SCALE.qty,
  price: SCALE.price,
  sum: SCALE.money,
  vatSum: SCALE.money,
} as const;

/** Значение поля у строки с данным номером. `found: false` — строки нет или их две. */
function rowValue(
  parsed: UpdPdfParsed,
  rowNo: number,
  field: 'qty' | 'price' | 'sum' | 'vatSum',
): { found: boolean; value: number | null } {
  const rows = parsed.items.filter((i) => i.rowNo === rowNo);
  if (rows.length !== 1) return { found: false, value: null };
  return { found: true, value: rows[0]![field] ?? null };
}

/**
 * Доказательство исправления: три условия, все обязательны.
 *
 *   1. дефект воспроизвели ОБА прогона базы (A1 и A2) — иначе доказывать нечего;
 *   2. A1 и A2 дали одно и то же — иначе дефект плавающий, и совпадение новой
 *      версии с эталоном может быть той же случайностью;
 *   3. новая версия вернула ровно эталон.
 *
 * Второй пункт важнее, чем кажется. Без него достаточно было бы одного удачного
 * прогона, чтобы объявить дефект вылеченным, — а на сканах модель ошибается
 * через раз, и «зелёный» отчёт означал бы только везение.
 */
export function checkTargets(args: {
  a1: UpdPdfParsed;
  a2: UpdPdfParsed;
  b: UpdPdfParsed;
  expected: ExpectedDocument | undefined;
}): TargetVerdict[] {
  const expected = args.expected;
  if (!expected) return [];
  const out: TargetVerdict[] = [];

  for (const want of expected.items ?? []) {
    for (const field of want.mustFix ?? []) {
      const where = `№ ${expected.docNumber}, строка ${want.rowNo}, ${FIELD_LABEL[field]}`;
      const scale = FIELD_SCALE[field];

      if (!(field in want)) {
        out.push({
          where,
          status: 'не размечено',
          detail: `поле помечено как целевое, но эталонного значения нет — сверять не с чем`,
        });
        continue;
      }
      const target = want[field] ?? null;

      const r1 = rowValue(args.a1, want.rowNo, field);
      const r2 = rowValue(args.a2, want.rowNo, field);
      const rb = rowValue(args.b, want.rowNo, field);

      // Нестабильность базы проверяется ПЕРВОЙ: она обесценивает и «дефект
      // воспроизведён», и «дефект исправлен».
      if (r1.found !== r2.found || !sameMoney(r1.value, r2.value, scale)) {
        out.push({
          where,
          status: 'нестабильно',
          detail:
            `база дала разное в двух прогонах: ${num(r1.value, scale)} и ${num(r2.value, scale)} — ` +
            `дефект плавающий, доказательством служить не может`,
        });
        continue;
      }

      const baseMatches = r1.found && sameMoney(target, r1.value, scale);
      if (baseMatches) {
        out.push({
          where,
          status: 'не воспроизвелось',
          detail: `база прочитала верно (${num(target, scale)}) — дефекта здесь нет, разметка целей устарела`,
        });
        continue;
      }

      if (rb.found && sameMoney(target, rb.value, scale)) {
        out.push({
          where,
          status: 'исправлено',
          detail: `база давала ${num(r1.value, scale)}, новая версия — ${num(target, scale)}`,
        });
        continue;
      }

      out.push({
        where,
        status: 'не исправлено',
        detail: rb.found
          ? `ожидалось ${num(target, scale)}, получено ${num(rb.value, scale)} (у базы ${num(r1.value, scale)})`
          : `строки с номером ${want.rowNo} в разборе новой версии нет`,
      });
    }
  }

  return out;
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
    // База берётся по ПЕРВОМУ прогону: второй нужен для проверки стабильности,
    // а исходное состояние документа одно.
    outcomeShift: compareOutcome(outcomeOf(args.a1), outcomeOf(args.b)),
    targets: checkTargets({ a1: args.a1, a2: args.a2, b: args.b, expected: args.expected }),
    absolute: args.expected
      ? {
          fresh: checkAgainstExpectation(args.b, args.expected),
          base: checkAgainstExpectation(args.a1, args.expected),
          freshOutcome: outcomeOf(args.b),
        }
      : null,
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

  // Нестабильность базы блокирует, только если она МАССОВАЯ.
  //
  // Единичный шумный документ не должен запрещать выкат: на боевом прогоне
  // v13 дважды прочитала маркировку кабеля с разницей в один символ
  // («FRHF 2х0.75» против «FRHF х2х0.75»), и один этот документ заблокировал
  // версию, у которой регрессов не было вовсе. Такие расхождения у модели
  // будут всегда, а поля, разошедшиеся в A/A, из сравнения и так исключаются
  // (см. фильтр в compareUnit) — то есть по этому документу мы просто не
  // судим. А вот когда база не воспроизводит себя на трети документов,
  // сравнивать действительно нечего: это уже не шум, а отсутствие опоры.
  const unstableCritical = input.comparisons.filter((c) => c.unstableCritical.length > 0);
  if (unstableCritical.length > 0 && unstableCritical.length * 3 > input.checkedUnits) {
    blockers.push(
      `база не воспроизводит сама себя: нестабильные критические поля у ` +
        `${unstableCritical.length} из ${input.checkedUnits} документов`,
    );
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

  // Дозаполнение регулярками блокирует, только если оно НОВОЕ.
  //
  // Раньше условие сравнения с базой не делало вовсе: отчёт печатал такому
  // документу честное «было и в базе», а гейт всё равно запрещал выкат. То
  // есть версия наказывалась за состояние, которое существует и на активном
  // промпте прямо сейчас, — а значит не прошла бы ни одна.
  const fromText = input.comparisons.filter(
    (c) =>
      c.expectation.status === 'filled_from_text' &&
      c.baseExpectation.status !== 'filled_from_text',
  );
  if (fromText.length > 0) {
    blockers.push(`грузополучатель от регулярок, а не от модели (НОВОЕ): ${fromText.length}`);
  }

  const noExpectation = input.comparisons.filter((c) => c.expectation.status === 'no_expectation');
  if (noExpectation.length === input.comparisons.length && input.comparisons.length > 0) {
    blockers.push('ни у одного документа нет эталона в манифесте (сверять не с чем)');
  }

  // Итог документа — направленно: блокирует только ухудшение.
  //
  // В снимке этого не выразить: сравнение снимка симметрично, и переход
  // partial_parse → parsed запретил бы активацию наравне с поломкой. А не
  // проверять итог нельзя: неверный itemsCount отправляет документ в
  // partial_parse, то есть на планшет он не попадёт вовсе, — при том что сам
  // itemsCount критическим полем не считается и считаться не должен.
  const outcomeRegressed = input.comparisons.filter((c) => c.outcomeShift.regressed);
  if (outcomeRegressed.length > 0) {
    blockers.push(`итог документа ухудшился: ${outcomeRegressed.length}`);
  }

  // Позитивный критерий: версия обязана исправить то, ради чего выпускалась.
  //
  // Без него гейт умел только запрещать, и версия, дословно повторившая
  // поведение базы, проходила зелёной — то есть проверка не отличала
  // исправление от бездействия.
  const targets = input.comparisons.flatMap((c) => c.targets);
  if (targets.length > 0) {
    const notFixed = targets.filter((t) => t.status === 'не исправлено');
    if (notFixed.length > 0) {
      blockers.push(`целевой дефект НЕ исправлен: ${notFixed.length} стр.`);
    }
    // Три следующих случая — не «плохо», а «доказательства нет». Пропускать их
    // молча нельзя: отчёт выглядел бы подтверждением, ничего не подтвердив.
    const notReproduced = targets.filter((t) => t.status === 'не воспроизвелось');
    if (notReproduced.length > 0) {
      blockers.push(
        `целевой дефект не воспроизвёлся у базы: ${notReproduced.length} стр. — разметка целей устарела`,
      );
    }
    const unstable = targets.filter((t) => t.status === 'нестабильно');
    if (unstable.length > 0) {
      blockers.push(`целевая строка нестабильна в A/A: ${unstable.length} стр.`);
    }
    const unmarked = targets.filter((t) => t.status === 'не размечено');
    if (unmarked.length > 0) {
      blockers.push(`целевое поле без эталонного значения: ${unmarked.length} стр.`);
    }
  }

  return blockers;
}

/** Вид гейта прогона: против базы (анти-регресс) или против бумаги (исправление). */
export type GateKind = 'regression' | 'expectation';

/**
 * Целевой гейт: новая версия обязана совпасть с бумагой на КАЖДОМ документе.
 *
 * Отличия от базы здесь не блокируют — на корпусе, собранном ради дефекта,
 * они и есть исправление (см. раздел «Целевой гейт»). Зато блокирует то, что
 * обычный гейт пропускает: обе версии ошиблись одинаково, документ остался
 * «частично», грузополучатель не тот. Анти-регресс по остальному потоку этот
 * гейт НЕ доказывает: для него отдельный прогон с `--gate regression`.
 */
export function evaluateExpectationGate(input: GateInput): string[] {
  const blockers: string[] = [];

  if (input.checkedUnits === 0) blockers.push('нет разобранных документов');
  if (input.failures.length > 0) blockers.push(`не разобрались файлы: ${input.failures.length}`);

  // Документ без эталона в целевом прогоне — дыра в доказательстве, а не
  // «нечего проверять»: скрипт отсекает такие записи до вызовов модели, и
  // сюда они попадают только если логический документ не сопоставился.
  const unmatched = input.comparisons.filter((c) => !c.absolute);
  if (unmatched.length > 0) {
    blockers.push(`документ не сопоставлен с эталоном: ${unmatched.length}`);
  }

  const wrong = input.comparisons.filter((c) => (c.absolute?.fresh.length ?? 0) > 0);
  if (wrong.length > 0) {
    const fields = wrong.reduce((n, c) => n + c.absolute!.fresh.length, 0);
    blockers.push(`новая версия расходится с бумагой: ${wrong.length} док. / ${fields} полей`);
  }

  // Совпавший с бумагой разбор, который воркер всё равно оставит «частично»,
  // менеджеру ничего не даёт: судьбу документа решает deriveUpdParseOutcome.
  const notParsed = input.comparisons.filter(
    (c) => c.absolute && c.absolute.freshOutcome.status !== 'parsed',
  );
  if (notParsed.length > 0) {
    blockers.push(`документ не получит статус «распознано»: ${notParsed.length}`);
  }

  const consignee = input.comparisons.filter(
    (c) => c.expectation.status === 'mismatch' || c.expectation.status === 'filled_from_text',
  );
  if (consignee.length > 0) {
    blockers.push(`грузополучатель не совпал с бумагой: ${consignee.length}`);
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
  // Сводка по целевым строкам. Обязательна по той же причине, что и хеши
  // промптов: без неё нельзя проверить, что часть вообще проверяла цели.
  // Часть, снятая до появления критерия, отвергается, а не сводится молча.
  'targets.total',
  'targets.fixed',
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

/** Сводка по целевым строкам всего прогона. */
export type TargetSummary = {
  total: number;
  fixed: number;
  notFixed: number;
  notReproduced: number;
  unstable: number;
  unmarked: number;
  /** Поимённо — чтобы отчёт читался без сверки с манифестом. */
  rows: TargetVerdict[];
};

export function summarizeTargets(comparisons: readonly UnitComparison[]): TargetSummary {
  const rows = comparisons.flatMap((c) => c.targets);
  const count = (status: TargetVerdict['status']): number =>
    rows.filter((t) => t.status === status).length;
  return {
    total: rows.length,
    fixed: count('исправлено'),
    notFixed: count('не исправлено'),
    notReproduced: count('не воспроизвелось'),
    unstable: count('нестабильно'),
    unmarked: count('не размечено'),
    rows,
  };
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
  /**
   * Как считался вердикт. Необязательное: отчёты, снятые до появления поля,
   * — это анти-регресс без правила ТОРГ-12.
   */
  mode?: { gate?: GateKind; torg12Qty?: boolean };
};

/** Режим сверки строкой: части с разным режимом сводить нельзя. */
function modeLabel(mode: AbReportIdentity['mode']): string {
  const gate = mode?.gate ?? 'regression';
  return `${gate}${mode?.torg12Qty ? ' + правило ТОРГ-12' : ''}`;
}

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
    // Часть, где количество пересчитано правилом, и часть без него сравнивают
    // разные разборы — свод таких частей смешал бы два вопроса.
    'режим сверки': modeLabel(r.mode),
  };
}

/**
 * Можно ли вообще начинать прогон: известен ли код, на котором он снят.
 *
 * Возвращает причину отказа или null. Отдельной функцией — чтобы правило было
 * покрыто тестом: молчаливое согласие здесь и создало дыру, из-за которой части
 * с разных деплоев сводились как одинаковые.
 */
export function revisionBlocker(rev: { sha: string | null }): string | null {
  if (rev.sha) return null;
  return (
    'Отпечаток кода неизвестен: нет ни рабочей копии git, ни файла BUILD_SHA в образе.\n' +
    'Отчёт без отпечатка нельзя свести с другими частями — прогон остановлен.\n' +
    'Пересоберите образ: сборка кладёт BUILD_SHA сама (см. apps/api/Dockerfile).'
  );
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
  const diffs = Object.keys(left)
    .filter((k) => left[k] !== right[k])
    .map((k) => `${k}: «${left[k]}» против «${right[k]}»`);
  // «Неизвестен» не равен «неизвестну».
  //
  // Сравнение строк здесь молчало на самом опасном случае: в прод-образе нет
  // `.git`, отпечаток кода был null у ВСЕХ частей, и они признавались снятыми
  // на одном коде — хотя между ними мог лежать любой деплой. Отсутствие
  // отпечатка — это не совпадение, а невозможность сравнить.
  if (a.git.sha == null || b.git.sha == null) {
    diffs.push(
      'код (git): отпечаток неизвестен хотя бы у одной части — свести нельзя. ' +
        'Пересоберите образ (BUILD_SHA кладёт сборка) и снимите части заново.',
    );
  }
  return diffs;
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
