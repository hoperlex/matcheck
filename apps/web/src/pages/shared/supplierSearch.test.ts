/**
 * Поиск и порядок в окне выбора поставщика.
 *
 * Главное обещание — для того, что уже работало: всё, что находил прежний
 * поиск, находит и новый. Его держит перебор по справочнику и запросам ниже.
 */
import { describe, expect, it } from 'vitest';
import {
  matchesSupplierQuery,
  pickSupplierGroupOptions,
  pickSupplierOptions,
  supplierInnGroup,
  supplierOptionLabel,
  supplierSearchKey,
} from './supplierSearch';
import { normalizeSupplierIds } from './useSupplierFilterOptions';

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

describe('pickSupplierGroupOptions — одна строка на поставщика', () => {
  const TULA = [
    { id: 'dup-su10', inn: '7736255508', name: 'ООО «ТОРГОВЫЙ ДОМ «ТУЛА-СТАЛЬ»', aliases: [] },
    { id: 'dup', inn: '7725459500', name: 'ООО "ТОРГОВЫЙ ДОМ "ТУЛА-СТАЛЬ"', aliases: [] },
    { id: 'bh', inn: '7725495000', name: 'ООО "ТД "ТУЛА-СТАЛЬ"', aliases: [] },
  ];
  const GROUPS = [
    { value: 'bh', memberIds: ['bh', 'dup', 'dup-su10'] },
    ...MOZHAYSK.map((s) => ({ value: s.id, memberIds: [s.id] })),
  ];
  const all = [...TULA, ...MOZHAYSK];

  it('дубли — строкой основной записи, по ИНН любого участника', () => {
    for (const q of ['тула', '7736255508', '7725459500', '7725495000']) {
      const picked = pickSupplierGroupOptions(GROUPS, all, q, null);
      expect(picked.map((p) => p.supplier.id)).toEqual(['bh']);
    }
  });

  it('всё, что находил поиск по записям, находится строкой своей группы', () => {
    const groupOf = new Map(GROUPS.flatMap((g) => g.memberIds.map((id) => [id, g.value])));
    for (const q of ['', 'АО И', 'исткульт', 'тула', '5028', 'ООО', 'империя ооо']) {
      const before = pickSupplierOptions(all, q, null).map((p) => groupOf.get(p.supplier.id));
      const after = pickSupplierGroupOptions(GROUPS, all, q, null).map((p) => p.supplier.id);
      expect(new Set(after)).toEqual(new Set(before));
    }
  });

  it('порядок по ИНН основной записи: «как в документе» — первой, битые — в конце', () => {
    const picked = pickSupplierGroupOptions(GROUPS, all, '', '5028021698');
    expect(picked[0]).toMatchObject({ supplier: { id: 'right' }, group: 'doc_inn' });
    expect(picked.at(-1)?.group).toBe('invalid');
  });

  it('запись вне групп (заведена после загрузки) — строкой сама по себе', () => {
    const fresh = { id: 'fresh', inn: '', name: 'ООО «ТУЛА-СТАЛЬ НОВАЯ»', aliases: [] };
    const picked = pickSupplierGroupOptions(GROUPS, [...all, fresh], 'тула', null);
    expect(picked.map((p) => p.supplier.id)).toEqual(['bh', 'fresh']);
  });
});

describe('normalizeSupplierIds', () => {
  const groupOf = new Map([
    ['bh', 'bh'],
    ['dup', 'bh'],
    ['dup-su10', 'bh'],
  ]);

  it('участник группы — id её строки, повторы убираются, неизвестные id остаются', () => {
    expect(normalizeSupplierIds(['dup', 'dup-su10', 'bh', 'gone'], groupOf)).toEqual([
      'bh',
      'gone',
    ]);
    expect(normalizeSupplierIds([], groupOf)).toEqual([]);
  });
});
