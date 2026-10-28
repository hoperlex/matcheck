// Отчёт о состоянии справочников: кандидаты в «Контрагенты» и ИНН для записей
// без ИНН. Только подсказки человеку — проверяем, что в них не попадают своя
// организация, битые ИНН и уже известные подрядчики.
import { describe, expect, it } from 'vitest';
import {
  contractorCandidates,
  suggestContractorInns,
  type PartySide,
} from '../src/domain/directories/health.js';

const SU10 = '7736255508';
const STROYPARTNER = '7722680372';
const TETRA = '7727362341';
const FORUM = '7719659204';

let seq = 0;
function side(p: Partial<PartySide> & { inn: string | null; name: string | null }): PartySide {
  seq += 1;
  return {
    role: 'buyer',
    documentId: `d${seq}`,
    siteId: 's1',
    createdAt: new Date('2026-10-01T10:00:00Z'),
    ...p,
  };
}

describe('contractorCandidates', () => {
  it('частый покупатель вне списка — кандидат; свои, битые и известные — нет', () => {
    const sides = [
      ...Array.from({ length: 3 }, () => side({ inn: STROYPARTNER, name: 'ООО "СТРОЙПАРТНЕР"' })),
      side({ inn: STROYPARTNER, name: 'ООО СтройПартнер', role: 'consignee', siteId: 's2' }),
      side({ inn: SU10, name: 'СУ-10' }),
      side({ inn: '7736255087', name: 'СУ-10' }),
      side({ inn: FORUM, name: 'ФОРУМ' }),
      side({ inn: FORUM, name: 'ФОРУМ' }),
      side({ inn: FORUM, name: 'ФОРУМ' }),
      side({ inn: FORUM, name: 'ФОРУМ' }),
    ];
    const out = contractorCandidates(sides, {
      ccInns: new Set([FORUM]),
      ownInns: new Set([SU10]),
      billhubInns: new Set([STROYPARTNER]),
      asSupplier: new Map([[STROYPARTNER, 7]]),
      minDocs: 2,
    });
    expect(out).toEqual([
      {
        inn: STROYPARTNER,
        name: 'ООО "СТРОЙПАРТНЕР"',
        asBuyer: 3,
        asConsignee: 1,
        docs: 4,
        sites: 2,
        asSupplier: 7,
        inBillhub: true,
        lastAt: new Date('2026-10-01T10:00:00Z'),
      },
    ]);
  });

  it('покупатель и грузополучатель одного документа — один документ', () => {
    const both = [
      side({ inn: TETRA, name: 'ТЕТРАГРУПП', documentId: 'x' }),
      side({ inn: TETRA, name: 'ТЕТРАГРУПП', documentId: 'x', role: 'consignee' }),
    ];
    const out = contractorCandidates(both, {
      ccInns: new Set(),
      ownInns: new Set(),
      billhubInns: new Set(),
      asSupplier: new Map(),
      minDocs: 1,
    });
    expect(out[0]).toMatchObject({ docs: 1, asBuyer: 1, asConsignee: 1 });
  });
});

describe('suggestContractorInns', () => {
  const cc = [
    { id: 'c1', name: 'ООО "ТЕТРАГРУПП"', inn: '', aliases: [] },
    { id: 'c2', name: 'ООО "ФОРУМ"', inn: FORUM, aliases: [] },
    { id: 'c3', name: 'ООО "НИКТО"', inn: '', aliases: [] },
    { id: 'c4', name: 'ООО "ДУБЛЬ ФОРУМА"', inn: '', aliases: ['ООО Форум-2'] },
  ];

  it('самый частый корректный ИНН одноимённой стороны, с долей и вариантами', () => {
    const sides = [
      side({ inn: TETRA, name: 'Тетрагрупп' }),
      side({ inn: TETRA, name: 'ООО «ТЕТРАГРУПП»', role: 'consignee' }),
      side({ inn: '7727362342', name: 'ТЕТРАГРУПП' }),
      side({ inn: FORUM, name: 'ТЕТРАГРУПП' }),
      side({ inn: SU10, name: 'ТЕТРАГРУПП' }),
    ];
    expect(suggestContractorInns(cc, sides, new Set([SU10]))).toEqual([
      {
        id: 'c1',
        name: 'ООО "ТЕТРАГРУПП"',
        inn: TETRA,
        hits: 2,
        total: 3,
        otherInns: [`${FORUM} (1)`],
        takenBy: null,
      },
    ]);
  });

  it('записи с ИНН не трогаются; ИНН, занятый другой записью, помечается; алиасы учитываются', () => {
    const sides = [side({ inn: FORUM, name: 'Форум-2' })];
    expect(suggestContractorInns(cc, sides, new Set())).toEqual([
      {
        id: 'c4',
        name: 'ООО "ДУБЛЬ ФОРУМА"',
        inn: FORUM,
        hits: 1,
        total: 1,
        otherInns: [],
        takenBy: 'ООО "ФОРУМ"',
      },
    ]);
  });
});
