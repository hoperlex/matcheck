/**
 * Отпечаток состава УПД (`contentKeyOf`) — признак «та же УПД, отправленная
 * повторно новым файлом» между Диадоком и СБИС.
 *
 * Два обещания, оба из шага 0 этапа Р2 (22.10.2026):
 *   - повторная отправка того же УПД даёт тот же ключ — оформление файла
 *     (пробелы, регистр, запись чисел, ИдФайл, порядок атрибутов) не влияет;
 *   - разные документы с одним номером и датой («Служба Механизации», №671:
 *     другой НДС, другие позиции) дают разные ключи.
 */
import { describe, expect, it } from 'vitest';
import { contentKeyOf, fileIdOf } from '../src/domain/edo/export-identity.js';
import { parseUpdXml } from '../src/domain/edo/upd.parser.js';

type Line = { name: string; qty: string; unit?: string; okei?: string; price: string; exVat: string; vat: string; total: string };

function upd(over: {
  fileId?: string;
  number?: string;
  date?: string;
  fn?: string;
  buyerKpp?: string;
  lines?: Line[];
  totalVat?: string;
  correction?: string;
} = {}): string {
  const lines = over.lines ?? [
    { name: 'Бетон B25', qty: '10', okei: '113', unit: 'м3', price: '6500.00', exVat: '65000.00', vat: '13000.00', total: '78000.00' },
    { name: 'Доставка', qty: '1', okei: '876', unit: 'усл. ед', price: '1000.00', exVat: '1000.00', vat: '200.00', total: '1200.00' },
  ];
  const exVat = lines.reduce((s, l) => s + Number(l.exVat), 0).toFixed(2);
  const total = lines.reduce((s, l) => s + Number(l.total), 0).toFixed(2);
  const vat = over.totalVat ?? lines.reduce((s, l) => s + Number(l.vat), 0).toFixed(2);
  const rows = lines
    .map(
      (l, i) => `<СведТов НомСтр="${i + 1}" НаимТов="${l.name}" ${l.okei ? `ОКЕИ_Тов="${l.okei}"` : ''} НаимЕдИзм="${l.unit ?? ''}"
        КолТов="${l.qty}" ЦенаТов="${l.price}" СтТовБезНДС="${l.exVat}" НалСт="20%" СтТовУчНал="${l.total}">
        <Акциз><БезАкциз>без акциза</БезАкциз></Акциз><СумНал><СумНал>${l.vat}</СумНал></СумНал><ДопСведТов ПрТовРаб="1"/>
      </СведТов>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<Файл ИдФайл="${over.fileId ?? 'ON_NSCHFDOPPR_A_B_20261013_guid-1'}" ВерсФорм="5.03" ВерсПрог="1С">
  <Документ КНД="1115131" Функция="${over.fn ?? 'СЧФДОП'}" ДатаИнфПр="31.08.2026">
    <СвСчФакт НомерДок="${over.number ?? '671'}" ДатаДок="${over.date ?? '31.08.2026'}">
      ${over.correction ? `<ИспрДок НомИспр="${over.correction}" ДатаИспр="01.09.2026"/>` : ''}
      <СвПрод><ИдСв><СвЮЛУч НаимОрг="АО Служба Механизации" ИННЮЛ="7705794997" КПП="770501001"/></ИдСв></СвПрод>
      <СвПокуп><ИдСв><СвЮЛУч НаимОрг="ООО СУ-10" ИННЮЛ="7736255508" КПП="${over.buyerKpp ?? '774550001'}"/></ИдСв></СвПокуп>
      <ДенИзм КодОКВ="643" НаимОКВ="Российский рубль"/>
    </СвСчФакт>
    <ТаблСчФакт>
      ${rows}
      <ВсегоОпл СтТовБезНДСВсего="${exVat}" СтТовУчНалВсего="${total}"><СумНалВсего><СумНал>${vat}</СумНал></СумНалВсего></ВсегоОпл>
    </ТаблСчФакт>
  </Документ>
</Файл>`;
}

const key = (xml: string) => contentKeyOf(parseUpdXml(xml));

describe('отпечаток состава УПД', () => {
  it('повторная отправка новым файлом — тот же ключ', () => {
    const first = key(upd({ fileId: 'ON_NSCHFDOPPR_A_B_20260901_guid-1' }));
    const resent = key(upd({ fileId: 'ON_NSCHFDOPPR_A_B_20261017_guid-2' }));
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(resent).toBe(first);
  });

  it('оформление не влияет: регистр и пробелы в названии, запись чисел', () => {
    const base = key(upd());
    const reformatted = key(
      upd({
        lines: [
          { name: '  бетон   B25 ', qty: '10.000', okei: '113', unit: 'м3', price: '6500', exVat: '65000', vat: '13000.0', total: '78000' },
          { name: 'ДОСТАВКА', qty: '1', okei: '876', unit: 'усл. ед', price: '1000.0', exVat: '1000', vat: '200', total: '1200.00' },
        ],
      }),
    );
    expect(reformatted).toBe(base);
  });

  it('разные документы с тем же номером и датой — разные ключи (№671: другой НДС, другие позиции)', () => {
    const base = key(upd());
    expect(key(upd({ totalVat: '13300.00' }))).not.toBe(base);
    expect(
      key(
        upd({
          lines: [{ name: 'Бетон B25', qty: '5', okei: '113', unit: 'м3', price: '6500.00', exVat: '32500.00', vat: '6500.00', total: '39000.00' }],
        }),
      ),
    ).not.toBe(base);
  });

  it.each([
    ['количество позиции', { lines: [{ name: 'Бетон B25', qty: '11', okei: '113', unit: 'м3', price: '6500.00', exVat: '71500.00', vat: '14300.00', total: '85800.00' }] }],
    ['номер', { number: '672' }],
    ['дата', { date: '01.09.2026' }],
    ['функция', { fn: 'ДОП' }],
    ['КПП покупателя', { buyerKpp: '771501001' }],
    ['исправление', { correction: '1' }],
  ])('%s меняет ключ', (_name, over) => {
    expect(key(upd(over))).not.toBe(key(upd()));
  });

  it('без номера или без позиций — ключа нет (по составу не склеивается)', () => {
    expect(key(upd({ number: '' }))).toBeNull();
    const parsed = parseUpdXml(upd());
    expect(contentKeyOf({ ...parsed, items: [] })).toBeNull();
    expect(contentKeyOf({ ...parsed, docDate: '' })).toBeNull();
  });

  it('ИдФайл берётся из XML', () => {
    expect(fileIdOf(parseUpdXml(upd({ fileId: 'ON_X_1' })))).toBe('ON_X_1');
  });
});
