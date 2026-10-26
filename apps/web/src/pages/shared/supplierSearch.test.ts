/**
 * Поиск и порядок в окне выбора поставщика.
 *
 * Главное обещание — для того, что уже работало: всё, что находил прежний
 * поиск, находит и новый. Его держит перебор по справочнику и запросам ниже.
 */
import { describe, expect, it } from 'vitest';
import {
  matchesSupplierQuery,
  pickSupplierOptions,
  supplierInnGroup,
  supplierOptionLabel,
  supplierSearchKey,
} from './supplierSearch';

const MOZHAYSK = [
  { id: 'dup-quoted', inn: '5028021898', name: 'АО "ИСТКУЛЬТ МОЖАЙСК"', aliases: [] },
  { id: 'dup-plain', inn: '5028024698', name: 'АО ИСТКУЛЬТ МОЖАЙСК', aliases: [] },
  { id: 'right', inn: '5028021698', name: 'ООО «МОЖАЙСК»', aliases: [] },
  { id: 'no-inn', inn: '', name: 'ИМПЕРИЯ', aliases: ['ИМПЕРИЯ ООО'] },
];

/** Прежний фильтр SupplierChip — дословно. */
function oldMatch(s: { name: string; inn: string | null }, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return true;
  return s.name.toLowerCase().includes(trimmed) || (s.inn ?? '').toLowerCase().includes(trimmed);
}

describe('supplierSearchKey', () => {
  it('кавычки, регистр, «ё» и пробелы не важны', () => {
    expect(supplierSearchKey('АО "ИСТКУЛЬТ  МОЖАЙСК"')).toBe('ао исткульт можайск');
    expect(supplierSearchKey('ООО «Ёлка»')).toBe('ооо елка');
  });
});

describe('matchesSupplierQuery', () => {
  it('«АО И» находит запись с кавычками (жалоба 21713)', () => {
    expect(matchesSupplierQuery(MOZHAYSK[0]!, 'АО И')).toBe(true);
    expect(matchesSupplierQuery(MOZHAYSK[1]!, 'АО И')).toBe(true);
    expect(matchesSupplierQuery(MOZHAYSK[2]!, 'АО И')).toBe(false);
  });

  it('по ИНН — как раньше, и с пробелами', () => {
    expect(matchesSupplierQuery(MOZHAYSK[2]!, '5028021698')).toBe(true);
    expect(matchesSupplierQuery(MOZHAYSK[2]!, '5028 021 698')).toBe(true);
    expect(matchesSupplierQuery(MOZHAYSK[0]!, '5028021698')).toBe(false);
  });

  it('по алиасу', () => {
    expect(matchesSupplierQuery(MOZHAYSK[3]!, 'империя ооо')).toBe(true);
  });

  it('всё, что находил прежний поиск, находится и теперь', () => {
    const directory = [
      ...MOZHAYSK,
      { id: 'a', inn: '7736255508', name: 'ООО "СУ-10"', aliases: [] },
      { id: 'b', inn: '77-29742081', name: 'ООО «Королевская вода»', aliases: [] },
      { id: 'c', inn: '', name: 'ИП Порунов А.В.', aliases: [] },
    ];
    const queries = [
      '',
      ' ',
      'АО',
      'ао "',
      '"',
      '«',
      'су-10',
      'СУ-10"',
      '7736',
      '77-29',
      'а.в.',
      'ип порунов',
      'вода»',
      'ИСТКУЛЬТ',
      '5028',
      ' 50 ',
    ];
    for (const s of directory) {
      for (const q of queries) {
        if (oldMatch(s, q)) expect(matchesSupplierQuery(s, q), `${s.name} / «${q}»`).toBe(true);
      }
    }
  });
});

describe('supplierInnGroup', () => {
  it('по ИНН документа, валидности и пустоте', () => {
    expect(supplierInnGroup('5028021698', '5028021698')).toBe('doc_inn');
    expect(supplierInnGroup('5028021698', null)).toBe('valid');
    expect(supplierInnGroup('5028024698', '5028021698')).toBe('invalid');
    expect(supplierInnGroup('', '5028021698')).toBe('no_inn');
    expect(supplierInnGroup(null, null)).toBe('no_inn');
  });
});

describe('pickSupplierOptions', () => {
  it('ИНН документа первым, битые в конце, внутри группы порядок справочника', () => {
    const picked = pickSupplierOptions(MOZHAYSK, '', '5028021698').map((x) => x.supplier.id);
    expect(picked).toEqual(['right', 'no-inn', 'dup-quoted', 'dup-plain']);
  });

  it('без ИНН документа группы «как в документе» нет', () => {
    const picked = pickSupplierOptions(MOZHAYSK, '', null).map((x) => x.group);
    expect(picked).toEqual(['valid', 'no_inn', 'invalid', 'invalid']);
  });

  it('обрезка до лимита — после сортировки', () => {
    const filler = Array.from({ length: 300 }, (_, i) => ({
      id: `f-${i}`,
      inn: '',
      name: `Наполнитель ${i}`,
      aliases: [],
    }));
    const picked = pickSupplierOptions([...filler, MOZHAYSK[2]!], '', '5028021698');
    expect(picked).toHaveLength(200);
    expect(picked[0]!.supplier.id).toBe('right');
  });
});

describe('supplierOptionLabel', () => {
  it('подпись — строка с пометкой группы', () => {
    expect(supplierOptionLabel(MOZHAYSK[2]!, 'doc_inn')).toBe(
      'ООО «МОЖАЙСК» · ИНН 5028021698 — ИНН как в документе',
    );
    expect(supplierOptionLabel(MOZHAYSK[1]!, 'invalid')).toBe(
      'АО ИСТКУЛЬТ МОЖАЙСК · ИНН 5028024698 — ИНН не проходит проверку',
    );
    expect(supplierOptionLabel(MOZHAYSK[3]!, 'no_inn')).toBe('ИМПЕРИЯ');
  });
});
