/**
 * PDF-представление УПД из ЭДО для сверки.
 *
 * Главное здесь — верность данным: отсутствующее не печатается числом, а
 * неполный разбор не выглядит полным. Фикстуры собраны по описанию формата,
 * как в upd-xml-format.test.ts; парсер не подменяется — PDF строится из того
 * же UpdParsed, что увидит маршрут.
 */
import { describe, expect, it } from 'vitest';
import { PDFParse } from 'pdf-parse';
import { parseUpdXml, type UpdParsed } from '../src/domain/edo/upd.parser.js';
import {
  buildUpdPdfDefinition,
  renderUpdPdf,
  updCompletenessWarnings,
} from '../src/domain/edo/upd-review-pdf.js';

function utd(opts: { items: string; totals?: string; head?: string; correction?: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Файл ИдФайл="ON_NSCHFDOPPR_TEST" ВерсФорм="5.03">
  <Документ КНД="1115131" Функция="СЧФДОП">
    <СвСчФакт ${opts.head ?? 'НомерСчФ="УТ-4308" ДатаСчФ="01.09.2026"'}>
      ${opts.correction ?? ''}
      <СвПрод>
        <ИдСв><СвЮЛУч НаимОрг="ООО «Металлбаза»" ИННЮЛ="7712345678" КПП="771201001"/></ИдСв>
      </СвПрод>
      <ГрузОт><ОнЖе>он же</ОнЖе></ГрузОт>
      <СвПокуп>
        <ИдСв><СвЮЛУч НаимОрг="ООО «СУ-10»" ИННЮЛ="7736030001" КПП="773601001"/></ИдСв>
      </СвПокуп>
      <ДенИзм КодОКВ="643"/>
    </СвСчФакт>
    <ТаблСчФакт>
      ${opts.items}
      ${opts.totals ?? ''}
    </ТаблСчФакт>
  </Документ>
</Файл>`;
}

const TWO_ITEMS = `
  <СведТов НомСтр="1" НаимТов="Труба стальная 57х3.5" ОКЕИ_Тов="168" НаимЕдИзм="т"
           КолТов="2.5" ЦенаТов="64000" СтТовБезНДС="160000" НалСт="20%" СтТовУчНал="192000">
    <СумНал><СумНал>32000</СумНал></СумНал>
  </СведТов>
  <СведТов НомСтр="2" НаимТов="Уголок 50х50" ОКЕИ_Тов="168" НаимЕдИзм="т"
           КолТов="1" ЦенаТов="58000" СтТовБезНДС="58000" НалСт="20%" СтТовУчНал="69600">
    <СумНал><СумНал>11600</СумНал></СумНал>
  </СведТов>`;

const TWO_TOTALS = `
  <ВсегоОпл СтТовБезНДСВсего="218000" СтТовУчНалВсего="261600">
    <СумНалВсего><СумНал>43600</СумНал></СумНалВсего>
  </ВсегоОпл>`;

/** Услуга без количества и цены, «без НДС» — всё, что парсер отдаёт как 0 и null. */
const SERVICE_ITEM = `
  <СведТов НомСтр="1" НаимТов="Доставка" НаимЕдИзм="усл" СтТовБезНДС="5000" НалСт="без НДС" СтТовУчНал="5000">
    <СумНал><БезНДС>без НДС</БезНДС></СумНал>
  </СведТов>`;

const SERVICE_TOTALS = `
  <ВсегоОпл СтТовБезНДСВсего="5000" СтТовУчНалВсего="5000">
    <СумНалВсего><БезНДС>без НДС</БезНДС></СумНалВсего>
  </ВсегоОпл>`;

const FULL = parseUpdXml(utd({ items: TWO_ITEMS, totals: TWO_TOTALS }));

async function pdfText(pdf: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(pdf) });
  try {
    return (await parser.getText()).text.replace(/\s+/g, ' ');
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

type Cell = string | { text?: unknown };
type Table = { table: { headerRows?: number; body: Cell[][] }; layout?: unknown };

function tables(parsed: UpdParsed): Table[] {
  const def = buildUpdPdfDefinition(parsed, updCompletenessWarnings(parsed));
  return (def.content as unknown[]).filter(
    (c): c is Table => typeof c === 'object' && c !== null && 'table' in c,
  );
}

function cellText(cell: Cell): string {
  return typeof cell === 'string' ? cell : String(cell.text ?? '');
}

/** Строки позиций без шапки и итога. */
function itemRows(parsed: UpdParsed): string[][] {
  const table = tables(parsed).find((t) => t.table.headerRows === 1);
  if (!table) throw new Error('нет таблицы позиций');
  return table.table.body.slice(1, -1).map((row) => row.map(cellText));
}

function requisites(parsed: UpdParsed): Map<string, string> {
  const table = tables(parsed).find((t) => t.layout === 'noBorders');
  if (!table) throw new Error('нет таблицы реквизитов');
  return new Map(table.table.body.map((row) => [cellText(row[0]!), cellText(row[1]!)]));
}

describe('renderUpdPdf', () => {
  it('строит PDF с кириллицей: номер, стороны, позиции и итог читаются из файла', async () => {
    const { pdf, warnings } = await renderUpdPdf(FULL);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(warnings).toEqual([]);

    const text = await pdfText(pdf);
    expect(text).toContain('УТ-4308');
    expect(text).toContain('01.09.2026');
    expect(text).toContain('ООО «Металлбаза»');
    expect(text).toContain('7712345678');
    expect(text).toContain('ООО «СУ-10»');
    expect(text).toContain('Труба стальная 57х3.5');
    expect(text).toContain('261 600,00');
    expect(text).toContain('Представление для сверки');
    expect(text).toContain('не печатная форма и не оригинал');
    expect(text).not.toContain('Проверьте по XML');
  });

  it('неполный разбор виден в самом PDF красной рамкой', async () => {
    const parsed = parseUpdXml(utd({ items: TWO_ITEMS }));
    const { pdf, warnings } = await renderUpdPdf(parsed);
    expect(warnings).toContain('Итог документа не прочитан — сверить сумму позиций не с чем.');
    expect(await pdfText(pdf)).toContain('Проверьте по XML');
  });

  it('документ на сотни позиций строится и уходит на несколько страниц', async () => {
    const rows = Array.from(
      { length: 460 },
      (_, i) =>
        `<СведТов НомСтр="${i + 1}" НаимТов="Кабель ВВГнг(А)-LS 3х2,5 позиция ${i + 1}" ОКЕИ_Тов="006" НаимЕдИзм="м"
                 КолТов="10" ЦенаТов="100" СтТовБезНДС="1000" НалСт="20%" СтТовУчНал="1200">
           <СумНал><СумНал>200</СумНал></СумНал>
         </СведТов>`,
    ).join('');
    const totals = `<ВсегоОпл СтТовБезНДСВсего="460000" СтТовУчНалВсего="552000">
      <СумНалВсего><СумНал>92000</СумНал></СумНалВсего></ВсегоОпл>`;
    const { pdf, warnings } = await renderUpdPdf(parseUpdXml(utd({ items: rows, totals })));
    expect(warnings).toEqual([]);
    const text = await pdfText(pdf);
    expect(text).toContain('позиция 460');
    expect(text).toMatch(/стр\. 2 из \d+/);
  });
});

describe('ячейки: отсутствующее не печатается числом', () => {
  it('целая позиция печатает все значения', () => {
    const [first] = itemRows(FULL);
    expect(first).toEqual([
      '1',
      '—',
      'Труба стальная 57х3.5',
      'т (168)',
      '2,5',
      '64 000,00',
      '160 000,00',
      '20%',
      '32 000,00',
      '192 000,00',
    ]);
  });

  it('количество 0, пустая цена и ставка «без НДС» — прочерк, а не ноль', () => {
    const parsed = parseUpdXml(utd({ items: SERVICE_ITEM, totals: SERVICE_TOTALS }));
    // Парсер действительно отдаёт 0 и null — ради этого и прочерки.
    expect(parsed.items[0]).toMatchObject({ qty: 0, price: null, vatRate: null, vatSum: 0 });
    const [row] = itemRows(parsed);
    expect(row![4]).toBe('—');
    expect(row![5]).toBe('—');
    expect(row![7]).toBe('—');
    // Налог «БезНДС» парсер читает как ноль налога — это значение, не пропуск.
    expect(row![8]).toBe('0,00');
  });
});

describe('реквизиты', () => {
  it('продавец, грузоотправитель «он же», покупатель и валюта', () => {
    const map = requisites(FULL);
    expect(map.get('Статус')).toBe('СЧФДОП — счёт-фактура и передаточный документ');
    expect(map.get('Продавец')).toBe('ООО «Металлбаза», ИНН 7712345678, КПП 771201001');
    expect(map.get('Грузоотправитель')).toBe('он же');
    expect(map.get('Грузополучатель')).toBe('—');
    expect(map.get('Покупатель')).toBe('ООО «СУ-10», ИНН 7736030001, КПП 773601001');
    expect(map.get('Валюта')).toBe('643 — российский рубль');
    expect(map.has('Исправление')).toBe(false);
  });

  it('исправительный УПД показывает номер и дату исправления', () => {
    const parsed = parseUpdXml(
      utd({
        items: TWO_ITEMS,
        totals: TWO_TOTALS,
        correction: '<ИспрСчФ НомИспр="2" ДатаИспр="05.09.2026"/>',
      }),
    );
    expect(parsed.correction).toEqual({ number: '2', date: '2026-09-05' });
    expect(requisites(parsed).get('Исправление')).toBe('№ 2 от 05.09.2026');
  });
});

describe('updCompletenessWarnings', () => {
  it('целый документ — без предупреждений', () => {
    expect(updCompletenessWarnings(FULL)).toEqual([]);
  });

  it('нет позиций', () => {
    const parsed = parseUpdXml(utd({ items: '', totals: TWO_TOTALS }));
    expect(updCompletenessWarnings(parsed)).toEqual(['В документе не прочитано ни одной позиции.']);
  });

  it('количество не прочитано', () => {
    const parsed = parseUpdXml(utd({ items: SERVICE_ITEM, totals: SERVICE_TOTALS }));
    expect(updCompletenessWarnings(parsed)).toEqual([
      'У 1 позиции количество не прочитано или равно нулю.',
    ]);
  });

  it('сумма позиций не сходится с итогом', () => {
    const totals = `<ВсегоОпл СтТовБезНДСВсего="218000" СтТовУчНалВсего="300000">
      <СумНалВсего><СумНал>43600</СумНал></СумНалВсего></ВсегоОпл>`;
    const parsed = parseUpdXml(utd({ items: TWO_ITEMS, totals }));
    expect(updCompletenessWarnings(parsed)).toEqual([
      'Сумма позиций с НДС (261 600,00 ₽) не сходится с итогом документа (300 000,00 ₽), разница 38 400,00 ₽.',
    ]);
  });

  it('копейки округления в пределах допуска не тревожат', () => {
    const totals = `<ВсегоОпл СтТовБезНДСВсего="218000.01" СтТовУчНалВсего="261600.02">
      <СумНалВсего><СумНал>43600</СумНал></СумНалВсего></ВсегоОпл>`;
    expect(updCompletenessWarnings(parseUpdXml(utd({ items: TWO_ITEMS, totals })))).toEqual([]);
  });

  it('итог не прочитан', () => {
    const parsed = parseUpdXml(utd({ items: TWO_ITEMS }));
    expect(updCompletenessWarnings(parsed)).toEqual([
      'Итог документа не прочитан — сверить сумму позиций не с чем.',
    ]);
  });

  it('нет номера и даты', () => {
    const parsed = parseUpdXml(utd({ items: TWO_ITEMS, totals: TWO_TOTALS, head: '' }));
    expect(updCompletenessWarnings(parsed)).toEqual([
      'Номер документа не прочитан.',
      'Дата документа не прочитана.',
    ]);
  });
});
