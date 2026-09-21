/**
 * Разбор XML УПД формата ФНС (титул продавца).
 *
 * Что изменилось и почему. Первая редакция читала `Документ/@НомерДок`,
 * `@СтоимТовБезНДС` и плоские `@ИННЮЛ`. В формате УПД таких имён нет: номер и
 * дата лежат в `СвСчФакт` (`НомерСчФ` / `ДатаСчФ`), суммы строки называются
 * `СтТовБезНДС` / `СтТовУчНал`, налог приходит вложенным элементом `СумНал`, а
 * реквизиты стороны — через `ИдСв → СвЮЛУч | СвИП`. Проверить это было не на
 * чем: маршрут ручной загрузки XML на бою не использовался ни разу, а
 * единственный тест подавал самодельный файл, собранный под те же неверные
 * имена, — то есть подтверждал сам себя.
 *
 * Поэтому парсер читает ОБА набора имён: актуальный по формату и прежний.
 * Совместимость не из осторожности — ручной маршрут `/upload-upd` живой, и
 * менять его поведение этим выпуском мы не хотим.
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

function pickOne<T>(v: T | T[] | undefined): T | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

function asNode(v: unknown): Node | undefined {
  return v && typeof v === 'object' ? (v as Node) : undefined;
}

/** Первое непустое значение среди перечисленных ключей узла. */
function attr(node: Node | undefined, ...keys: string[]): string | undefined {
  if (!node) return undefined;
  for (const key of keys) {
    const value = node[key];
    if (value !== undefined && value !== null && String(value) !== '') return String(value);
  }
  return undefined;
}

const PartySchema = z.object({
  inn: z.string(),
  kpp: z.string().nullable(),
  name: z.string(),
});

const ItemSchema = z.object({
  nameRaw: z.string(),
  qty: z.number(),
  unit: z.string(),
  price: z.number().nullable(),
  sum: z.number().nullable(),
  vatRate: z.number().nullable(),
  vatSum: z.number().nullable(),
  lineNo: z.number(),
});

export const UpdParsedSchema = z.object({
  docNumber: z.string(),
  docDate: z.string(),
  totalSum: z.number().nullable(),
  vatSum: z.number().nullable(),
  supplier: PartySchema,
  recipient: PartySchema.nullable(),
  items: z.array(ItemSchema),
});
export type UpdParsed = z.infer<typeof UpdParsedSchema>;

/**
 * Реквизиты стороны.
 *
 * В формате они лежат на два-три уровня глубже, чем кажется:
 * `СвПрод → ИдСв → СвЮЛУч (@ИННЮЛ, @КПП, @НаимОрг)`, а у предпринимателя —
 * `СвИП (@ИННФЛ)` с именем в `ФИО`. Плоские атрибуты поддержаны ради
 * совместимости с прежними файлами.
 */
function partyFromOrg(org: unknown): z.infer<typeof PartySchema> | null {
  const node = asNode(org);
  if (!node) return null;

  const idSv = asNode(node['ИдСв']) ?? asNode(node['СвУчастЭДО']);
  const legal = asNode(idSv?.['СвЮЛУч']) ?? asNode(node['СвЮЛУч']);
  const entrepreneur = asNode(idSv?.['СвИП']) ?? asNode(node['СвИП']);

  const inn =
    attr(legal, '@_ИННЮЛ') ??
    attr(entrepreneur, '@_ИННФЛ') ??
    attr(idSv, '@_ИННЮЛ', '@_ИННФЛ') ??
    attr(node, '@_ИННЮЛ', '@_ИННФЛ');
  if (!inn) return null;

  const kpp = attr(legal, '@_КПП') ?? attr(idSv, '@_КПП') ?? attr(node, '@_КПП') ?? null;

  // У предпринимателя наименования нет — собираем из ФИО.
  const fio = asNode(entrepreneur?.['ФИО']);
  const fioName = fio
    ? [attr(fio, '@_Фамилия'), attr(fio, '@_Имя'), attr(fio, '@_Отчество')]
        .filter(Boolean)
        .join(' ')
    : undefined;

  const name =
    attr(legal, '@_НаимОрг') ??
    attr(node, '@_НаимОрг') ??
    attr(idSv, '@_НаимОрг') ??
    fioName ??
    '';

  return { inn, kpp, name };
}

/** Дата документа приходит как ДД.ММ.ГГГГ; наружу отдаём ISO. */
function normalizeDate(raw: string | undefined): string {
  if (!raw) return '';
  if (raw.length === 10 && raw.includes('.')) {
    return `${raw.slice(6, 10)}-${raw.slice(3, 5)}-${raw.slice(0, 2)}`;
  }
  return raw;
}

/**
 * Сумма налога по строке.
 *
 * Три формы в одном формате: вложенный `СумНал/СумНал`, вложенный
 * `СумНал/БезНДС` (освобождение) и плоский атрибут прежних файлов.
 */
function vatSumOf(item: Node): number | null {
  const nested = asNode(item['СумНал']);
  if (nested) {
    const value = num(nested['СумНал'] ?? attr(nested, '@_СумНал'));
    if (value !== null) return value;
    // «БезНДС» — это ноль налога, а не отсутствие данных.
    if (nested['БезНДС'] !== undefined) return 0;
  }
  return num(attr(item, '@_СумНал', '@_СтоимНалог'));
}

export function parseUpdXml(xml: string): UpdParsed {
  const parsed = parser.parse(xml) as Node;
  const root = asNode(parsed['Файл']);
  if (!root) throw new Error('UPD: missing root <Файл>');

  const document = pickOne(root['Документ'] as Node | Node[] | undefined);
  if (!document) throw new Error('UPD: missing <Документ>');

  const svSchFakt = asNode(document['СвСчФакт']);

  // Номер и дата: сперва по формату (СвСчФакт), затем прежние имена.
  const docNumber = attr(svSchFakt, '@_НомерСчФ') ?? attr(document, '@_НомерДок') ?? '';
  const docDate = normalizeDate(
    attr(svSchFakt, '@_ДатаСчФ') ?? attr(document, '@_ДатаДок') ?? undefined,
  );

  const supplier = partyFromOrg(pickOne(svSchFakt?.['СвПрод'] as Node | Node[] | undefined));
  const recipient = partyFromOrg(pickOne(svSchFakt?.['СвПокуп'] as Node | Node[] | undefined));
  if (!supplier) throw new Error('UPD: missing supplier (СвПрод)');

  const tableSection = asNode(svSchFakt?.['ТаблСчФакт']) ?? asNode(document['ТаблСчФакт']);
  const rawItems = tableSection?.['СведТов'];
  const itemsArr = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];

  const items = itemsArr.map((it, idx) => {
    const item = it as Node;
    return {
      nameRaw: attr(item, '@_НаимТов') ?? '',
      qty: num(attr(item, '@_КолТов')) ?? 0,
      // ОКЕИ_Тов — это КОД единицы («796»), а наименование лежит в НаимЕдИзм.
      // Человеку в карточке нужен «шт», поэтому наименование приоритетнее.
      unit: attr(item, '@_НаимЕдИзм', '@_ОКЕИ_Тов') ?? 'шт',
      price: num(attr(item, '@_ЦенаТов')),
      sum: num(attr(item, '@_СтТовБезНДС', '@_СтоимТовБезНДС', '@_СтТовУчНал', '@_СтоимТовУчНал')),
      vatRate: num(attr(item, '@_НалСт')),
      vatSum: vatSumOf(item),
      lineNo: Number(attr(item, '@_НомСтр') ?? idx + 1),
    };
  });

  const totals = asNode(tableSection?.['ВсегоОпл']);
  const totalSum = num(
    attr(
      totals,
      '@_СтТовБезНДСВсего',
      '@_СтоимТовБезНДСВсего',
      '@_СтТовУчНалВсего',
      '@_СтоимТовУчНалВсего',
    ),
  );
  const totalsVatNode = asNode(totals?.['СумНалВсего']);
  const totalVat =
    num(totalsVatNode?.['СумНал'] ?? attr(totalsVatNode, '@_СумНал')) ??
    num(attr(totals, '@_СумНалВсего'));

  return UpdParsedSchema.parse({
    docNumber,
    docDate,
    totalSum,
    vatSum: totalVat,
    supplier,
    recipient,
    items,
  });
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
