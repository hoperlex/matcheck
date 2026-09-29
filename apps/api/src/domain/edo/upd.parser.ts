/**
 * Разбор XML УПД формата ФНС (титул продавца).
 *
 * Имена полей менялись от версии к версии, и каждый раз это стоило молчаливой
 * потери данных:
 *
 *   - первая редакция читала `Документ/@НомерДок` и плоские `@ИННЮЛ`, а в
 *     формате 5.01 номер лежит в `СвСчФакт/@НомерСчФ`, стороны — через
 *     `ИдСв → СвЮЛУч | СвИП`;
 *   - формат 5.03 (приказ ЕД-7-26/970@) переименовал номер и дату в
 *     `СвСчФакт/@НомерДок` / `@ДатаДок`, исправление — в `ИспрДок`, код валюты
 *     перенёс в `ДенИзм`, наименование единицы — прямо в `СведТов`. Пробный
 *     разбор 25.09.2026 на боевом ящике не прочитал номер ни у одного из трёх
 *     документов именно поэтому.
 *
 * Поэтому каждое поле читается ЦЕПОЧКОЙ имён: актуальное по 5.03, затем 5.01,
 * затем прежнее. Совместимость не из осторожности — ручной маршрут `/upload-upd`
 * живой, и старые файлы должны читаться как раньше.
 *
 * Суммы отдаются в базе портала — С НДС: `sum` позиции и `totalSum` документа.
 * Так хранит их весь остальной портал (карточки из сканов, сверка итогов), и
 * XML не должен быть исключением. Суммы без НДС лежат рядом отдельными полями.
 *
 * Отдельно от разбора стоит ОЦЕНКА ПОЛНОТЫ (`assessUpdParse`). Разбор, который
 * «не упал», ещё ничего не значит: файл незнакомой версии легко даёт документ
 * без номера или строки с нулевыми суммами. Такой результат не должен
 * превращаться в карточку — он должен быть виден как отказ с причиной.
 */
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  allowBooleanAttributes: true,
  removeNSPrefix: false,
});

type Node = Record<string, unknown>;

function num(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  // Ставка НДС приходит и числом, и строкой «20%», и «без НДС».
  const raw = String(v).replace('%', '').replace(',', '.').trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function pickOne<T>(v: T | T[] | undefined): T | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

function asList(v: unknown): Node[] {
  if (v === undefined || v === null) return [];
  const list = Array.isArray(v) ? v : [v];
  return list.filter((x): x is Node => Boolean(x) && typeof x === 'object');
}

function asNode(v: unknown): Node | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Node) : undefined;
}

/** Первое непустое значение среди перечисленных ключей узла. */
function attr(node: Node | undefined, ...keys: string[]): string | undefined {
  if (!node) return undefined;
  for (const key of keys) {
    const value = node[key];
    if (value !== undefined && value !== null && typeof value !== 'object' && String(value) !== '') {
      return String(value);
    }
  }
  return undefined;
}

/** Текст элемента: `<СумНал>32000</СумНал>` приходит строкой либо узлом с `#text`. */
function text(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object') return String(v) || undefined;
  return attr(asNode(v), '#text');
}

const PartySchema = z.object({
  inn: z.string(),
  kpp: z.string().nullable(),
  name: z.string(),
});
export type UpdParty = z.infer<typeof PartySchema>;

/**
 * Грузоотправитель и грузополучатель.
 *
 * ИНН у них не обязателен (физическое лицо, иностранная организация), а
 * главное в них для портала — адрес: по нему видно, на какой объект шёл груз.
 */
const ShipPartySchema = z.object({
  inn: z.string().nullable(),
  kpp: z.string().nullable(),
  name: z.string().nullable(),
  address: z.string().nullable(),
});
export type UpdShipParty = z.infer<typeof ShipPartySchema>;

/** Ссылка на документ: основание передачи, документ об отгрузке. */
const DocRefSchema = z.object({
  name: z.string().nullable(),
  number: z.string().nullable(),
  date: z.string().nullable(),
});
export type UpdDocRef = z.infer<typeof DocRefSchema>;

/**
 * Признак предмета позиции (`ДопСведТов/@ПрТовРаб`): 1 — имущество, 2 — работа,
 * 3 — услуга, 4 — имущественные права, 5 — иное. `null` — не заполнен.
 */
export const ITEM_KINDS = [1, 2, 3, 4, 5] as const;
export type UpdItemKind = (typeof ITEM_KINDS)[number];

const ItemSchema = z.object({
  nameRaw: z.string(),
  qty: z.number(),
  unit: z.string(),
  /** Код единицы по ОКЕИ («796»): наименование бывает пустым, код — почти всегда. */
  unitCode: z.string().nullable(),
  /** Цена за единицу БЕЗ НДС — так её печатает формат (графа 4). */
  price: z.number().nullable(),
  /** Стоимость строки С НДС — база портала. */
  sum: z.number().nullable(),
  /** Стоимость строки без НДС (графа 5). */
  sumExVat: z.number().nullable(),
  vatRate: z.number().nullable(),
  vatSum: z.number().nullable(),
  lineNo: z.number(),
  kind: z.number().int().min(1).max(5).nullable(),
  productCode: z.string().nullable(),
});
export type UpdItem = z.infer<typeof ItemSchema>;

export const UpdParsedSchema = z.object({
  docNumber: z.string(),
  docDate: z.string(),
  /** Исправление: номер и дата. Исправленный УПД — не новый документ. */
  correction: z.object({ number: z.string().nullable(), date: z.string().nullable() }).nullable(),
  /** Итог С НДС — база портала. */
  totalSum: z.number().nullable(),
  totalExVat: z.number().nullable(),
  vatSum: z.number().nullable(),
  /** Первый продавец — для совместимости со всеми, кто читает одну сторону. */
  supplier: PartySchema,
  /** Все продавцы: формат допускает несколько, и сопоставлять надо с каждым. */
  suppliers: z.array(PartySchema),
  /** Первый покупатель. */
  recipient: PartySchema.nullable(),
  buyers: z.array(PartySchema),
  /** Грузоотправитель — «он же» (продавец) либо отдельная сторона. */
  consignorSameAsSeller: z.boolean(),
  consignor: ShipPartySchema.nullable(),
  consignee: ShipPartySchema.nullable(),
  /** Сведения о передаче: дата отгрузки, содержание операции, основания. */
  transfer: z
    .object({
      date: z.string().nullable(),
      operation: z.string().nullable(),
      basis: z.array(DocRefSchema),
    })
    .nullable(),
  /** Документы об отгрузке (ТН, ТТН), если продавец их указал. */
  shippingDocs: z.array(DocRefSchema),
  items: z.array(ItemSchema),
  fileId: z.string().nullable(),
  formatVersion: z.string().nullable(),
  /** СЧФ, СЧФДОП или ДОП — из самого документа, а не из метаданных. */
  function: z.string().nullable(),
  knd: z.string().nullable(),
  currencyCode: z.string().nullable(),
});
export type UpdParsed = z.infer<typeof UpdParsedSchema>;

/** Узел идентификации стороны: `ИдСв` в 5.01/5.03, `СвУчастЭДО` у прежних файлов. */
function idNodes(node: Node) {
  const idSv = asNode(node['ИдСв']) ?? asNode(node['СвУчастЭДО']);
  const legal = asNode(idSv?.['СвЮЛУч']) ?? asNode(node['СвЮЛУч']);
  const entrepreneur = asNode(idSv?.['СвИП']) ?? asNode(node['СвИП']);
  const foreign = asNode(idSv?.['СвИнНеУч']);
  return { idSv, legal, entrepreneur, foreign };
}

function fioOf(entrepreneur: Node | undefined): string | undefined {
  const fio = asNode(entrepreneur?.['ФИО']);
  if (!fio) return undefined;
  const name = [attr(fio, '@_Фамилия'), attr(fio, '@_Имя'), attr(fio, '@_Отчество')]
    .filter(Boolean)
    .join(' ');
  return name || undefined;
}

/**
 * Реквизиты стороны.
 *
 * В формате они лежат на два-три уровня глубже, чем кажется:
 * `СвПрод → ИдСв → СвЮЛУч (@ИННЮЛ, @КПП, @НаимОрг)`, а у предпринимателя —
 * `СвИП (@ИННФЛ)` с именем в `ФИО`. Плоские атрибуты поддержаны ради
 * совместимости с прежними файлами.
 */
function partyFromOrg(org: unknown): UpdParty | null {
  const node = asNode(org);
  if (!node) return null;
  const { idSv, legal, entrepreneur } = idNodes(node);

  const inn =
    attr(legal, '@_ИННЮЛ') ??
    attr(entrepreneur, '@_ИННФЛ') ??
    attr(idSv, '@_ИННЮЛ', '@_ИННФЛ') ??
    attr(node, '@_ИННЮЛ', '@_ИННФЛ');
  if (!inn) return null;

  const kpp = attr(legal, '@_КПП') ?? attr(idSv, '@_КПП') ?? attr(node, '@_КПП') ?? null;
  // У предпринимателя наименования нет — собираем из ФИО.
  const name =
    attr(legal, '@_НаимОрг') ??
    attr(node, '@_НаимОрг') ??
    attr(idSv, '@_НаимОрг') ??
    fioOf(entrepreneur) ??
    '';

  return { inn, kpp, name };
}

/** Порядок частей адреса в `АдрРФ` (5.01): так его пишут на конверте. */
const ADR_RF_PARTS = ['@_Индекс', '@_Район', '@_Город', '@_НаселПункт', '@_Улица', '@_Дом', '@_Корпус', '@_Кварт'];

/**
 * Адрес одной строкой.
 *
 * Три формы: текстом (`АдрИнф/@АдрТекст`), по частям (`АдрРФ`, 5.01) и по
 * адресному реестру (`АдрГАР`, 5.03, вложенные элементы с `@Наим`/`@Номер`).
 * Точная структура нужна не здесь: адрес — подсказка, на какой объект шёл
 * груз, и читает его человек.
 */
function addressText(owner: Node | undefined): string | null {
  const address = asNode(owner?.['Адрес']);
  if (!address) return null;

  const info = asNode(address['АдрИнф']);
  const infoText = attr(info, '@_АдрТекст');
  if (infoText) return infoText;

  const rf = asNode(address['АдрРФ']);
  if (rf) {
    const parts = ADR_RF_PARTS.map((k) => attr(rf, k)).filter(Boolean);
    if (parts.length > 0) return parts.join(', ');
  }

  const gar = asNode(address['АдрГАР']);
  if (gar) {
    const parts: string[] = [];
    const index = attr(gar, '@_Индекс');
    if (index) parts.push(index);
    for (const [key, value] of Object.entries(gar)) {
      if (key.startsWith('@_') || key === '#text') continue;
      for (const child of Array.isArray(value) ? value : [value]) {
        const childNode = asNode(child);
        const part = childNode
          ? [attr(childNode, '@_Тип'), attr(childNode, '@_Наим', '@_Номер')].filter(Boolean).join(' ')
          : text(child);
        if (part) parts.push(part);
      }
    }
    if (parts.length > 0) return parts.join(', ');
  }

  return attr(address, '@_КодГАР') ?? text(address['КодГАР']) ?? null;
}

function shipPartyFrom(node: Node | undefined): UpdShipParty | null {
  if (!node) return null;
  const { idSv, legal, entrepreneur, foreign } = idNodes(node);
  const inn =
    attr(legal, '@_ИННЮЛ') ?? attr(entrepreneur, '@_ИННФЛ') ?? attr(idSv, '@_ИННЮЛ', '@_ИННФЛ') ?? null;
  const party = {
    inn,
    kpp: attr(legal, '@_КПП') ?? null,
    name:
      attr(legal, '@_НаимОрг') ?? fioOf(entrepreneur) ?? attr(foreign, '@_НаимОрг') ?? attr(node, '@_НаимОрг') ?? null,
    address: addressText(node),
  };
  return party.inn || party.name || party.address ? party : null;
}

/** Дата документа приходит как ДД.ММ.ГГГГ; наружу отдаём ISO. */
function normalizeDate(raw: string | undefined): string {
  if (!raw) return '';
  if (raw.length === 10 && raw.includes('.')) {
    return `${raw.slice(6, 10)}-${raw.slice(3, 5)}-${raw.slice(0, 2)}`;
  }
  return raw;
}

function dateOrNull(raw: string | undefined): string | null {
  return normalizeDate(raw) || null;
}

/**
 * Ссылка на документ: 5.03 пишет `РеквНаимДок/РеквНомерДок/РеквДатаДок`,
 * 5.01 — свои имена для каждого узла, их передаёт вызывающий.
 */
function docRef(node: Node, legacy: [string, string, string]): UpdDocRef | null {
  const ref = {
    name: attr(node, '@_РеквНаимДок', legacy[0]) ?? null,
    number: attr(node, '@_РеквНомерДок', legacy[1]) ?? null,
    date: dateOrNull(attr(node, '@_РеквДатаДок', legacy[2])),
  };
  return ref.name || ref.number || ref.date ? ref : null;
}

/**
 * Сумма налога по строке.
 *
 * Три формы в одном формате: вложенный `СумНал/СумНал`, вложенный
 * `СумНал/БезНДС` (освобождение) и плоский атрибут прежних файлов.
 */
function vatSumOf(item: Node | undefined, nestedKey = 'СумНал', flatKeys = ['@_СумНал', '@_СтоимНалог']): number | null {
  const nested = asNode(item?.[nestedKey]);
  if (nested) {
    const value = num(text(nested['СумНал']) ?? attr(nested, '@_СумНал'));
    if (value !== null) return value;
    // «БезНДС» — это ноль налога, а не отсутствие данных.
    if (nested['БезНДС'] !== undefined) return 0;
  }
  return num(attr(item, ...flatKeys));
}

/**
 * Стоимость С НДС: из документа, иначе «без НДС плюс налог», иначе без НДС.
 *
 * Второй и третий шаги — для прежних файлов, где графы 9 нет: без налога
 * такая сумма совпадает с базой портала, с налогом — досчитывается.
 */
function withVat(explicit: number | null, exVat: number | null, vat: number | null): number | null {
  if (explicit !== null) return explicit;
  if (exVat !== null && vat !== null) return round2(exVat + vat);
  return exVat;
}

function itemKind(raw: string | undefined): UpdItemKind | null {
  const n = Number(raw);
  return (ITEM_KINDS as readonly number[]).includes(n) ? (n as UpdItemKind) : null;
}

export function parseUpdXml(xml: string): UpdParsed {
  const parsed = parser.parse(xml) as Node;
  const root = asNode(parsed['Файл']);
  if (!root) throw new Error('UPD: missing root <Файл>');

  const document = pickOne(root['Документ'] as Node | Node[] | undefined);
  if (!document) throw new Error('UPD: missing <Документ>');

  const svSchFakt = asNode(document['СвСчФакт']);

  // Номер и дата: 5.03, затем 5.01, затем прежние имена в корне документа.
  const docNumber =
    attr(svSchFakt, '@_НомерДок', '@_НомерСчФ') ?? attr(document, '@_НомерДок') ?? '';
  const docDate = normalizeDate(
    attr(svSchFakt, '@_ДатаДок', '@_ДатаСчФ') ?? attr(document, '@_ДатаДок') ?? undefined,
  );

  const fix5_03 = asNode(svSchFakt?.['ИспрДок']);
  const fix5_01 = asNode(svSchFakt?.['ИспрСчФ']);
  const correctionNumber =
    attr(fix5_03, '@_НомИспр') ?? attr(fix5_01, '@_НомИспрСчФ', '@_НомИспр') ?? null;
  const correctionDate = dateOrNull(
    attr(fix5_03, '@_ДатаИспр') ?? attr(fix5_01, '@_ДатаИспрСчФ', '@_ДатаИспр'),
  );
  const correction =
    correctionNumber || correctionDate ? { number: correctionNumber, date: correctionDate } : null;

  const suppliers = asList(svSchFakt?.['СвПрод'])
    .map(partyFromOrg)
    .filter((p): p is UpdParty => p !== null);
  const buyers = asList(svSchFakt?.['СвПокуп'])
    .map(partyFromOrg)
    .filter((p): p is UpdParty => p !== null);
  const supplier = suppliers[0];
  if (!supplier) throw new Error('UPD: missing supplier (СвПрод)');

  const consignorNode = asNode(svSchFakt?.['ГрузОт']);
  const consignorSameAsSeller = consignorNode?.['ОнЖе'] !== undefined;
  const consignor = shipPartyFrom(asNode(consignorNode?.['ГрузОтпр']));
  const consignee = shipPartyFrom(pickOne(asList(svSchFakt?.['ГрузПолуч'])));

  // Сведения о передаче: в документе — `СвПродПер/СвПер`.
  const svPer = asNode(asNode(document['СвПродПер'])?.['СвПер']);
  const transfer = svPer
    ? {
        date: dateOrNull(attr(svPer, '@_ДатаПер')),
        operation: attr(svPer, '@_СодОпер') ?? null,
        basis: asList(svPer['ОснПер'])
          .map((n) => docRef(n, ['@_НаимОсн', '@_НомОсн', '@_ДатаОсн']))
          .filter((r): r is UpdDocRef => r !== null),
      }
    : null;

  // Документ об отгрузке: 5.03 — `ДокПодтвОтгрНом`, 5.01 — `ДокПодтвОтгр`.
  const shippingDocs = [
    ...asList(svSchFakt?.['ДокПодтвОтгрНом']),
    ...asList(svSchFakt?.['ДокПодтвОтгр']),
    ...asList(svPer?.['ДокПодтвОтгрНом']),
  ]
    .map((n) => docRef(n, ['@_НаимДокОтгр', '@_НомДокОтгр', '@_ДатаДокОтгр']))
    .filter((r): r is UpdDocRef => r !== null);

  const tableSection = asNode(svSchFakt?.['ТаблСчФакт']) ?? asNode(document['ТаблСчФакт']);

  const items = asList(tableSection?.['СведТов']).map((item, idx) => {
    const extra = asNode(item['ДопСведТов']);
    const exVat = num(attr(item, '@_СтТовБезНДС', '@_СтоимТовБезНДС'));
    const vatSum = vatSumOf(item);
    return {
      nameRaw: attr(item, '@_НаимТов') ?? '',
      qty: num(attr(item, '@_КолТов')) ?? 0,
      // ОКЕИ_Тов — это КОД единицы («796»), а наименование лежит в НаимЕдИзм:
      // в 5.03 — у самой позиции, в 5.01 — в ДопСведТов. Человеку в карточке
      // нужен «шт», поэтому наименование приоритетнее.
      unit: attr(item, '@_НаимЕдИзм') ?? attr(extra, '@_НаимЕдИзм') ?? attr(item, '@_ОКЕИ_Тов') ?? 'шт',
      unitCode: attr(item, '@_ОКЕИ_Тов') ?? null,
      price: num(attr(item, '@_ЦенаТов')),
      sum: withVat(num(attr(item, '@_СтТовУчНал', '@_СтоимТовУчНал')), exVat, vatSum),
      sumExVat: exVat,
      vatRate: num(attr(item, '@_НалСт')),
      vatSum,
      lineNo: Number(attr(item, '@_НомСтр') ?? idx + 1),
      kind: itemKind(attr(extra, '@_ПрТовРаб')),
      productCode: attr(extra, '@_КодТов') ?? null,
    };
  });

  const totals = asNode(tableSection?.['ВсегоОпл']);
  const totalExVat = num(attr(totals, '@_СтТовБезНДСВсего', '@_СтоимТовБезНДСВсего'));
  const totalVat = vatSumOf(totals, 'СумНалВсего', ['@_СумНалВсего']);
  const totalSum = withVat(
    num(attr(totals, '@_СтТовУчНалВсего', '@_СтоимТовУчНалВсего')),
    totalExVat,
    totalVat,
  );

  return UpdParsedSchema.parse({
    docNumber,
    docDate,
    correction,
    totalSum,
    totalExVat,
    vatSum: totalVat,
    supplier,
    suppliers,
    recipient: buyers[0] ?? null,
    buyers,
    consignorSameAsSeller,
    consignor,
    consignee,
    transfer,
    shippingDocs,
    items,
    fileId: attr(root, '@_ИдФайл') ?? null,
    formatVersion: attr(root, '@_ВерсФорм') ?? null,
    function: attr(document, '@_Функция') ?? null,
    knd: attr(document, '@_КНД') ?? null,
    currencyCode:
      attr(asNode(svSchFakt?.['ДенИзм']), '@_КодОКВ') ?? attr(svSchFakt, '@_КодОКВ') ?? null,
  });
}

/**
 * Строение XML: какие пути и атрибуты в документе вообще есть.
 *
 * Для диагностики, а не для разбора: когда поле не читается, первым делом
 * нужно увидеть, как оно названо в НАСТОЯЩЕМ файле. Пути объединяются по
 * всем строкам и узлам без индексов — сто позиций дают те же пути, что одна.
 */
export function xmlOutline(xml: string, limit = 300): string[] {
  const out = new Set<string>();
  const walk = (value: unknown, path: string) => {
    if (out.size >= limit) return;
    if (Array.isArray(value)) {
      for (const v of value) walk(v, path);
      return;
    }
    const node = asNode(value);
    if (!node) {
      if (path) out.add(path);
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (out.size >= limit) return;
      if (key.startsWith('@_')) out.add(`${path}/@${key.slice(2)}`);
      else if (key === '#text') out.add(path);
      else if (!key.startsWith('?')) walk(child, path ? `${path}/${key}` : key);
    }
  };
  walk(parser.parse(xml), '');
  return [...out];
}

/**
 * Годен ли разбор для создания карточки.
 *
 * Отдельно от `parseUpdXml`, потому что «не бросил исключение» и «прочитал
 * документ» — разные вещи. Файл незнакомой версии разбирается без ошибок и даёт
 * документ без номера либо строки с нулевыми суммами: молча превратить такое в
 * карточку значит наполнить портал неверными данными, а это хуже, чем их
 * отсутствие. Поэтому решение явное, а причины — человекочитаемые.
 */
export type UpdParseAssessment = { ok: true } | { ok: false; reasons: string[] };

export function assessUpdParse(parsed: UpdParsed): UpdParseAssessment {
  const reasons: string[] = [];

  if (!parsed.docNumber.trim()) reasons.push('не прочитан номер документа');
  if (!parsed.docDate.trim()) reasons.push('не прочитана дата документа');
  if (!parsed.supplier.inn.trim()) reasons.push('не прочитан ИНН поставщика');
  if (parsed.items.length === 0) reasons.push('не прочитана ни одна позиция');

  // Строка без количества и без суммы — признак того, что читались не те имена
  // полей: по такому документу нечего принимать.
  const emptyRows = parsed.items.filter((i) => !i.qty && i.sum === null).length;
  if (parsed.items.length > 0 && emptyRows === parsed.items.length) {
    reasons.push('во всех позициях пусты и количество, и сумма');
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
