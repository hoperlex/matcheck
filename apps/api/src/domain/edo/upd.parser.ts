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

function num(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function pickOne<T>(v: T | T[] | undefined): T | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v[0];
  return v;
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

function partyFromOrg(org: unknown): z.infer<typeof PartySchema> | null {
  if (!org || typeof org !== 'object') return null;
  const obj = org as Record<string, unknown>;
  const svUchet = obj['СвЮЛУч'] ?? obj['СвИП'];
  const idSv = obj['ИдСв'] ?? obj['СвУчастЭДО'];
  const inn = String(
    obj['@_ИННЮЛ'] ??
      obj['@_ИННФЛ'] ??
      (idSv && typeof idSv === 'object'
        ? ((idSv as Record<string, unknown>)['@_ИННЮЛ'] ??
          (idSv as Record<string, unknown>)['@_ИННФЛ'])
        : '') ??
      '',
  );
  if (!inn) return null;
  const kpp =
    (obj['@_КПП'] as string | undefined) ??
    (svUchet && typeof svUchet === 'object'
      ? ((svUchet as Record<string, unknown>)['@_КПП'] as string | undefined)
      : undefined) ??
    null;
  const name = String(
    (obj['@_НаимОрг'] as string | undefined) ??
      (svUchet && typeof svUchet === 'object'
        ? (svUchet as Record<string, unknown>)['@_НаимОрг']
        : '') ??
      '',
  );
  return { inn, kpp: kpp ?? null, name };
}

export function parseUpdXml(xml: string): UpdParsed {
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const root = parsed['Файл'] as Record<string, unknown> | undefined;
  if (!root) throw new Error('UPD: missing root <Файл>');

  const document = pickOne(root['Документ'] as Record<string, unknown> | Record<string, unknown>[]);
  if (!document) throw new Error('UPD: missing <Документ>');

  const docNumber = String(document['@_НомерДок'] ?? '');
  const docDateRaw = String(document['@_ДатаДок'] ?? '');
  const docDate = docDateRaw
    ? docDateRaw.length === 10 && docDateRaw.includes('.')
      ? `${docDateRaw.slice(6, 10)}-${docDateRaw.slice(3, 5)}-${docDateRaw.slice(0, 2)}`
      : docDateRaw
    : '';

  const svSchFakt = document['СвСчФакт'] as Record<string, unknown> | undefined;
  const svProd = svSchFakt?.['СвПрод'];
  const svPokup = svSchFakt?.['СвПокуп'];
  const supplier = partyFromOrg(svProd);
  const recipient = svPokup ? partyFromOrg(svPokup) : null;
  if (!supplier) throw new Error('UPD: missing supplier (СвПрод)');

  const tableSection =
    (svSchFakt?.['ТаблСчФакт'] as Record<string, unknown> | undefined) ??
    (document['ТаблСчФакт'] as Record<string, unknown> | undefined);
  const rawItems = tableSection?.['СведТов'];
  const itemsArr = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];

  const items = itemsArr.map((it, idx) => {
    const obj = it as Record<string, unknown>;
    const sumNds = obj['СумНал'] as Record<string, unknown> | undefined;
    const vatSum = sumNds ? num(sumNds['СумНал']) : num(obj['@_СтоимНалог']);
    return {
      nameRaw: String(obj['@_НаимТов'] ?? ''),
      qty: num(obj['@_КолТов']) ?? 0,
      unit: String(obj['@_ОКЕИ_Тов'] ?? obj['@_НаимЕдИзм'] ?? 'шт'),
      price: num(obj['@_ЦенаТов']),
      sum: num(obj['@_СтоимТовБезНДС']) ?? num(obj['@_СтоимТовУчНал']),
      vatRate: num(obj['@_НалСт']),
      vatSum,
      lineNo: Number(obj['@_НомСтр'] ?? idx + 1),
    };
  });

  const tableItog = tableSection?.['ВсегоОпл'] as Record<string, unknown> | undefined;
  const totalSum = tableItog
    ? (num(tableItog['@_СтоимТовБезНДСВсего']) ?? num(tableItog['@_СтоимТовУчНалВсего']))
    : null;
  const totalVat = tableItog ? num(tableItog['@_СумНалВсего']) : null;

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
