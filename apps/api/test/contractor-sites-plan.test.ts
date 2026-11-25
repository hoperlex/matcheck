// План импорта связей «подрядчик × объект → вид»: сопоставление подрядчика и
// объекта, склейка строк в копейках, вид, дифф слоя 1С и откат по снимку.
import { describe, expect, it } from 'vitest';
import type { OneCContractor } from '../src/domain/directories/parse.js';
import type { CcRow } from '../src/domain/directories/plan-contractors.js';
import type { ContractorSiteRow } from '../src/domain/contractor-sites/parse.js';
import {
  buildFileTarget,
  buildSnapshot,
  kindOf,
  kopToSum,
  planLayer,
  resolveObjectSite,
  snapshotTarget,
  type ContractorSitesState,
  type CurrentLink,
  type OnecLayer,
  type SiteRef,
  type TargetEntry,
} from '../src/domain/contractor-sites/plan.js';

/** Корректный десятизначный ИНН из девяти цифр: дописывает контрольную. */
function validInn(prefix9: string): string {
  const d = [...prefix9].map(Number);
  const check = ([2, 4, 10, 3, 5, 9, 4, 6, 8].reduce((a, w, i) => a + w * d[i]!, 0) % 11) % 10;
  return prefix9 + check;
}

const ALLIANCE_INN = validInn('771696778');

const SITES: SiteRef[] = [
  { id: 's-d56', code: 'Д56', name: 'ЖК ДОМ 56', isActive: true },
  { id: 's-zil18', code: 'ЗИЛ18', name: 'ЖК ЗИЛАРТ, ГРАНД', isActive: true },
  { id: 's-me3', code: 'МЕ3.0', name: 'ЖК Метрополия 3-ая оч.', isActive: true },
  { id: 's-sip', code: 'СИП', name: 'ЖК Сиреневый парк', isActive: true },
  { id: 's-tgl', code: 'ТГЛ', name: 'Тагильская', isActive: true },
  { id: 's-prim14', code: 'ПРИМ14', name: 'PRIMAVERA К14', isActive: false },
];
const CODES = new Set(SITES.map((s) => s.code));

const CC: CcRow[] = [
  { id: 'c-fortex', inn: '7736332544', name: 'ООО «ФОРТЭКС»', aliases: [] },
  { id: 'c-satan', inn: '744516546324', name: 'ИП Сатаневский Н.М.', aliases: [] },
  { id: 'c-msu1', inn: '9727099983', name: 'ООО "МСУ-15"', aliases: [] },
  { id: 'c-msu2', inn: '7728168971', name: 'ООО "МСУ-15"', aliases: [] },
  { id: 'c-petrov1', inn: '', name: 'ИП Петров А.А.', aliases: [] },
  { id: 'c-petrov2', inn: '', name: 'ИП Петров А. А.', aliases: [] },
  { id: 'c-alliance', inn: ALLIANCE_INN, name: 'ООО «АЛЬЯНС»', aliases: [] },
];

function contractor(raw: string, base = raw, inn: string | null = null): OneCContractor {
  return { raw, base, inn, rowNos: [], projects: [] };
}

let rowNo = 1;
function row(
  raw: string,
  objectText: string,
  rd: number,
  rk: number,
  td: number,
  tk: number,
): ContractorSiteRow {
  rowNo++;
  return {
    rowNo,
    raw,
    objectText,
    realizationDocs: rd,
    realizationKop: rk,
    tollingDocs: td,
    tollingKop: tk,
  };
}

const state0: ContractorSitesState = { cc: CC, sites: SITES, links: [] };

describe('kindOf и kopToSum', () => {
  it('вид по числу документов', () => {
    expect(kindOf(3, 0)).toBe('realization');
    expect(kindOf(0, 2)).toBe('tolling_act');
    expect(kindOf(78, 1)).toBe('realization_tolling');
  });
  it('копейки → строка с двумя знаками без float', () => {
    expect(kopToSum(0)).toBe('0.00');
    expect(kopToSum(5)).toBe('0.05');
    expect(kopToSum(12345)).toBe('123.45');
    expect(kopToSum(7947045157)).toBe('79470451.57');
  });
});

describe('resolveObjectSite', () => {
  it('точные коды правилами договоров', () => {
    expect(
      resolveObjectSite('ФРИДРИХА ЭНГЕЛЬСА УЛ., З. У. 56/1, ЖК "ДОМ 56"', CODES),
    ).toMatchObject({
      code: 'Д56',
    });
    expect(
      resolveObjectSite('АВТОЗАВОДСКАЯ УЛ., ВЛ. 23/2, ЖК «ЗИЛАРТ», ЛОТЫ 18, 19, 27', CODES),
    ).toMatchObject({ code: 'ЗИЛ18' });
  });

  it('локальное правило: Метрополия «ВЛ. 32, ЖК …, К. 3» → МЕ3.0, но не «ВЛ. 32/5»', () => {
    expect(resolveObjectSite('ВОЛГОГРАДСКИЙ ПР-Т, ВЛ. 32, ЖК "МЕТРОПОЛИЯ", К. 3', CODES)).toEqual({
      code: 'МЕ3.0',
      rule: 'local.metro3.vl32k3',
    });
    expect(
      resolveObjectSite('ВОЛГОГРАДСКИЙ ПР-Т, ВЛ. 32/5, ЖК "МЕТРОПОЛИЯ", К. 3', CODES).code,
    ).not.toBe('МЕ3.0');
  });

  it('реновация, группа, пусто, кода нет на портале — объект не определён', () => {
    expect(
      resolveObjectSite('ФРИДРИХА ЭНГЕЛЬСА УЛ., З. У. 56/1, КОРПУС РЕНОВАЦИИ', CODES).code,
    ).toBeNull();
    expect(resolveObjectSite('ТАГИЛЬСКАЯ УЛ., ВЛ. 4, ЭТАП 5, участок 3', CODES)).toEqual({
      code: null,
      reason: 'несколько объектов: СИП / ТГЛ',
    });
    expect(resolveObjectSite('', CODES)).toEqual({ code: null, reason: 'пустой объект' });
    expect(
      resolveObjectSite('ВОЛГОГРАДСКИЙ ПР-Т, ВЛ. 32/5, ЖК "МЕТРОПОЛИЯ", ОЧ. 2, ЭТАП 1.2', CODES),
    ).toEqual({ code: null, reason: 'объекта МЕ1.2 нет на портале' });
  });
});

describe('buildFileTarget', () => {
  const contractors = [
    contractor('ФОРТЭКС ООО'),
    contractor('Сатаневский Никита Михайлович'),
    contractor('МСУ-15 ООО'),
    contractor('Петров Андрей Алексеевич'),
    contractor('АЛЬЯНС ООО (7716967786)', 'АЛЬЯНС ООО', ALLIANCE_INN),
    contractor('НЕИЗВЕСТНЫЙ ООО'),
  ];
  const rows = [
    row('ФОРТЭКС ООО', 'ФРИДРИХА ЭНГЕЛЬСА УЛ., З. У. 56/1, ЖК "ДОМ 56"', 51, 10, 8, 20),
    // Вторая строка того же объекта: склейка в копейках (0.10 + 0.20 = 0.30).
    row('ФОРТЭКС ООО', 'ФРИДРИХА ЭНГЕЛЬСА УЛ., ДОМ 56', 0, 0, 1, 10),
    row('ФОРТЭКС ООО', 'ФРИДРИХА ЭНГЕЛЬСА УЛ., З. У. 56/1, КОРПУС РЕНОВАЦИИ', 0, 0, 1, 100),
    row(
      'Сатаневский Никита Михайлович',
      'АВТОЗАВОДСКАЯ УЛ., ВЛ. 23/2, ЖК «ЗИЛАРТ», ЛОТЫ 18',
      0,
      0,
      2,
      500,
    ),
    row('МСУ-15 ООО', 'АВТОЗАВОДСКАЯ УЛ., ВЛ. 23/2, ЖК «ЗИЛАРТ», ЛОТЫ 18', 6, 100, 7, 100),
    row(
      'Петров Андрей Алексеевич',
      'ВОЛГОГРАДСКИЙ ПР-Т, ВЛ. 32, ЖК "МЕТРОПОЛИЯ", К. 3',
      1,
      100,
      0,
      0,
    ),
    row(
      'АЛЬЯНС ООО (7716967786)',
      'ВОЛГОГРАДСКИЙ ПР-Т, ВЛ. 32, ЖК "МЕТРОПОЛИЯ", К. 3',
      9,
      535722083,
      0,
      0,
    ),
    row('АЛЬЯНС ООО (7716967786)', 'ТАГИЛЬСКАЯ УЛ., ВЛ. 4, ЭТАП 5, участок 3', 0, 0, 1, 100),
    row('НЕИЗВЕСТНЫЙ ООО', 'ФРИДРИХА ЭНГЕЛЬСА УЛ., З. У. 56/1, ЖК "ДОМ 56"', 1, 100, 0, 0),
  ];
  const t = buildFileTarget(rows, contractors, state0);

  it('подрядчики: имя без формы, ИНН из скобок, единственный кандидат по инициалам', () => {
    expect(Object.fromEntries(t.contractorMatches.map((m) => [m.raw, [m.ccId, m.via]]))).toEqual({
      'ФОРТЭКС ООО': ['c-fortex', 'company_key'],
      'Сатаневский Никита Михайлович': ['c-satan', 'initials'],
      'АЛЬЯНС ООО (7716967786)': ['c-alliance', 'inn'],
    });
  });

  it('неоднозначные, несколько по инициалам и ненайденные — в отчёт, связей нет', () => {
    expect(t.unresolvedContractors.map((u) => [u.raw, u.candidateIds.length]).sort()).toEqual([
      ['МСУ-15 ООО', 2],
      ['НЕИЗВЕСТНЫЙ ООО', 0],
      ['Петров Андрей Алексеевич', 2],
    ]);
    expect(
      t.entries.some((e) => ['c-msu1', 'c-msu2', 'c-petrov1', 'c-petrov2'].includes(e.ccId)),
    ).toBe(false);
  });

  it('склейка двух строк в одну пару, вид по сумме документов', () => {
    const d56 = t.entries.find((e) => e.ccId === 'c-fortex' && e.siteId === 's-d56');
    expect(d56?.layer).toEqual({
      kind: 'realization_tolling',
      realizationDocs: 51,
      realizationSum: '0.10',
      tollingDocs: 9,
      tollingSum: '0.30',
      objects: ['ФРИДРИХА ЭНГЕЛЬСА УЛ., ДОМ 56', 'ФРИДРИХА ЭНГЕЛЬСА УЛ., З. У. 56/1, ЖК "ДОМ 56"'],
    });
    expect(d56?.rowNos).toHaveLength(2);
    expect(t.entries.map((e) => [e.ccId, e.siteId, e.layer.kind])).toEqual(
      expect.arrayContaining([
        ['c-satan', 's-zil18', 'tolling_act'],
        ['c-alliance', 's-me3', 'realization'],
      ]),
    );
    expect(t.entries).toHaveLength(3);
  });

  it('объекты без кода портала — в отчёт со строкой и причиной', () => {
    expect(t.unresolvedObjects.map((u) => [u.raw, u.reason])).toEqual([
      ['ФОРТЭКС ООО', 'корпус реновации — отдельный проект, объекта на портале нет'],
      ['АЛЬЯНС ООО (7716967786)', 'несколько объектов: СИП / ТГЛ'],
    ]);
  });
});

function layer(kind: OnecLayer['kind'], rd: number, td: number, sum = '1.00'): OnecLayer {
  return {
    kind,
    realizationDocs: rd,
    realizationSum: rd > 0 ? sum : '0.00',
    tollingDocs: td,
    tollingSum: td > 0 ? sum : '0.00',
    objects: ['ОБЪЕКТ'],
  };
}

function entry(
  ccId: string,
  siteId: string,
  l: OnecLayer,
  loadedAt: Date | null = null,
): TargetEntry {
  return { ccId, siteId, layer: l, loadedAt, rowNos: [] };
}

function link(
  ccId: string,
  siteId: string,
  onec: OnecLayer | null,
  manualKind: CurrentLink['manualKind'] = null,
): CurrentLink {
  return {
    ccId,
    siteId,
    onec,
    onecLoadedAt: onec ? new Date('2026-11-25T10:00:00Z') : null,
    manualKind,
  };
}

describe('planLayer', () => {
  it('пустая таблица — только вставки; повтор по записанному слою пуст', () => {
    const entries = [
      entry('c-fortex', 's-d56', layer('realization', 3, 0)),
      entry('c-satan', 's-zil18', layer('tolling_act', 0, 2)),
    ];
    const p = planLayer(state0, entries);
    expect(p.counts).toEqual({ insert: 2, update: 0, clear: 0, delete: 0 });
    const written: ContractorSitesState = {
      ...state0,
      links: entries.map((e) => link(e.ccId, e.siteId, e.layer)),
    };
    const again = planLayer(written, entries);
    expect(again.ops).toEqual([]);
    expect(again.unchanged).toBe(2);
  });

  it('изменились данные — update; ручная строка без 1С — update (ручной вид не трогается)', () => {
    const state: ContractorSitesState = {
      ...state0,
      links: [
        link('c-fortex', 's-d56', layer('realization', 3, 0)),
        link('c-satan', 's-zil18', null, 'realization'),
      ],
    };
    const p = planLayer(state, [
      entry('c-fortex', 's-d56', layer('realization', 4, 0)),
      entry('c-satan', 's-zil18', layer('tolling_act', 0, 2)),
    ]);
    expect(p.ops.map((o) => [o.type, o.ccId])).toEqual([
      ['update', 'c-fortex'],
      ['update', 'c-satan'],
    ]);
  });

  it('пары нет в файле: с ручным видом — clear, без ручного или скрытая — delete', () => {
    const state: ContractorSitesState = {
      ...state0,
      links: [
        link('c-fortex', 's-d56', layer('realization', 3, 0), 'tolling_act'),
        link('c-fortex', 's-zil18', layer('realization', 3, 0)),
        link('c-satan', 's-zil18', layer('tolling_act', 0, 1), 'none'),
        // Ручная строка без 1С импорт не касается вовсе.
        link('c-alliance', 's-me3', null, 'realization'),
      ],
    };
    const p = planLayer(state, []);
    expect(p.ops.map((o) => [o.type, o.ccId, o.siteId])).toEqual([
      ['clear', 'c-fortex', 's-d56'],
      ['delete', 'c-fortex', 's-zil18'],
      ['delete', 'c-satan', 's-zil18'],
    ]);
  });

  it('время загрузки не входит в отпечаток; другой план — другой отпечаток', () => {
    const a = planLayer(state0, [
      entry('c-fortex', 's-d56', layer('realization', 3, 0), new Date(1)),
    ]);
    const b = planLayer(state0, [
      entry('c-fortex', 's-d56', layer('realization', 3, 0), new Date(2)),
    ]);
    const c = planLayer(state0, [entry('c-fortex', 's-d56', layer('realization', 3, 0, '2.00'))]);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
  });

  it('откат: пары удалённого контрагента или объекта пропускаются', () => {
    const p = planLayer(state0, [
      entry('c-gone', 's-d56', layer('realization', 1, 0)),
      entry('c-fortex', 's-gone', layer('realization', 1, 0)),
    ]);
    expect(p.ops).toEqual([]);
    expect(p.skipped.map((s) => s.reason)).toEqual([
      'контрагента больше нет',
      'объекта больше нет',
    ]);
  });
});

describe('снимок и откат', () => {
  it('снимок прежнего слоя как цель даёт пустой план по тому же состоянию', () => {
    const state: ContractorSitesState = {
      ...state0,
      links: [
        link('c-fortex', 's-d56', layer('realization_tolling', 3, 1)),
        link('c-satan', 's-zil18', null, 'realization'),
      ],
    };
    const snap = buildSnapshot(state, 'f'.repeat(64), new Date('2026-11-25T12:00:00Z'));
    expect(snap.layer).toHaveLength(1);
    const target = snapshotTarget(JSON.parse(JSON.stringify(snap)));
    expect(planLayer(state, target.entries).ops).toEqual([]);
    expect(target.entries[0]!.loadedAt?.toISOString()).toBe('2026-11-25T10:00:00.000Z');
  });

  it('чужой файл вместо снимка — ошибка', () => {
    expect(() => snapshotTarget({ version: 1 } as never)).toThrow(/не снимок/);
  });
});
